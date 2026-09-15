// Service worker: connects OUT to the localhost MCP bridge, relays commands
// to the in-page content engine. No CDP, no chrome.debugger anywhere.

// Static import (reliable in MV3 module SW). No top-level await, no dynamic
// import. generated-secret.js is produced by scripts/sync-ext-secret.mjs.
import { BRIDGE_SECRET, BRIDGE_PORT } from "./generated-secret.js";

console.log("[agent-bridge] service worker started; port", BRIDGE_PORT);
const cfg = { BRIDGE_SECRET, BRIDGE_PORT };
let ws = null;
let backoff = 1000;

function ensureConnected() {
  // MV3 SWs suspend after ~30s; setTimeout retries die with them. Any wake
  // event (alarm/startup/navigation) calls this to (re)establish the socket.
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  connect();
}

function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  if (!cfg.BRIDGE_SECRET) {
    console.warn("[agent-bridge] no secret — run scripts/sync-ext-secret.mjs + reload");
    setTimeout(connect, 5000);
    return;
  }
  console.log("[agent-bridge] connecting ws://127.0.0.1:" + cfg.BRIDGE_PORT);
  ws = new WebSocket(`ws://127.0.0.1:${cfg.BRIDGE_PORT}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "auth", secret: cfg.BRIDGE_SECRET }));
  };

  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "auth_ok") {
      backoff = 1000;
      console.log("[agent-bridge] connected");
      return;
    }
    // Server heartbeat. Nothing to do with the payload — simply RECEIVING it
    // resets this worker's ~30s idle timer, which is what keeps the bridge up
    // between tool calls instead of dying and waiting on the alarm backstop.
    if (msg.type === "keepalive") return;
    if (!msg.id || !msg.method) return;
    try {
      const result = await dispatch(msg.method, msg.params || {});
      ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (e) {
      ws.send(JSON.stringify({ id: msg.id, ok: false, error: String(e && e.message || e) }));
    }
  };

  ws.onclose = () => {
    ws = null;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 4000); // fast retry so it reconnects within a smoke run
  };
  ws.onerror = () => ws && ws.close();
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("no active tab");
  return tab;
}

// Ring buffer of recent top-frame navigations. Redirect-based flows (OAuth
// consent, SSO hand-off, payment return, magic links) hand the interesting
// value to the browser as a URL the agent never gets to "see" — it may bounce
// onward before any observe() runs. Recording every commit lets an agent ask
// "did we pass through a URL matching X, and what were its params?" after the
// fact, instead of racing the redirect chain.
const NAV_LOG = [];
const NAV_LOG_MAX = 50;
function recordNav(url) {
  NAV_LOG.push({ url, ts: Date.now() });
  if (NAV_LOG.length > NAV_LOG_MAX) NAV_LOG.shift();
}

function matchNav(patternSource, sinceTs) {
  const re = new RegExp(patternSource);
  for (let i = NAV_LOG.length - 1; i >= 0; i--) {
    const n = NAV_LOG[i];
    if (n.ts < sinceTs) break;
    if (re.test(n.url)) {
      let params = {};
      try {
        params = Object.fromEntries(new URL(n.url).searchParams.entries());
      } catch {}
      return { url: n.url, params, ts: n.ts };
    }
  }
  return null;
}

// Wait for a navigation whose URL matches `urlPattern`. Checks history first
// (the redirect may already have happened), then polls until the deadline.
async function waitForNavigation(params = {}) {
  const pattern = params.urlPattern;
  if (typeof pattern !== "string" || !pattern) throw new Error("waitForNavigation: urlPattern required");
  const timeoutMs = Math.min(params.timeoutMs ?? 20000, 25000);
  // Default: look back briefly so a redirect that landed while the caller was
  // still in transit isn't missed.
  const sinceTs = params.sinceTs ?? Date.now() - 5000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = matchNav(pattern, sinceTs);
    if (hit) return { matched: true, ...hit };
    if (Date.now() >= deadline) {
      return {
        matched: false,
        urlPattern: pattern,
        waitedMs: timeoutMs,
        recentUrls: NAV_LOG.slice(-10).map((n) => n.url),
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Read-only engine methods: re-running one after a dropped port changes nothing,
// so they're safe to retry. Anything absent from this set may have side effects.
const RETRY_SAFE = new Set(["ping", "observe", "locate", "waitForStable", "clearMarks"]);

async function callEngine(tabId, method, params) {
  // Target the TOP frame only — broadcasting lets cross-origin tracking
  // iframes answer first. The engine walks same-origin child frames itself.
  try {
    return await chrome.tabs.sendMessage(tabId, { method, params }, { frameId: 0 });
  } catch (e) {
    const msg = String(e.message || e);
    // The message never reached a content script — nothing ran, so retrying
    // is always safe (tab predates the extension, or was orphaned by a reload).
    const neverDelivered = /Receiving end does not exist|Could not establish connection/.test(msg);
    // The port died mid-call because the document was torn down or pushed into
    // the back/forward cache. Whatever we sent MAY already have run.
    const portClosed = /back\/forward cache|message channel is closed/.test(msg);
    if (!neverDelivered && !portClosed) throw e;

    // A closed port on a state-changing method is the signature of a SUCCESSFUL
    // action that navigated away — the click landed, the page unloaded, and the
    // reply had nowhere to go. Re-running it would double-submit. Report it as
    // its own condition and let the caller interpret it.
    if (portClosed && !RETRY_SAFE.has(method)) {
      const err = new Error(
        "PORT_CLOSED_AFTER_ACTION: the page navigated away while the action was in flight",
      );
      err.code = "PORT_CLOSED_AFTER_ACTION";
      throw err;
    }

    // Re-inject and retry with a grace period. The usual cause is a navigation
    // still in flight: the old document is gone and the new one hasn't run its
    // content script yet, so a single immediate retry lands in the same gap.
    console.log("[agent-bridge] engine unreachable in tab", tabId, "— injecting");
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ["src/content/engine.js"],
        });
      } catch (injErr) {
        lastErr = injErr; // page may be mid-commit; fall through and retry
      }
      try {
        return await chrome.tabs.sendMessage(tabId, { method, params }, { frameId: 0 });
      } catch (retryErr) {
        lastErr = retryErr;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw lastErr;
  }
}

async function captureViewport(windowId) {
  return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

async function dispatch(method, params) {
  // engine.navigate runs from the SW (chrome.tabs API) so it works regardless
  // of whether a content script can be injected into the current tab. Forces
  // the URL into the stealth Chrome: updates the active tab if there is one,
  // otherwise opens a new tab. No host gate on the *current* page.
  if (method === "engine.navigate") {
    if (params.url) {
      const tabs = await chrome.tabs.query({ lastFocusedWindow: true, active: true });
      if (tabs[0]) {
        await chrome.tabs.update(tabs[0].id, { url: params.url, active: true });
        return { navigating: true, to: params.url, tabId: tabs[0].id, mode: "updated_active" };
      }
      const anyWindow = (await chrome.tabs.query({ active: true }))[0];
      if (anyWindow) {
        await chrome.tabs.update(anyWindow.id, { url: params.url, active: true });
        await chrome.windows.update(anyWindow.windowId, { focused: true }).catch(() => {});
        return { navigating: true, to: params.url, tabId: anyWindow.id, mode: "updated_other_window" };
      }
      const created = await chrome.tabs.create({ url: params.url, active: true });
      return { navigating: true, to: params.url, tabId: created.id, mode: "created_tab" };
    }
    const tabForNav = (await chrome.tabs.query({ lastFocusedWindow: true, active: true }))[0];
    if (!tabForNav) throw new Error("no tab for back/forward/reload");
    if (params.action === "back") await chrome.tabs.goBack(tabForNav.id);
    else if (params.action === "forward") await chrome.tabs.goForward(tabForNav.id);
    else if (params.action === "reload") await chrome.tabs.reload(tabForNav.id);
    else throw new Error("navigate: need url or back/forward/reload");
    return { navigating: true, to: params.action, tabId: tabForNav.id };
  }
  const tab = await activeTab();
  if (method === "engine.ping") {
    const pong = await callEngine(tab.id, "ping", params).catch((e) => ({
      error: String(e.message || e),
    }));
    // `status` ("loading" | "complete") is the honest signal that a click
    // already started something — a pending navigation hasn't changed the URL
    // yet, so without it a successful click looks identical to a dead one.
    return {
      sw: "ok",
      tab: { id: tab.id, url: tab.url, title: tab.title, status: tab.status },
      engine: pong,
    };
  }
  if (method === "engine.observe") {
    const snap = await callEngine(tab.id, "observe", params);
    if (snap && snap.needsScreenshot) {
      try {
        snap.screenshot = await captureViewport(tab.windowId);
      } catch (e) {
        snap.screenshotError = String(e.message || e);
      }
      await callEngine(tab.id, "clearMarks", {}).catch(() => {});
      delete snap.needsScreenshot;
    }
    return snap;
  }
  if (method === "engine.locate") return await callEngine(tab.id, "locate", params);
  if (method === "engine.act") return await callEngine(tab.id, "act", params);
  if (method === "engine.robustClick") return await robustClick(tab.id, params);
  if (method === "engine.waitForNavigation") return await waitForNavigation(params);
  if (method === "engine.navHistory") return { navigations: NAV_LOG.slice(-25) };
  if (method === "engine.waitForStable") return await callEngine(tab.id, "waitForStable", params);
  if (method === "engine.screenshot") {
    return { screenshot: await captureViewport(tab.windowId), url: tab.url };
  }
  throw new Error(`unknown method: ${method}`);
}

// Robust auto-click that runs in the PAGE's own JS world via chrome.scripting
// (NOT CDP, NOT debugger). For OAuth consent buttons where our isolated-world
// dispatchEvent doesn't drive the React handler, this tries multiple
// strategies in the same context the page uses for itself. Verified by URL
// navigation, not heuristic.
async function robustClick(tabId, params = {}) {
  const ref = params.ref;
  const navTimeoutMs = params.navTimeoutMs ?? 6000;
  const tabBefore = await chrome.tabs.get(tabId);
  const beforeUrl = tabBefore.url ?? "";

  // Programmatic focus + activation: the SAME things a real user click does
  // before reaching the button. Without these the page's React handlers can
  // run but focus/visibility-gated effects (analytics, fetch progress, nav)
  // stay deprioritized — which is what made auto-click "need a user click first".
  try {
    await chrome.tabs.update(tabId, { active: true });
    if (typeof tabBefore.windowId === "number") {
      await chrome.windows.update(tabBefore.windowId, { focused: true, drawAttention: false });
    }
  } catch {}
  // Give the OS focus change a tick to propagate before MAIN-world runs.
  await new Promise((r) => setTimeout(r, 100));

  // Try every frame — the data-ab-ref may live in a same-origin iframe.
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: async (refValue, hydrationTimeoutMs) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const el = document.querySelector(`[data-ab-ref="${refValue}"]`);
      if (!el) return { error: "ref not found in this frame", frameUrl: location.href };
      const tried = [];
      const reactPropsKey = () => Object.keys(el).find((k) => k.startsWith("__reactProps$"));
      const reactPropsOf = () => {
        const k = reactPropsKey();
        return k ? el[k] : null;
      };

      // 0a. Force "this tab is focused & visible" at the JS level: spoof
      //     document.hasFocus()/visibilityState and fire matching events. This
      //     unblocks focus-gated React effects (analytics, fetch progress,
      //     navigation) that otherwise pause when the window's in the bg.
      try {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
        document.hasFocus = () => true;
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
        tried.push("forceFocus");
      } catch (e) { tried.push("forceFocus_err:" + (e.message || e)); }

      // 0. Wait for React hydration: poll until the element either has a
      //    React onClick handler attached, OR sits inside a <form>, OR a
      //    hydration deadline elapses. This is the ROOT cause of the earlier
      //    intermittency — we used to click before hydration listeners existed.
      const tHy = Date.now();
      let hydrated = false;
      while (Date.now() - tHy < hydrationTimeoutMs) {
        const props = reactPropsOf();
        const onClickAttached = props && typeof props.onClick === "function";
        const formExists = !!el.closest("form");
        if (onClickAttached || formExists) { hydrated = true; break; }
        await sleep(120);
      }
      tried.push(`hydrated=${hydrated}(${Date.now() - tHy}ms)`);

      // 1. requestSubmit on enclosing form (OAuth consent is usually a form).
      try {
        const form = el.closest("form");
        if (form && typeof form.requestSubmit === "function") {
          form.requestSubmit(el);
          tried.push("requestSubmit");
        } else {
          tried.push("no_form");
        }
      } catch (e) { tried.push("requestSubmit_err:" + (e.message || e)); }

      // 2. Authentic pointer→mouse→click sequence (more realistic than .click()
      //    alone; React 18+ delegated listeners look at full bubble path).
      try {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const opts = { bubbles: true, cancelable: true, composed: true,
                       clientX: cx, clientY: cy, button: 0, view: window };
        el.dispatchEvent(new PointerEvent("pointerover", opts));
        el.dispatchEvent(new MouseEvent("mouseover", opts));
        el.dispatchEvent(new PointerEvent("pointermove", opts));
        el.dispatchEvent(new MouseEvent("mousemove", opts));
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new MouseEvent("mousedown", opts));
        if (typeof el.focus === "function") el.focus();
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        el.dispatchEvent(new MouseEvent("mouseup", opts));
        el.dispatchEvent(new MouseEvent("click", opts));
        tried.push("eventSeq");
      } catch (e) { tried.push("eventSeq_err:" + (e.message || e)); }

      // 3. Native .click() — page-world (NOT cross-realm; isTrusted still false
      //    but realm is the page's, so handlers see consistent context).
      try { el.click(); tried.push("click"); } catch (e) { tried.push("click_err:" + (e.message || e)); }

      // 4. React fiber: call the bound onClick handler directly.
      try {
        const props = reactPropsOf();
        if (props && typeof props.onClick === "function") {
          const fake = {
            preventDefault: () => {}, stopPropagation: () => {},
            target: el, currentTarget: el, isTrusted: false,
            type: "click", nativeEvent: new MouseEvent("click"),
          };
          props.onClick(fake);
          tried.push("reactOnClick");
        } else {
          tried.push("no_reactOnClick");
        }
      } catch (e) { tried.push("react_err:" + (e.message || e)); }

      // 5. React 19 server-action / formAction fallback: if the button has a
      //    formAction prop, post the form to it via fetch.
      try {
        const props = reactPropsOf();
        const fa = el.getAttribute("formaction") || (props && props.formAction);
        const form = el.closest("form");
        if (typeof fa === "string" && form) {
          const fd = new FormData(form);
          // include the button name/value so server knows which submitter.
          if (el.name) fd.append(el.name, el.value || "");
          // Don't await — fire-and-forget, navigation will be detected by SW.
          fetch(fa, { method: form.method || "POST", body: fd, credentials: "include" }).catch(() => {});
          tried.push("formActionFetch");
        }
      } catch (e) { tried.push("formAction_err:" + (e.message || e)); }

      return {
        tried, hydrated, frameUrl: location.href,
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        name: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 60),
        diag: {
          tag: el.tagName, type: el.type || null,
          inForm: !!el.closest("form"),
          hasOnClick: !!(reactPropsOf() && reactPropsOf().onClick),
          hasFormAction: !!(el.getAttribute("formaction") || (reactPropsOf() && reactPropsOf().formAction)),
        },
      };
    },
    args: [ref, params.hydrationTimeoutMs ?? 4000],
  });

  // Aggregate per-frame results. NOTE executeScript wraps each return value
  // in InjectionResult — `tried` lives at r.result.tried (NOT r.tried).
  const allFrames = results.map((r) => r?.result).filter(Boolean);
  const hit = allFrames.find((f) => Array.isArray(f.tried));

  // Verify by navigation away from the consent URL.
  const t0 = Date.now();
  while (Date.now() - t0 < navTimeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
    const tab = await chrome.tabs.get(tabId);
    if ((tab.url ?? "") !== beforeUrl) {
      return { acted: true, navigated: true, from: beforeUrl, to: tab.url,
               strategies: hit?.tried, foundInFrame: hit?.frameUrl, diag: hit?.diag,
               frames: allFrames.length };
    }
  }
  return { acted: true, navigated: false, beforeUrl,
           strategies: hit?.tried, foundInFrame: hit?.frameUrl, diag: hit?.diag,
           perFrame: allFrames };
}

// Stealthy native-dialog auto-handler: a MAIN-world page script (NOT CDP, NOT
// debugger) that suppresses alert/confirm/prompt/beforeunload hangs and reports
// them to the isolated content engine via a shared-DOM CustomEvent.
function dialogTamer() {
  if (window.__abTamed) return;
  window.__abTamed = true;
  const report = (kind, message) =>
    window.dispatchEvent(
      new CustomEvent("ab-dialog", { detail: { kind, message: String(message ?? ""), ts: Date.now() } }),
    );
  window.alert = (m) => report("alert", m);
  window.confirm = (m) => (report("confirm", m), true);
  window.prompt = (m, d) => (report("prompt", m), d ?? "");
  window.addEventListener("beforeunload", (e) => {
    e.stopImmediatePropagation();
    delete e.returnValue;
  }, true);
}

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  recordNav(d.url); // so redirect-based flows can be inspected after the fact
  ensureConnected(); // navigation wakes the SW — opportunistically (re)connect
  chrome.scripting
    .executeScript({ target: { tabId: d.tabId }, world: "MAIN", func: dialogTamer })
    .catch(() => {});
});

// Backstop: chrome.alarms survives SW suspension and wakes it to reconnect.
chrome.alarms.create("ab-reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "ab-reconnect") ensureConnected();
});
chrome.runtime.onStartup.addListener(ensureConnected);
chrome.runtime.onInstalled.addListener(ensureConnected);

ensureConnected();
