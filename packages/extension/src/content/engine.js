// Content engine — DOM-only synthetic accessibility/semantic perception.
// NO CDP, NO chrome.debugger. Stealth-first.
//
// Provides: ping, observe(semantic|read|marks), locate({role,name}), screenshot
// hint. Stable refs survive an observe->act cycle within one snapshot
// generation; acting on a stale ref must surface STALE_SNAPSHOT (task #6).

(() => {
  // Idempotent: re-injection (self-heal path) must not register a 2nd listener.
  if (window.__ab_engine_loaded) return;
  window.__ab_engine_loaded = true;
  const AB = (window.__AB = window.__AB || { gen: 0, refs: new Map() });
  const REDACT_SEL = [
    "input[type=password]",
    "input[autocomplete*=cc-]",
    "input[autocomplete=one-time-code]",
    "input[name*=otp]",
    "input[name*=pass]",
  ];

  const TAG_ROLE = {
    A: (el) => (el.hasAttribute("href") ? "link" : "generic"),
    BUTTON: () => "button",
    INPUT: (el) => {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return (
        {
          checkbox: "checkbox",
          radio: "radio",
          submit: "button",
          button: "button",
          range: "slider",
          search: "searchbox",
        }[t] || "textbox"
      );
    },
    SELECT: () => "combobox",
    TEXTAREA: () => "textbox",
    NAV: () => "navigation",
    MAIN: () => "main",
    HEADER: () => "banner",
    FOOTER: () => "contentinfo",
    FORM: () => "form",
    H1: () => "heading",
    H2: () => "heading",
    H3: () => "heading",
    H4: () => "heading",
    H5: () => "heading",
    H6: () => "heading",
    IMG: () => "img",
  };

  const clip = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);

  // Native dialogs auto-handled by the MAIN-world tamer are reported here.
  AB.dialogs = AB.dialogs || [];
  window.addEventListener("ab-dialog", (e) => {
    AB.dialogs.push(e.detail);
    if (AB.dialogs.length > 20) AB.dialogs.shift();
  });
  const recentDialogs = () => AB.dialogs.slice(-5);

  function role(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const f = TAG_ROLE[el.tagName];
    return f ? f(el) : null;
  }

  function accName(el) {
    const byId = (attr) =>
      (el.getAttribute(attr) || "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ");
    let n =
      byId("aria-labelledby") ||
      el.getAttribute("aria-label") ||
      "";
    if (!n && el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) n = lbl.textContent || "";
    }
    if (!n) n = el.closest("label")?.textContent || "";
    if (!n)
      n =
        el.getAttribute("placeholder") ||
        el.getAttribute("alt") ||
        el.getAttribute("title") ||
        "";
    if (!n) {
      const r = role(el);
      if (r === "button" || r === "link" || /^h[1-6]$/i.test(el.tagName))
        n = el.textContent || "";
    }
    return clip(n, 100);
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  }

  const inViewport = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };

  function isRedacted(el) {
    return REDACT_SEL.some((s) => {
      try {
        return el.matches(s);
      } catch {
        return false;
      }
    });
  }

  function state(el) {
    const s = {};
    if (el.disabled || el.getAttribute("aria-disabled") === "true") s.disabled = true;
    if (el.required) s.required = true;
    const ac = el.getAttribute("aria-checked");
    if (el.type === "checkbox" || el.type === "radio") s.checked = !!el.checked;
    else if (ac) s.checked = ac === "true";
    const ae = el.getAttribute("aria-expanded");
    if (ae) s.expanded = ae === "true";
    if (el.getAttribute("aria-selected") === "true") s.selected = true;
    if (/^h([1-6])$/i.test(el.tagName)) s.level = +el.tagName[1];
    if (el.getAttribute("aria-invalid") === "true") s.invalid = true;
    if ("value" in el && el.value != null && el.value !== "") {
      s.value = isRedacted(el) ? "[redacted]" : clip(String(el.value), 60);
    }
    return s;
  }

  const INTERACTIVE = new Set([
    "link",
    "button",
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "combobox",
    "slider",
    "menuitem",
    "tab",
    "switch",
    "option",
  ]);
  const LANDMARK = new Set([
    "navigation",
    "main",
    "banner",
    "contentinfo",
    "form",
    "search",
    "region",
    "heading",
  ]);

  // Walk doc + open shadow roots + same-origin iframes. Cross-origin frames
  // are emitted as boundary nodes (documented capability limit, no CDP).
  function* walk(root, depth) {
    const tw = (root.ownerDocument || root).createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT,
    );
    let el = tw.nextNode();
    while (el) {
      yield { el, depth };
      if (el.shadowRoot) yield* walk(el.shadowRoot, depth + 1);
      if (el.tagName === "IFRAME") {
        let doc = null;
        try {
          doc = el.contentDocument;
        } catch {
          doc = null;
        }
        if (doc && doc.body) yield* walk(doc.body, depth + 1);
        else yield { el, depth, crossOrigin: true };
      }
      el = tw.nextNode();
    }
  }

  function buildTree(opts) {
    const maxNodes = opts.maxNodes || 220;
    AB.gen = Date.now();
    AB.refs = new Map();
    document
      .querySelectorAll("[data-ab-ref]")
      .forEach((n) => n.removeAttribute("data-ab-ref"));

    const out = [];
    let ref = 0;
    let truncated = false;
    for (const { el, depth, crossOrigin } of walk(document.body, 0)) {
      if (out.length >= maxNodes) {
        truncated = true;
        break;
      }
      if (crossOrigin) {
        out.push({ depth, role: "iframe", name: clip(el.src, 60), crossOrigin: true });
        continue;
      }
      const r = role(el);
      if (!r || r === "generic") continue;
      if (!visible(el)) continue;
      const name = accName(el);
      const interactive = INTERACTIVE.has(r);
      const landmark = LANDMARK.has(r);
      if (!interactive && !landmark) continue;
      if (!interactive && !name) continue;

      ref += 1;
      el.setAttribute("data-ab-ref", String(ref));
      AB.refs.set(ref, el);
      const st = state(el);
      out.push({
        ref,
        depth,
        role: r,
        name,
        ...(interactive ? { interactive: true } : {}),
        ...(inViewport(el) ? {} : { offscreen: true }),
        ...(Object.keys(st).length ? { state: st } : {}),
      });
    }
    return {
      url: location.href,
      title: document.title,
      snapshotGeneration: AB.gen,
      truncated,
      counts: { nodes: out.length, interactive: out.filter((n) => n.interactive).length },
      ...(recentDialogs().length ? { dialogs: recentDialogs() } : {}),
      tree: out,
    };
  }

  function drawMarks() {
    document.getElementById("__ab_marks")?.remove();
    const layer = document.createElement("div");
    layer.id = "__ab_marks";
    layer.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    for (const [r, el] of AB.refs) {
      const b = el.getBoundingClientRect();
      if (b.width <= 0 || b.bottom < 0 || b.top > innerHeight) continue;
      const tag = document.createElement("div");
      tag.textContent = String(r);
      tag.style.cssText = `position:absolute;left:${Math.max(0, b.left)}px;top:${Math.max(
        0,
        b.top,
      )}px;background:#e11;color:#fff;font:11px/1.4 monospace;padding:0 3px;border-radius:2px;`;
      const box = document.createElement("div");
      box.style.cssText = `position:absolute;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;outline:1.5px solid #e11;`;
      layer.appendChild(box);
      layer.appendChild(tag);
    }
    document.documentElement.appendChild(layer);
  }
  const clearMarks = () => document.getElementById("__ab_marks")?.remove();

  function observe(params = {}) {
    const mode = params.mode || "semantic";
    if (mode === "read") {
      return {
        url: location.href,
        title: document.title,
        text: clip(document.body?.innerText, 8000),
      };
    }
    const snap = buildTree(params);
    if (mode === "marks") {
      drawMarks();
      snap.marksDrawn = true;
      snap.needsScreenshot = true; // SW captures via chrome.tabs.captureVisibleTab
    }
    return snap;
  }

  // Used by the action engine (task #6). Stale refs must be detectable.
  function resolve(ref, gen) {
    if (gen && gen !== AB.gen) {
      const e = new Error("STALE_SNAPSHOT: re-observe before acting");
      e.code = "STALE_SNAPSHOT";
      throw e;
    }
    const el = AB.refs.get(ref);
    if (!el || !el.isConnected) {
      const e = new Error("REF_NOT_FOUND: element gone, re-observe");
      e.code = "REF_NOT_FOUND";
      throw e;
    }
    return el;
  }

  function locate(params = {}) {
    if (!AB.refs.size) buildTree(params);
    const want = (params.name || "").toLowerCase();
    const matches = [];
    for (const [r, el] of AB.refs) {
      if (params.role && role(el) !== params.role) continue;
      if (want && !accName(el).toLowerCase().includes(want)) continue;
      matches.push({ ref: r, role: role(el), name: accName(el) });
    }
    return { snapshotGeneration: AB.gen, matches };
  }

  // ---- action engine (DOM-only, human-like). isTrusted:false is an accepted
  //      tradeoff of the no-CDP stealth posture; sites that gate on it surface
  //      TRUSTED_INPUT_REQUIRED rather than weakening stealth.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (b) => b + Math.random() * b;

  async function settleRect(el, timeout = 2000) {
    const t0 = performance.now();
    let last = null;
    while (performance.now() - t0 < timeout) {
      const r = el.getBoundingClientRect();
      const key = `${r.x | 0},${r.y | 0},${r.width | 0},${r.height | 0}`;
      if (key === last) return;
      last = key;
      await sleep(80);
    }
  }

  async function ensureActionable(el) {
    if (!el.isConnected) {
      const e = new Error("REF_NOT_FOUND: element detached"); e.code = "REF_NOT_FOUND"; throw e;
    }
    el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    await sleep(jitter(120));
    await settleRect(el);
    if (!visible(el)) {
      const e = new Error("NOT_ACTIONABLE: not visible"); e.code = "NOT_ACTIONABLE"; throw e;
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") {
      const e = new Error("NOT_ACTIONABLE: disabled"); e.code = "NOT_ACTIONABLE"; throw e;
    }
    const b = el.getBoundingClientRect();
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    const top = document.elementFromPoint(cx, cy);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      const e = new Error("NOT_ACTIONABLE: occluded by another element");
      e.code = "NOT_ACTIONABLE"; throw e;
    }
    return { cx, cy };
  }

  function fire(el, type, init = {}) {
    const Ev = /^(pointer)/.test(type)
      ? PointerEvent
      : /^(mouse|click|dbl)/.test(type)
        ? MouseEvent
        : /^key/.test(type)
          ? KeyboardEvent
          : Event;
    el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, composed: true, ...init }));
  }

  async function humanClick(el, cx, cy) {
    const at = { clientX: cx, clientY: cy };
    fire(el, "pointerover", at); fire(el, "mouseover", at);
    for (let i = 0; i < 3; i++) {
      fire(el, "mousemove", { clientX: cx + (Math.random() - 0.5) * 4, clientY: cy + (Math.random() - 0.5) * 4 });
      await sleep(jitter(18));
    }
    fire(el, "pointerdown", at); fire(el, "mousedown", at);
    if (typeof el.focus === "function") el.focus();
    await sleep(jitter(55));
    fire(el, "pointerup", at); fire(el, "mouseup", at);
    fire(el, "click", at);
  }

  const nativeSetter = (el) => {
    // Only return a setter for elements that actually have a .value property;
    // returning the input setter for a <div>/<select> -> "Illegal invocation".
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement
        : el instanceof HTMLInputElement
          ? HTMLInputElement
          : null;
    return proto ? Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set : null;
  };

  async function humanType(el, text, replace) {
    el.focus();
    const setter = nativeSetter(el);
    const isCE = el.isContentEditable;

    if (replace) {
      if (setter) {
        setter.call(el, "");
        fire(el, "input", { inputType: "deleteContentBackward" });
      } else if (isCE) {
        // Select-all + delete: rich editors (ProseMirror etc.) track this.
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        fire(el, "beforeinput", { inputType: "deleteContentBackward" });
        document.execCommand("delete", false);
        fire(el, "input", { inputType: "deleteContentBackward" });
      }
    }

    for (const ch of String(text)) {
      fire(el, "keydown", { key: ch });
      fire(el, "beforeinput", { data: ch, inputType: "insertText" });
      if (setter) {
        setter.call(el, (el.value ?? "") + ch);
      } else if (isCE) {
        // execCommand insertText drives the editor's own model + fires input.
        document.execCommand("insertText", false, ch);
      } else {
        el.textContent = (el.textContent ?? "") + ch;
      }
      fire(el, "input", { data: ch, inputType: "insertText" });
      fire(el, "keyup", { key: ch });
      await sleep(jitter(45));
    }
    fire(el, "change");
  }

  async function pressKey(el, key) {
    const t = el || document.activeElement || document.body;
    fire(t, "keydown", { key });
    fire(t, "keyup", { key });
  }

  async function act(p = {}) {
    const el = resolve(p.ref, p.gen); // throws STALE_SNAPSHOT / REF_NOT_FOUND
    const before = { url: location.href, value: "value" in el ? el.value : undefined };
    let mutated = 0;
    const mo = new MutationObserver((recs) => (mutated += recs.length));
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    try {
      const { cx, cy } = await ensureActionable(el);
      switch (p.action) {
        case "click": await humanClick(el, cx, cy); break;
        case "hover": fire(el, "pointerover", { clientX: cx, clientY: cy }); fire(el, "mouseover", {}); break;
        case "focus": el.focus(); break;
        case "type": await humanType(el, p.value ?? "", false); break;
        case "fill": await humanType(el, p.value ?? "", true); break;
        case "clear": await humanType(el, "", true); break;
        case "press": await pressKey(el, p.value ?? "Enter"); break;
        case "check":
        case "uncheck": {
          const want = p.action === "check";
          if (!!el.checked !== want) await humanClick(el, cx, cy);
          break;
        }
        case "select": {
          const setter = nativeSetter(el) || ((v) => (el.value = v));
          setter.call(el, p.value);
          fire(el, "input"); fire(el, "change");
          break;
        }
        case "submit": (el.form || el.closest("form"))?.requestSubmit?.(); break;
        default: {
          const e = new Error(`unknown action: ${p.action}`); e.code = "BAD_ACTION"; throw e;
        }
      }
    } finally {
      await sleep(60);
      mo.disconnect();
    }
    const after = { url: location.href, value: "value" in el ? el.value : undefined };
    return {
      acted: true,
      action: p.action,
      changed: before.url !== after.url || before.value !== after.value || mutated > 0,
      signals: { navigated: before.url !== after.url, domMutations: mutated },
      snapshotStale: true, // caller should re-observe
    };
  }

  // Network/DOM-quiet heuristic without CDP.
  async function waitForStable(p = {}) {
    const timeout = p.timeout || 8000;
    const quiet = p.quietMs || 600;
    const t0 = performance.now();
    let lastMutation = performance.now();
    const mo = new MutationObserver(() => (lastMutation = performance.now()));
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    let lastResource = performance.now();
    let po;
    try {
      po = new PerformanceObserver(() => (lastResource = performance.now()));
      po.observe({ type: "resource", buffered: false });
    } catch {}
    try {
      while (performance.now() - t0 < timeout) {
        const idle = performance.now() - Math.max(lastMutation, lastResource);
        if (document.readyState === "complete" && idle > quiet)
          return { stable: true, waitedMs: Math.round(performance.now() - t0) };
        await sleep(120);
      }
      return { stable: false, timedOut: true, waitedMs: timeout };
    } finally {
      mo.disconnect();
      po?.disconnect();
    }
  }

  async function navigate(p = {}) {
    if (p.action === "back") history.back();
    else if (p.action === "forward") history.forward();
    else if (p.action === "reload") location.reload();
    else if (p.url) location.assign(p.url);
    else {
      const e = new Error("navigate: need url or back/forward/reload"); e.code = "BAD_ACTION"; throw e;
    }
    return { navigating: true, to: p.url || p.action };
  }

  // Re-injection must REPLACE the previous listener, never stack on it.
  // After a back/forward-cache restore the earlier instance is still
  // registered but its message channel is dead; if it stays, it answers first
  // and the reply goes nowhere ("message channel is closed"). Dropping the old
  // registration first makes injection idempotent and re-binds the channel.
  if (window.__abEngineListener) {
    try {
      chrome.runtime.onMessage.removeListener(window.__abEngineListener);
    } catch {}
  }
  const abEngineListener = (msg, _s, sendResponse) => {
    (async () => {
      try {
        const m = msg.method;
        if (m === "ping")
          sendResponse({ pong: true, url: location.href, title: document.title, ts: Date.now() });
        else if (m === "observe") sendResponse(observe(msg.params));
        else if (m === "locate") sendResponse(locate(msg.params));
        else if (m === "act") sendResponse(await act(msg.params));
        else if (m === "waitForStable") sendResponse(await waitForStable(msg.params));
        else if (m === "navigate") sendResponse(await navigate(msg.params));
        else if (m === "clearMarks") {
          clearMarks();
          sendResponse({ ok: true });
        } else sendResponse({ error: `unknown engine method: ${m}` });
      } catch (e) {
        sendResponse({ error: String((e && e.message) || e), code: e && e.code });
      }
    })();
    return true;
  };
  window.__abEngineListener = abEngineListener;
  chrome.runtime.onMessage.addListener(abEngineListener);

  // A bfcache restore brings this document back with a stale channel. Re-arm
  // the listener so the next call binds to a live one instead of erroring.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    try {
      chrome.runtime.onMessage.removeListener(abEngineListener);
      chrome.runtime.onMessage.addListener(abEngineListener);
    } catch {}
  });
})();
