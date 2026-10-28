// Service worker: connects OUT to the localhost MCP bridge, relays commands
// to the in-page content engine. No CDP, no chrome.debugger anywhere.

// Static import (reliable in MV3 module SW). No top-level await, no dynamic
// import. generated-secret.js is produced by scripts/sync-ext-secret.mjs.
import { BRIDGE_SECRET, BRIDGE_PORT } from "./generated-secret.js";
import * as netstore from "./lib/netstore.js";
import { keyMatcher, redactHeaders, redactUrl, redactBody, redactValues } from "./lib/redact.js";
import { mergeStreams, filterEntries, isFailed } from "./lib/net-merge.js";

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
    ws.send(JSON.stringify({ type: "auth", secret: cfg.BRIDGE_SECRET, extension: { version: chrome.runtime.getManifest().version } }));
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
      applyConfig(msg.config || {}).catch((e) => console.warn("[agent-bridge] config", e));
      // The heartbeat keeps this worker alive for weeks, so the check at
      // startup alone never sees an update. Each reconnect (a server restart
      // after a rebuild, typically) looks again.
      reloadIfStale();
      return;
    }
    // Server heartbeat. Nothing to do with the payload — simply RECEIVING it
    // resets this worker's ~30s idle timer, which is what keeps the bridge up
    // between tool calls instead of dying and waiting on the alarm backstop.
    if (msg.type === "keepalive") return;
    // The person edited config/local.json; the server re-sends what we act on.
    if (msg.type === "config") {
      applyConfig(msg.config || {}).catch((e) => console.warn("[agent-bridge] config", e));
      return;
    }
    if (!msg.id || !msg.method) return;
    try {
      const result = await dispatch(msg.method, msg.params || {});
      ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (e) {
      // The code and detail are what callers branch on; never drop them.
      ws.send(JSON.stringify({
        id: msg.id, ok: false, error: String(e && e.message || e),
        ...(e && e.code ? { code: e.code } : {}),
        ...(e && e.detail ? { detail: e.detail } : {}),
      }));
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

const tagged = (code, message, detail) => Object.assign(new Error(message), { code, ...(detail ? { detail } : {}) });

// The tab a call acts on. The server names it (each agent session owns its
// own tab); only the legacy "default" session leaves it out and gets whatever
// tab is focused. A named tab that is gone is an error, never a silent switch
// to some other tab — that is how one agent used to act on another's page.
async function tabFor(params = {}) {
  if (params.tabId == null) return activeTab();
  const tab = await chrome.tabs.get(params.tabId).catch(() => null);
  if (!tab) throw tagged("TAB_GONE", `TAB_GONE: tab ${params.tabId} was closed`, { tabId: params.tabId });
  return tab;
}

// Top-frame commits per tab, so a caller can tell the page changed under it.
const NAV_COUNT = new Map();
// Tabs opened from another tab (target=_blank, window.open), newest last.
const OPENED = [];
chrome.tabs.onCreated.addListener(async (t) => {
  if (t.openerTabId == null) return;
  OPENED.push({ tabId: t.id, openerTabId: t.openerTabId, windowId: t.windowId, ts: Date.now() });
  if (OPENED.length > 50) OPENED.shift();
  // A tab opened from a muted agent tab is muted too; one opened from a
  // mobile-emulated tab is emulated too.
  const opener = await chrome.tabs.get(t.openerTabId).catch(() => null);
  if (opener?.mutedInfo?.muted && opener.mutedInfo.reason === "extension") chrome.tabs.update(t.id, { muted: true }).catch(() => {});
  if (MOBILE.has(t.openerTabId)) setMobile(t, MOBILE.get(t.openerTabId)).catch(() => {});
});
chrome.tabs.onRemoved.addListener((id) => {
  NAV_COUNT.delete(id);
  netstore.clearTab(id, { keepPending: true }).catch(() => {});
  if (MOBILE.delete(id)) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleIdFor(id)] }).catch(() => {});
});

// ---- viewport: a real one, not a scaled picture. The window is sized so the
// page's own width and height are what was asked, and the tab's zoom sets the
// device pixel ratio (150% on a 2x screen is 3x, like a phone). Media queries,
// layout and devicePixelRatio are then the browser's own answers.
async function setViewport(tab, v) {
  const metrics = () => callEngine(tab.id, "pageMetrics", {});
  let zoom = await chrome.tabs.getZoom(tab.id);
  let m = await metrics();
  const native = m.devicePixelRatio / zoom;
  const want = v.deviceScaleFactor ? v.deviceScaleFactor / native : 1;
  if (Math.abs(want - zoom) > 0.01) {
    // Per tab: other tabs of the same site keep their zoom. Chrome resets a
    // per-tab zoom on navigation, so the server applies it again after each.
    await chrome.tabs.setZoomSettings(tab.id, { mode: "automatic", scope: "per-tab" });
    await chrome.tabs.setZoom(tab.id, want);
    zoom = want;
    await sleep(250);
  }
  for (let i = 0; i < 3; i++) {
    m = await metrics();
    const dw = Math.round((v.width - m.innerWidth) * zoom);
    const dh = Math.round((v.height - m.innerHeight) * zoom);
    if (!dw && !dh) break;
    const win = await chrome.windows.get(tab.windowId);
    await chrome.windows.update(tab.windowId, { width: win.width + dw, height: win.height + dh });
    await sleep(250);
  }
  m = await metrics();
  const got = { width: m.innerWidth, height: m.innerHeight, deviceScaleFactor: Math.round(m.devicePixelRatio * 100) / 100 };
  const off = got.width !== v.width || got.height !== v.height || (v.deviceScaleFactor && Math.abs(got.deviceScaleFactor - v.deviceScaleFactor) > 0.05);
  return { viewport: got, zoom, ...(off ? { note: `asked for ${v.width}x${v.height}${v.deviceScaleFactor ? ` @${v.deviceScaleFactor}x` : ""}; Chrome gave ${got.width}x${got.height} @${got.deviceScaleFactor}x` } : {}) };
}

// ---- mobile: an approximation, for sessions that ask. The site is told it is
// a phone the way a phone tells it — the User-Agent and client-hint headers
// (a per-tab header rule) — and the page sees touch support and a coarse,
// hoverless pointer (page-world patches, re-applied on every load).
const MOBILE = new Map();
const ruleIdFor = (tabId) => (tabId % 2147483000) + 1;
function mobileUA() {
  const major = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || "120";
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
}
async function setMobile(tab, opts) {
  const on = opts.mobile !== false;
  const id = ruleIdFor(tab.id);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
  if (!on) {
    MOBILE.delete(tab.id);
    return { mobile: false };
  }
  const ua = mobileUA();
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id,
      priority: 1,
      condition: { tabIds: [tab.id], resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "script", "stylesheet", "image", "media", "font", "other", "ping", "websocket"] },
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "user-agent", operation: "set", value: ua },
          { header: "sec-ch-ua-mobile", operation: "set", value: "?1" },
          { header: "sec-ch-ua-platform", operation: "set", value: '"Android"' },
        ],
      },
    }],
  });
  MOBILE.set(tab.id, { mobile: true, ua });
  await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: "MAIN", injectImmediately: true, func: mobilePatch, args: [ua] }).catch(() => {});
  return { mobile: true, userAgent: ua };
}

// Page world. Touch support, a phone's navigator, and the hover/pointer media
// features a phone reports — in matchMedia and in the page's stylesheets.
function mobilePatch(ua) {
  if (window.__abMobile) return;
  window.__abMobile = true;
  const nav = Object.getPrototypeOf(navigator);
  const define = (obj, key, value) => { try { Object.defineProperty(obj, key, { configurable: true, get: () => value }); } catch {} };
  define(nav, "userAgent", ua);
  define(nav, "appVersion", ua.replace(/^Mozilla\//, ""));
  define(nav, "platform", "Linux armv8l");
  define(nav, "maxTouchPoints", 5);
  if (navigator.userAgentData) {
    const data = navigator.userAgentData;
    define(data, "mobile", true);
    define(data, "platform", "Android");
  }
  if (!("ontouchstart" in window)) window.ontouchstart = null;
  // (hover: hover) and (pointer: fine) are false on a phone; their opposites true.
  const TRUE = "(min-width: 0px)", FALSE = "(max-width: 0px)";
  const rewrite = (q) =>
    String(q)
      .replace(/\((any-)?hover\s*:\s*hover\)/g, FALSE).replace(/\((any-)?hover\s*:\s*none\)/g, TRUE)
      .replace(/\((any-)?pointer\s*:\s*fine\)/g, FALSE).replace(/\((any-)?pointer\s*:\s*coarse\)/g, TRUE);
  const mm = window.matchMedia.bind(window);
  window.matchMedia = (q) => mm(rewrite(q));
  const fixSheets = () => {
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      const walk = (list) => {
        for (const r of list) {
          if (r.media && /hover|pointer/.test(r.media.mediaText)) {
            const next = rewrite(r.media.mediaText);
            if (next !== r.media.mediaText) r.media.mediaText = next;
          }
          if (r.cssRules) walk(r.cssRules);
        }
      };
      walk(rules);
    }
  };
  document.addEventListener("DOMContentLoaded", fixSheets);
  window.addEventListener("load", fixSheets);
  new MutationObserver(fixSheets).observe(document.documentElement, { childList: true, subtree: true });
}

// ---- network: what every agent tab sent and received ----------------------
// Two streams (see lib/net-merge.js): "wire" records from webRequest, which the
// page cannot see, on every host; and "page" records from net-hook.js (bodies,
// WebSocket and EventSource frames), on every host but the blocked ones. Both
// go to IndexedDB with secrets removed first, so nothing stored or read back
// holds an Authorization header or a typed password.
const NETCFG_DEFAULT = {
  enabled: true,
  blockedDomains: [],
  wireTypes: ["main_frame", "sub_frame", "xmlhttprequest", "websocket", "ping", "other"],
  redactHeaders: ["authorization", "proxy-authorization", "cookie", "set-cookie"],
  redactKeys: "password|passwd|secret|token",
  maxBodyChars: 65536,
  maxEntriesPerTab: 500,
  maxTotalEntries: 20000,
  retainHours: 24,
};
let NETCFG = null;
let isSecretKey = keyMatcher(NETCFG_DEFAULT.redactKeys);
// The worker may wake for a request before the server has sent any config.
const netReady = chrome.storage.local.get("netConfig").then(({ netConfig }) => setNetConfig(netConfig)).catch(() => setNetConfig(null));
function setNetConfig(c) {
  NETCFG = { ...NETCFG_DEFAULT, ...(c || {}) };
  isSecretKey = keyMatcher(NETCFG.redactKeys);
}
const hostBlocked = (url) => {
  try {
    const h = new URL(url).hostname;
    return (NETCFG?.blockedDomains || []).some((d) => h === d || h.endsWith("." + d));
  } catch {
    return false;
  }
};

// Values the agent typed into password fields, kept in memory for a few
// minutes so the request that sends them is redacted whatever its field names.
const TYPED_SECRETS = [];
function rememberSecret(value) {
  if (typeof value !== "string" || value.length < 4) return;
  TYPED_SECRETS.push({ value, until: Date.now() + 600_000 });
}
function typedSecrets() {
  const t = Date.now();
  while (TYPED_SECRETS.length && TYPED_SECRETS[0].until < t) TYPED_SECRETS.shift();
  return TYPED_SECRETS.map((s) => s.value);
}
function scrubText(text, contentType) {
  if (typeof text !== "string") return text;
  return redactValues(redactBody(text, contentType, isSecretKey), typedSecrets());
}

// Background jobs' tabs: a matching record there is "pending" until the daemon
// writes it to the job's file. Kept in the store's meta, so it survives sleep.
let JOB_TABS = null;
async function jobTabs() {
  if (!JOB_TABS) JOB_TABS = new Map(Object.entries((await netstore.getMeta("jobTabs").catch(() => null)) || {}).map(([k, v]) => [Number(k), v]));
  return JOB_TABS;
}
async function saveJobTabs() {
  await netstore.setMeta("jobTabs", Object.fromEntries(JOB_TABS || []));
}
const JOB_SOCKETS = new Set();
function jobFor(jobs, tabId, rec) {
  const j = jobs.get(tabId);
  if (!j) return null;
  if (rec.socketId !== undefined && rec.kind !== "ws-open" && rec.kind !== "sse-open") {
    return JOB_SOCKETS.has(`${tabId}|${rec.socketId}`) ? j : null;
  }
  const hit = (j.patterns || []).some((p) => {
    try {
      return new RegExp(p, "i").test(rec.url || "");
    } catch {
      return String(rec.url || "").includes(p);
    }
  });
  if (hit && rec.socketId !== undefined) JOB_SOCKETS.add(`${tabId}|${rec.socketId}`);
  return hit ? j : null;
}

async function store(records) {
  if (!records.length) return;
  const jobs = await jobTabs();
  for (const r of records) {
    const j = jobFor(jobs, r.tabId, r);
    r.status = j ? "pending" : "buffer";
    if (j) r.jobId = j.jobId;
  }
  await netstore.addMany(records);
}

/** What the hook in a page sent. Only `sender` says which tab: a page cannot forge it. */
async function netIntake(records, sender) {
  await netReady;
  if (!NETCFG.enabled || !Array.isArray(records) || !sender.tab) return;
  const out = [];
  for (const r of records.slice(0, 200)) {
    if (!r || typeof r !== "object") continue;
    const rec = {
      ...r,
      tabId: sender.tab.id,
      frameId: sender.frameId,
      documentId: sender.documentId,
      frameUrl: sender.frameId ? sender.url : undefined,
      ts: typeof r.ts === "number" ? r.ts : Date.now(),
    };
    if (rec.url) rec.url = redactUrl(String(rec.url), isSecretKey);
    if (hostBlocked(rec.url)) {
      delete rec.body;
      delete rec.requestBody;
      rec.skipped = "blocked";
    }
    if (rec.requestBody !== undefined) rec.requestBody = scrubText(rec.requestBody, "");
    if (rec.body !== undefined) rec.body = scrubText(rec.body, rec.contentType);
    if (rec.data !== undefined) rec.data = scrubText(rec.data, "");
    out.push(rec);
  }
  await store(out);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "ab-net") return false;
  netIntake(msg.records, sender).catch((e) => console.warn("[agent-bridge] net intake", e));
  return false;
});

// webRequest: partial records keyed by requestId until the request ends.
const INFLIGHT = new Map();
let WIRE_OUT = [];
let wireTimer = null;
function wireFlush() {
  wireTimer = null;
  const batch = WIRE_OUT;
  WIRE_OUT = [];
  store(batch).catch((e) => console.warn("[agent-bridge] net store", e));
}
function formBody(rb) {
  if (!rb) return undefined;
  if (rb.formData) {
    return Object.entries(rb.formData)
      .flatMap(([k, vs]) => vs.map((v) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`))
      .join("&");
  }
  if (rb.raw?.length) {
    try {
      const bytes = rb.raw.map((p) => (p.bytes ? new Uint8Array(p.bytes) : new Uint8Array())).reduce((a, b) => {
        const c = new Uint8Array(a.length + b.length);
        c.set(a);
        c.set(b, a.length);
        return c;
      });
      return new TextDecoder().decode(bytes).slice(0, NETCFG?.maxBodyChars || 65536);
    } catch {
      return "[binary]";
    }
  }
  return undefined;
}
function wireFinish(d, extra) {
  const p = INFLIGHT.get(d.requestId) || { ts: d.timeStamp, method: d.method, type: d.type, tabId: d.tabId, frameId: d.frameId, documentId: d.documentId };
  INFLIGHT.delete(d.requestId);
  if (!NETCFG?.enabled && !(extra.status >= 400 || extra.error)) return;
  const keep = (NETCFG?.wireTypes || NETCFG_DEFAULT.wireTypes).includes(d.type) || extra.status >= 400 || !!extra.error;
  if (!keep) return;
  const blockedHost = hostBlocked(d.url);
  const rec = {
    kind: "wire",
    ...p,
    url: redactUrl(d.url, isSecretKey),
    tsEnd: d.timeStamp,
    ...extra,
    requestHeaders: blockedHost ? undefined : redactHeaders(p.requestHeaders, NETCFG?.redactHeaders),
    responseHeaders: blockedHost ? undefined : redactHeaders(extra.responseHeaders, NETCFG?.redactHeaders),
    requestBody: blockedHost || p.requestBody === undefined ? undefined : scrubText(p.requestBody, "application/x-www-form-urlencoded"),
  };
  WIRE_OUT.push(rec);
  if (WIRE_OUT.length >= 50) wireFlush();
  else if (!wireTimer) wireTimer = setTimeout(wireFlush, 500);
}
if (chrome.webRequest) {
  const all = { urls: ["<all_urls>"] };
  chrome.webRequest.onBeforeRequest.addListener((d) => {
    if (d.tabId < 0) return;
    // Long polls and streams that never end must not grow this forever.
    if (INFLIGHT.size > 2000) {
      const cutoff = Date.now() - 600_000;
      for (const [id, v] of INFLIGHT) if (v.ts < cutoff) INFLIGHT.delete(id);
    }
    INFLIGHT.set(d.requestId, {
      ts: d.timeStamp, method: d.method, type: d.type, tabId: d.tabId, frameId: d.frameId, documentId: d.documentId,
      // A form a document posts is invisible to the page hook; this is its only record.
      ...((d.type === "main_frame" || d.type === "sub_frame") && d.method === "POST" ? { requestBody: formBody(d.requestBody) } : {}),
    });
  }, all, ["requestBody"]);
  chrome.webRequest.onSendHeaders.addListener((d) => {
    const p = INFLIGHT.get(d.requestId);
    if (p) p.requestHeaders = d.requestHeaders;
  }, all, ["requestHeaders"]);
  chrome.webRequest.onCompleted.addListener((d) => {
    if (d.tabId < 0) return;
    wireFinish(d, { status: d.statusCode, statusLine: d.statusLine, responseHeaders: d.responseHeaders, fromCache: d.fromCache, ip: d.ip });
  }, all, ["responseHeaders"]);
  chrome.webRequest.onErrorOccurred.addListener((d) => {
    if (d.tabId < 0) return;
    // An abort is a page cancelling its own request (navigation, a superseded
    // fetch), not a failure worth reporting.
    if (d.error === "net::ERR_ABORTED") return void INFLIGHT.delete(d.requestId);
    wireFinish(d, { error: d.error });
  }, all);
}

// Entries for a tab, joined and filtered. Bodies are cut here, before they
// cross the bridge: an agent asks for what it needs, not every byte.
async function netQuery(tab, params) {
  await netReady;
  const since = params.since ?? 0;
  // Wire records are stamped when the request started: look a little earlier
  // so a request whose page record is inside the range keeps its headers.
  const records = await netstore.queryTab(tab.id, { since: Math.max(0, since - 5000) });
  const all = mergeStreams(records);
  const matched = filterEntries(all, { ...params, since, limit: undefined });
  const limit = Math.min(params.limit || 50, 500);
  const bodyChars = Math.min(params.bodyChars || 4000, NETCFG.maxBodyChars || 65536);
  const entries = matched.slice(0, limit).map((e) => {
    const out = { ...e };
    for (const k of ["body", "requestBody"]) {
      if (typeof out[k] !== "string") continue;
      if (!params.includeBodies) {
        out[k + "Preview"] = out[k].slice(0, 200);
        delete out[k];
      } else if (out[k].length > bodyChars) {
        out[k] = out[k].slice(0, bodyChars);
        out[k + "Cut"] = true;
      }
    }
    if (!params.includeHeaders) {
      delete out.requestHeaders;
      delete out.responseHeaders;
    }
    if (out.frames && !params.includeBodies) out.frames = out.frames.slice(-10);
    return out;
  });
  return { tabId: tab.id, url: tab.url, entries, matched: matched.length, total: all.length, blocked: hostBlocked(tab.url || "") };
}

/** The old diagnostics shape: failed requests only. */
async function netFailures(tabId, since) {
  const records = await netstore.queryTab(tabId, { since: Math.max(0, since - 5000) }).catch(() => []);
  return mergeStreams(records)
    .filter((e) => e.ts >= since && isFailed(e))
    .map((e) => ({ ts: e.ts, url: e.url, method: e.method, type: e.wireType || e.type, ...(e.error ? { error: e.error } : { status: e.status, statusLine: e.statusText }) }));
}

async function netDispatch(method, params) {
  if (method === "net.watch") {
    const jobs = await jobTabs();
    jobs.set(params.tabId, { jobId: params.jobId, patterns: params.patterns || [] });
    await saveJobTabs();
    return { watching: params.tabId };
  }
  if (method === "net.unwatch") {
    const jobs = await jobTabs();
    for (const [tabId, j] of jobs) if (tabId === params.tabId || j.jobId === params.jobId) jobs.delete(tabId);
    await saveJobTabs();
    return { watching: false };
  }
  if (method === "net.drain") {
    const records = await netstore.takePending(params.jobId, { olderThan: Date.now() - (params.olderThanMs ?? 2000), maxBytes: params.maxBytes });
    return { entries: mergeStreams(records), ids: records.map((r) => r.id) };
  }
  if (method === "net.ack") return { written: await netstore.markWritten(params.ids || []) };
  if (method === "net.stats") return { ...(await netstore.stats()), jobTabs: Object.fromEntries(await jobTabs()) };
  const tab = await tabFor(params);
  if (method === "net.query") return await netQuery(tab, params);
  if (method === "net.clear") return { cleared: await netstore.clearTab(tab.id, { keepPending: true }) };
  throw new Error(`unknown method: ${method}`);
}

async function netPrune() {
  await netReady;
  await netstore.prune({ perTab: NETCFG.maxEntriesPerTab, total: NETCFG.maxTotalEntries, retainMs: NETCFG.retainHours * 3600_000 });
}
chrome.alarms.create("ab-net-prune", { periodInMinutes: 15 });

// A new browser session reuses tab ids from 1: last session's records would
// be read as this session's. storage.session is empty again after a restart.
chrome.storage.session.get("abBoot").then(async ({ abBoot }) => {
  if (abBoot) return;
  await netstore.wipeUnpending().catch(() => {});
  JOB_TABS = new Map();
  await saveJobTabs().catch(() => {});
  await chrome.storage.session.set({ abBoot: Date.now() });
}).catch(() => {});

// Patterns for the blocklist: a domain and its subdomains.
const DOMAIN = /^[a-z0-9.-]+$/i;
const blockedPatterns = (list) => (list || []).filter((d) => DOMAIN.test(d)).flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);

async function applyNetConfig(net) {
  const c = { ...NETCFG_DEFAULT, ...(net || {}) };
  await chrome.storage.local.set({ netConfig: c });
  setNetConfig(c);
  const want = c.enabled ? JSON.stringify({ exclude: blockedPatterns(c.blockedDomains), v: 1 }) : "off";
  const have = await chrome.scripting.getRegisteredContentScripts({ ids: ["ab-net-hook", "ab-net-relay"] }).catch(() => []);
  const { netRegistered } = await chrome.storage.local.get("netRegistered");
  // Re-registering leaves a gap in which pages load unrecorded: only when it changed.
  if (netRegistered === want && have.length === (c.enabled ? 2 : 0)) return;
  await chrome.scripting.unregisterContentScripts({ ids: ["ab-net-hook", "ab-net-relay"] }).catch(() => {});
  if (c.enabled) {
    const common = {
      matches: ["http://*/*", "https://*/*"],
      excludeMatches: blockedPatterns(c.blockedDomains),
      runAt: "document_start",
      allFrames: true,
      // Kept across browser restarts, so a job's page is recorded from its
      // first load, before the server has had a chance to connect.
      persistAcrossSessions: true,
    };
    await chrome.scripting.registerContentScripts([
      { id: "ab-net-relay", js: ["src/content/net-relay.js"], world: "ISOLATED", ...common },
      { id: "ab-net-hook", js: ["src/main/net-hook.js"], world: "MAIN", ...common },
    ]);
  }
  await chrome.storage.local.set({ netRegistered: want });
}

// Console and page-error capture is a MAIN-world hook, which a page could
// detect, so it runs only on development hosts (and hosts the user lists).
const DEV_PATTERNS = ["*://localhost/*", "*://127.0.0.1/*", "*://[::1]/*", "*://*.localhost/*", "*://*.local/*", "*://*.test/*"];
const PRIVATE_IP = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;
async function applyConfig(config) {
  await applyNetConfig(config.network).catch((e) => console.warn("[agent-bridge] network capture", e));
  const extra = (config.diagnosticsHosts || []).flatMap((h) => [`*://${h}/*`, `*://*.${h}/*`]);
  await chrome.scripting.unregisterContentScripts({ ids: ["ab-diag"] }).catch(() => {});
  await chrome.scripting.registerContentScripts([{
    id: "ab-diag",
    js: ["src/content/diag-hook.js"],
    matches: [...DEV_PATTERNS, ...extra],
    runAt: "document_start",
    world: "MAIN",
    allFrames: false,
    persistAcrossSessions: false,
  }]);
}

// Ring buffer of recent top-frame navigations. Redirect-based flows (OAuth
// consent, SSO hand-off, payment return, magic links) hand the interesting
// value to the browser as a URL the agent never gets to "see" — it may bounce
// onward before any observe() runs. Recording every commit lets an agent ask
// "did we pass through a URL matching X, and what were its params?" after the
// fact, instead of racing the redirect chain.
const NAV_LOG = [];
const NAV_LOG_MAX = 50;
function recordNav(url, tabId) {
  NAV_LOG.push({ url, ts: Date.now(), tabId });
  if (NAV_LOG.length > NAV_LOG_MAX) NAV_LOG.shift();
}

function matchNav(patternSource, sinceTs, tabId) {
  const re = new RegExp(patternSource);
  for (let i = NAV_LOG.length - 1; i >= 0; i--) {
    const n = NAV_LOG[i];
    if (n.ts < sinceTs) break;
    if (tabId != null && n.tabId !== tabId) continue;
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
    const hit = matchNav(pattern, sinceTs, params.tabId);
    if (hit) return { matched: true, ...hit };
    if (Date.now() >= deadline) {
      return {
        matched: false,
        urlPattern: pattern,
        waitedMs: timeoutMs,
        recentUrls: NAV_LOG.filter((n) => params.tabId == null || n.tabId === params.tabId).slice(-10).map((n) => n.url),
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Read-only engine methods: re-running one after a dropped port changes nothing,
// so they're safe to retry. Anything absent from this set may have side effects.
const RETRY_SAFE = new Set([
  "ping", "observe", "locate", "waitForStable", "clearMarks",
  "pageMetrics", "rectOf", "scrollToY", "hideFixed", "restoreFixed",
  "hideScrollbar", "restoreScrollbar", "settle", "pageState", "inspect",
  "diagnostics", "prepareElementCapture", "detectWall",
]);

// The engine reports its own failures (NOT_ACTIONABLE, NO_SUCH_OPTION…) as an
// ordinary reply carrying `error`, because sendResponse has no reject. Passing
// that on as a result is how a failed select came back as `acted: true`.
// Turn it into a thrown error here, once, for every method.
class EngineError extends Error {
  constructor(reply) {
    super(reply.error);
    this.code = reply.code;
    if (reply.detail) this.detail = reply.detail;
  }
}
const unwrap = (reply) => {
  if (reply && typeof reply.error === "string") throw new EngineError(reply);
  return reply;
};

async function callEngine(tabId, method, params) {
  // Target the TOP frame only — broadcasting lets cross-origin tracking
  // iframes answer first. The engine walks same-origin child frames itself.
  try {
    return unwrap(await chrome.tabs.sendMessage(tabId, { method, params }, { frameId: 0 }));
  } catch (e) {
    // The engine ran and said no. Never retried: for act, it may have done part.
    if (e instanceof EngineError) throw e;
    const msg = String(e.message || e);
    // The message never reached a content script — nothing ran, so retrying
    // is always safe (tab predates the extension, or was orphaned by a reload).
    const neverDelivered = /Receiving end does not exist|Could not establish connection/.test(msg);
    // The port died mid-call because the document was torn down or pushed into
    // the back/forward cache. Whatever we sent MAY already have run.
    // Chrome words this two ways: "…message channel is closed" and "…the
    // message channel closed before a response was received".
    const portClosed = /back\/forward cache|message channel (is )?closed/.test(msg);
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
      let reply;
      try {
        reply = await chrome.tabs.sendMessage(tabId, { method, params }, { frameId: 0 });
      } catch (retryErr) {
        lastErr = retryErr;
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      return unwrap(reply); // an engine error here ends the retries
    }
    throw lastErr;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome allows two captures a second; space them so stitching never trips it.
let lastCaptureAt = 0;

// The first capture after a navigation regularly fails with "image readback
// failed" while the window is behind others: Chrome has no fresh frame for it
// yet, and the failed request is what prompts one. Measured: fail, then an
// immediate retry succeeds. So retry a few times before giving up.
async function captureViewport(windowId) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastCaptureAt + 550 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCaptureAt = Date.now();
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } catch (e) {
      lastErr = e;
      if (!/readback|MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(String(e.message || e))) break;
    }
  }
  throw lastErr;
}

function bytesToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Output images stay under 4000px per side: models reject images past 8000px,
// and one tall strip is unreadable once scaled down, so long captures come
// back as several tiles in page order.
const TILE_MAX = 4000;
// Bound a full-page capture: an infinite feed would otherwise scroll forever.
const FULL_PAGE_MAX_CSS = 20000;

// Capture a region of the page given in CSS pixels, page coordinates. Scrolls
// slice by slice when the region is taller than the viewport and stitches the
// slices; restores the scroll position afterwards. Regions are cut to the
// viewport's width — horizontal scrolling is not stitched.
async function captureRegion(tab, region, opts = {}) {
  const m = await callEngine(tab.id, "pageMetrics", {});
  const notes = [];
  let { x, y, width, height } = region;
  if (x < 0) { width += x; x = 0; }
  if (x + width > m.innerWidth) { width = m.innerWidth - x; notes.push("cut to the viewport's width"); }
  if (y < 0) { height += y; y = 0; }
  if (y + height > m.scrollHeight) height = m.scrollHeight - y;
  if (height > FULL_PAGE_MAX_CSS) { height = FULL_PAGE_MAX_CSS; notes.push(`cut at ${FULL_PAGE_MAX_CSS}px of page height`); }
  if (width < 1 || height < 1) throw new Error("EMPTY_REGION: the region is outside the page");

  const scale = opts.scale ?? m.devicePixelRatio;
  const outW = Math.round(width * scale);
  const outH = Math.round(height * scale);
  const tiles = [];
  for (let top = 0; top < outH; top += TILE_MAX) {
    const h = Math.min(TILE_MAX, outH - top);
    const canvas = new OffscreenCanvas(outW, h);
    tiles.push({ canvas, ctx: canvas.getContext("2d"), top, h });
  }

  const fitsInView = y >= m.scrollY && y + height <= m.scrollY + m.innerHeight;
  const maxScroll = Math.max(0, m.scrollHeight - m.innerHeight);
  let hid = false;
  let slices = 0;
  let cur = y;
  if (!fitsInView) await callEngine(tab.id, "hideScrollbar", {}).catch(() => {});
  // An element taller than the screen: a sticky header would sit over its
  // top edge in the first slice, so hide fixed elements from the start.
  if (opts.hideFixedFirst) {
    await callEngine(tab.id, "hideFixed", {});
    hid = true;
  }
  try {
    while (cur < y + height) {
      const viewTop = fitsInView ? m.scrollY : (await callEngine(tab.id, "scrollToY", { y: Math.min(cur, maxScroll) })).scrollY;
      const sliceEnd = Math.min(y + height, viewTop + m.innerHeight);
      if (sliceEnd <= cur) break; // the page would not scroll far enough
      const bmp = await createImageBitmap(await (await fetch(await captureViewport(tab.windowId))).blob());
      const k = bmp.width / m.innerWidth; // captured pixels per CSS pixel
      // Paint this slice into every output tile it overlaps.
      const dTop = (cur - y) * scale;
      const dBottom = (sliceEnd - y) * scale;
      for (const t of tiles) {
        const a = Math.max(dTop, t.top);
        const b = Math.min(dBottom, t.top + t.h);
        if (b <= a) continue;
        const srcY = (cur - viewTop + (a - dTop) / scale) * k;
        const srcH = ((b - a) / scale) * k;
        t.ctx.drawImage(bmp, x * k, srcY, width * k, srcH, 0, a - t.top, outW, b - a);
      }
      bmp.close();
      slices += 1;
      cur = sliceEnd;
      if (!hid && cur < y + height) {
        await callEngine(tab.id, "hideFixed", {});
        hid = true;
      }
    }
  } finally {
    if (hid) await callEngine(tab.id, "restoreFixed", {}).catch(() => {});
    if (!fitsInView) await callEngine(tab.id, "restoreScrollbar", {}).catch(() => {});
    if (!fitsInView) await callEngine(tab.id, "scrollToY", { y: m.scrollY }).catch(() => {});
  }
  if (cur < y + height)
    notes.push(`only the top ${Math.round(cur - y)}px could be captured: the page stopped scrolling (it may scroll inside an inner element)`);

  const type = opts.format === "jpeg" ? "image/jpeg" : "image/png";
  const images = [];
  for (const t of tiles) {
    const blob = await t.canvas.convertToBlob({ type, quality: 0.85 });
    images.push(`data:${type};base64,${bytesToBase64(await blob.arrayBuffer())}`);
  }
  return {
    images,
    region: { x, y, width, height },
    scale,
    slices,
    viewport: { scrollX: m.scrollX, scrollY: m.scrollY, width: m.innerWidth, height: m.innerHeight, pageHeight: m.scrollHeight },
    ...(notes.length ? { notes } : {}),
  };
}

// captureVisibleTab sees only the tab in front of its window. A session's tab
// is the only one in its window unless something opened another there; bring
// it to the front of that window — never focusing the window itself.
async function showTab(tab) {
  if (tab.active) return;
  await chrome.tabs.update(tab.id, { active: true });
  await sleep(200);
}

// One element. The engine first scrolls it to the middle of the screen and
// clears any fixed or sticky bar lying over it, or refuses (OCCLUDED) when
// something else covers it. Taking the shot anyway is how a section's capture
// once came back as the site header and cart icon.
async function screenshotElement(tab, params) {
  const prep = await callEngine(tab.id, "prepareElementCapture", { ref: params.ref, gen: params.gen });
  const scale = params.scale;
  const format = params.format ?? "png";
  try {
    const out = await captureRegion(tab, prep.rect, { scale, format, hideFixedFirst: !prep.fits });
    // The element must still be where it was measured, or the image is of
    // whatever moved into its place.
    const after = (await callEngine(tab.id, "rectOf", { ref: params.ref })).rect;
    if (Math.abs(after.y - prep.rect.y) > 2 || Math.abs(after.x - prep.rect.x) > 2)
      throw tagged("CAPTURE_FAILED", "CAPTURE_FAILED: the element moved while it was being captured (the page is still changing); wait, then retry");
    return { url: tab.url, format, ...out, ...(prep.hidOverlays?.length ? { hidOverlays: prep.hidOverlays } : {}) };
  } finally {
    await callEngine(tab.id, "restoreFixed", {}).catch(() => {});
  }
}

// Full page, one element (by ref), or a region; otherwise the viewport.
async function screenshot(tab, params = {}) {
  await showTab(tab);
  if (params.ref != null && !params.fullPage && !params.clip) return screenshotElement(tab, params);
  const resized = params.scale != null || params.format != null;
  if (!params.fullPage && params.ref == null && !params.clip && !resized) {
    const m = await callEngine(tab.id, "pageMetrics", {}).catch(() => null);
    return {
      screenshot: await captureViewport(tab.windowId),
      url: tab.url,
      format: "png",
      ...(m ? { viewport: { scrollX: m.scrollX, scrollY: m.scrollY, width: m.innerWidth, height: m.innerHeight, pageHeight: m.scrollHeight } } : {}),
    };
  }
  let region;
  if (!params.fullPage && params.ref == null && !params.clip) {
    // The viewport, but at a chosen scale or format: the visible region.
    const m = await callEngine(tab.id, "pageMetrics", {});
    region = { x: 0, y: m.scrollY, width: m.innerWidth, height: m.innerHeight };
  } else if (params.fullPage) {
    const m = await callEngine(tab.id, "pageMetrics", {});
    region = { x: 0, y: 0, width: m.innerWidth, height: m.scrollHeight };
  } else {
    region = params.clip;
  }
  // A full page at device resolution is huge; default it to 1 image pixel per
  // CSS pixel. Elements and regions keep full sharpness.
  const scale = params.scale ?? (params.fullPage ? 1 : undefined);
  // And JPEG: a full page as PNG ran to 6.7 MB, as JPEG 2.4 MB.
  const format = params.format ?? (params.fullPage ? "jpeg" : "png");
  return { url: tab.url, format, ...(await captureRegion(tab, region, { scale, format })) };
}

async function dispatch(method, params) {
  // A session's own window: opened in the background, so an agent starting
  // work never pulls the user's window away or lands in the user's tab.
  // Muted unless the session asked for sound: an agent's page should never
  // start playing at the person beside it. A session with a viewport gets a
  // popup-type window, the kind Chrome lets go narrower than 500px.
  if (method.startsWith("net.")) return await netDispatch(method, params);
  if (method === "engine.openSessionWindow") {
    const like = await chrome.windows.getLastFocused().catch(() => null);
    const win = await chrome.windows.create({
      url: params.url || "about:blank",
      focused: false,
      ...(params.viewport
        ? { type: "popup", width: Math.max(params.viewport.width, 100), height: params.viewport.height + 90 }
        : like?.width ? { width: like.width, height: like.height } : {}),
    });
    const tab = win.tabs?.[0];
    if (tab && !params.sound) await chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
    return { tabId: tab?.id, windowId: win.id, type: win.type };
  }
  // Bring a session's window to the front. The browser's own API, no OS
  // permission: needed before input posted by the operating system, which
  // macOS delivers to the frontmost window only.
  if (method === "engine.focusWindow") {
    const t = await tabFor(params);
    await chrome.tabs.update(t.id, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    await sleep(250);
    return { focused: true, windowId: t.windowId, tabId: t.id };
  }
  if (method === "engine.setSound") {
    await chrome.tabs.update(params.tabId, { muted: !params.sound });
    return { muted: !params.sound };
  }
  // Popups a page opens late (after a fetch, from a timer) are blocked unless
  // the host is allowed — the same per-site switch a person would flip.
  if (method === "engine.allowPopups") {
    const t = await tabFor(params);
    const u = new URL(t.url);
    const pattern = `${u.protocol}//${u.hostname}/*`;
    const setting = params.allow === false ? "block" : "allow";
    await chrome.contentSettings.popups.set({ primaryPattern: pattern, setting });
    return { popups: setting, pattern };
  }
  if (method === "engine.setViewport") return await setViewport(await tabFor(params), params);
  if (method === "engine.toPopupWindow") {
    const t = await tabFor(params);
    const win = await chrome.windows.create({ tabId: t.id, type: "popup", focused: false });
    return { windowId: win.id };
  }
  if (method === "engine.mobile") return await setMobile(await tabFor(params), params);
  if (method === "engine.closeWindow") {
    await chrome.windows.remove(params.windowId).catch(() => {});
    return { closed: true };
  }
  // engine.navigate runs from the SW (chrome.tabs API) so it works regardless
  // of whether a content script can be injected into the current tab. With a
  // tabId it drives that tab and nothing else; without one (the legacy
  // session) it drives the focused tab, or opens one.
  if (method === "engine.navigate") {
    if (params.url) {
      if (params.tabId != null) {
        const t = await tabFor(params);
        await chrome.tabs.update(t.id, { url: params.url });
        return { navigating: true, to: params.url, tabId: t.id, mode: "session_tab" };
      }
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
    const tabForNav = await tabFor(params);
    if (params.action === "reload") {
      await chrome.tabs.reload(tabForNav.id);
      return { navigating: true, to: "reload", tabId: tabForNav.id };
    }
    if (params.action !== "back" && params.action !== "forward")
      throw new Error("navigate: need url or back/forward/reload");
    // Go through the page's own history.back()/forward(). chrome.tabs.goBack
    // is the browser's Back button, and Chrome's Back button skips entries the
    // user left without a gesture — which is every page this tool clicks away
    // from. It went back two pages, or refused with "Cannot find a next page
    // in history." when every earlier entry was skippable.
    try {
      const r = await callEngine(tabForNav.id, "navigate", { action: params.action });
      if (r && r.error) throw new Error(r.error);
      return { navigating: true, to: params.action, tabId: tabForNav.id, via: "page", ...r };
    } catch (e) {
      const msg = String(e.message || e);
      // A port that closed as the page unloaded means the navigation started.
      if (/PORT_CLOSED_AFTER_ACTION/.test(msg))
        return { navigating: true, to: params.action, tabId: tabForNav.id, via: "page" };
      // Fall back to the browser's own Back only when the page call never ran
      // (no content script: chrome:// pages, PDFs). After any other failure
      // the page may already be navigating, and a second Back would skip a page.
      if (!/Receiving end does not exist|Could not establish connection|Cannot access/.test(msg)) throw e;
      try {
        if (params.action === "back") await chrome.tabs.goBack(tabForNav.id);
        else await chrome.tabs.goForward(tabForNav.id);
      } catch (browserErr) {
        throw new Error(`${params.action} failed in the page (${msg}) and in the browser (${browserErr.message || browserErr})`);
      }
      return { navigating: true, to: params.action, tabId: tabForNav.id, via: "browser" };
    }
  }
  // Tabs. The server decides which of these a caller may touch (its own);
  // this only does what it is told. "switch" brings a tab to the front of its
  // own window, and focuses that window only when asked (legacy behaviour).
  if (method === "engine.tabs") {
    let focusedWindow = false;
    let created;
    if (params.action === "switch" || params.action === "close") {
      const target = await chrome.tabs.get(params.tabId).catch(() => null);
      if (!target) throw tagged("TAB_GONE", `NO_SUCH_TAB: no tab ${params.tabId}; list the tabs first`, { tabId: params.tabId });
      if (params.action === "close") await chrome.tabs.remove(params.tabId);
      else {
        await chrome.tabs.update(params.tabId, { active: true });
        if (params.focusWindow) {
          const current = await activeTab().catch(() => null);
          if (current?.id !== params.tabId) {
            await chrome.windows.update(target.windowId, { focused: true });
            focusedWindow = true;
          }
        }
      }
    } else if (params.action === "new") {
      created = await chrome.tabs.create({
        url: params.url || "about:blank",
        active: true,
        ...(params.windowId != null ? { windowId: params.windowId } : {}),
      });
    }
    const active = await activeTab().catch(() => null);
    const all = await chrome.tabs.query({});
    return {
      tabs: all.map((t) => ({ tabId: t.id, url: t.url, title: t.title, active: t.id === active?.id, frontOfWindow: t.active, windowId: t.windowId, ...(t.mutedInfo?.muted ? { muted: true } : {}) })),
      activeTabId: active?.id,
      ...(created ? { createdTabId: created.id } : {}),
      ...(focusedWindow ? { focusedWindow } : {}),
    };
  }
  if (method === "engine.openedFrom") {
    return { opened: OPENED.filter((o) => o.openerTabId === params.tabId && o.ts >= (params.since || 0)) };
  }
  if (method === "engine.waitForNavigation") return await waitForNavigation(params);
  if (method === "engine.navHistory")
    return { navigations: NAV_LOG.filter((n) => params.tabId == null || n.tabId === params.tabId).slice(-25) };

  const tab = await tabFor(params);
  if (method === "engine.ping") {
    const pong = await callEngine(tab.id, "ping", params).catch((e) => ({
      error: String(e.message || e),
    }));
    // `status` ("loading" | "complete") is the honest signal that a click
    // already started something — a pending navigation hasn't changed the URL
    // yet, so without it a successful click looks identical to a dead one.
    return {
      sw: "ok",
      tab: { id: tab.id, url: tab.url, title: tab.title, status: tab.status, windowId: tab.windowId, navCount: NAV_COUNT.get(tab.id) || 0 },
      engine: pong,
    };
  }
  if (method === "engine.observe") {
    const snap = await callEngine(tab.id, "observe", params);
    if (snap && (snap.needsScreenshot || snap.needsHuman?.reason === "captcha")) {
      try {
        await showTab(tab);
        snap.screenshot = await captureViewport(tab.windowId);
      } catch (e) {
        snap.screenshotError = String(e.message || e);
      }
      if (snap.needsScreenshot) await callEngine(tab.id, "clearMarks", {}).catch(() => {});
      delete snap.needsScreenshot;
    }
    return snap;
  }
  if (method === "engine.act") {
    // A drag hands the pointer to whatever element captures it; the page's
    // setPointerCapture refuses a synthetic pointer unless shimmed first.
    if (params.action === "drag" || params.action === "pointer") await injectMain(tab.id, pointerCaptureShim);
    const r = await callEngine(tab.id, "act", params);
    if (r?.passwordField) rememberSecret(params.value);
    return r;
  }
  if (method === "engine.robustClick") return await robustClick(tab.id, params);
  if (method === "engine.screenshot") return await screenshot(tab, params);
  if (method === "engine.captureViewport") {
    await showTab(tab);
    return { screenshot: await captureViewport(tab.windowId), url: tab.url };
  }
  if (method === "engine.eval") return await evalInPage(tab.id, params);
  if (method === "engine.diagnostics") {
    const since = params.since || 0;
    const page = await callEngine(tab.id, "diagnostics", { since }).catch(() => ({ console: [], media: [] }));
    return { network: await netFailures(tab.id, since), ...page };
  }
  // Everything else is a content-engine method of the same name.
  const ENGINE = {
    "engine.locate": "locate", "engine.scroll": "scrollPage", "engine.waitFor": "waitFor",
    "engine.waitForStable": "waitForStable", "engine.settle": "settle", "engine.pageState": "pageState",
    "engine.inspect": "inspect", "engine.detectWall": "detectWall",
    "engine.pageMetrics": "pageMetrics", "engine.hoverState": "hoverState",
  };
  if (ENGINE[method]) return await callEngine(tab.id, ENGINE[method], params);
  // Anything else named engine.* goes to the content engine as-is; it answers
  // "unknown engine method" for names it does not have, so a new engine
  // method needs no entry here.
  if (method.startsWith("engine.")) return await callEngine(tab.id, method.slice("engine.".length), params);
  throw new Error(`unknown method: ${method}`);
}

// Run a function in the page's own JS world. Best effort: a page the
// extension cannot script (chrome://, the web store) simply goes without.
async function injectMain(tabId, func) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func }).catch(() => {});
}

// setPointerCapture throws for a pointer the browser does not know — which is
// every synthetic one — and a scrubber whose pointerdown handler throws never
// starts dragging. Let the call succeed for synthetic pointers, and mark the
// element that asked so the engine can send the moves to it, as the browser
// would for a captured pointer.
function pointerCaptureShim() {
  if (window.__abPointerShim) return;
  window.__abPointerShim = true;
  const proto = Element.prototype;
  const set = proto.setPointerCapture;
  const release = proto.releasePointerCapture;
  const has = proto.hasPointerCapture;
  const synthetic = new WeakSet();
  proto.setPointerCapture = function (id) {
    try {
      return set.call(this, id);
    } catch (e) {
      if (!document.documentElement.hasAttribute("data-ab-gesture")) throw e;
      document.querySelectorAll("[data-ab-captured]").forEach((n) => n.removeAttribute("data-ab-captured"));
      this.setAttribute("data-ab-captured", "");
      synthetic.add(this);
    }
  };
  proto.releasePointerCapture = function (id) {
    if (synthetic.has(this)) {
      synthetic.delete(this);
      this.removeAttribute("data-ab-captured");
      return;
    }
    return release.call(this, id);
  };
  proto.hasPointerCapture = function (id) {
    return synthetic.has(this) || has.call(this, id);
  };
}

// browser_eval: an expression evaluated in the page's own world, its value
// returned as JSON. The page's Content-Security-Policy applies — a page that
// forbids eval gets EVAL_BLOCKED_BY_CSP, not a silent nothing.
async function evalInPage(tabId, params) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [params.expression, params.awaitPromise !== false, Math.min(params.timeoutMs || 5000, 25000)],
    func: async (expression, awaitPromise, timeoutMs) => {
      const describe = (n) =>
        n instanceof Element
          ? `<${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}${n.classList.length ? "." + [...n.classList].slice(0, 3).join(".") : ""}>`
          : String(n);
      const seen = new WeakSet();
      const replacer = (_k, v) => {
        if (v instanceof Node) return describe(v);
        if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
        if (typeof v === "bigint") return String(v);
        if (v && typeof v === "object") {
          if (seen.has(v)) return "[circular]";
          seen.add(v);
        }
        return v;
      };
      let value;
      try {
        value = (0, eval)(expression);
        if (awaitPromise && value && typeof value.then === "function")
          value = await Promise.race([
            value,
            new Promise((_, rej) => setTimeout(() => rej(new Error(`the promise did not settle within ${timeoutMs}ms`)), timeoutMs)),
          ]);
      } catch (e) {
        const msg = String((e && e.message) || e);
        return { error: msg, csp: /unsafe-eval|Content Security Policy|EvalError/i.test(msg) || (e && e.name === "EvalError") };
      }
      let json;
      try {
        json = JSON.stringify(value === undefined ? null : value, replacer);
      } catch (e) {
        return { error: `the value could not be turned into JSON: ${(e && e.message) || e}` };
      }
      const max = 20000;
      return json.length > max ? { json: json.slice(0, max), truncated: true, totalChars: json.length } : { json };
    },
  });
  const r = res?.result;
  if (!r) throw tagged("EVAL_FAILED", "EVAL_FAILED: the page returned nothing (it may have navigated)");
  if (r.error)
    throw tagged(r.csp ? "EVAL_BLOCKED_BY_CSP" : "EVAL_FAILED", `${r.csp ? "EVAL_BLOCKED_BY_CSP" : "EVAL_FAILED"}: ${r.error}`);
  let value;
  try {
    value = r.truncated ? r.json : JSON.parse(r.json);
  } catch {
    value = r.json;
  }
  return { value, ...(r.truncated ? { truncated: true, totalChars: r.totalChars } : {}) };
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
  const report = (kind, message, answer) =>
    window.dispatchEvent(
      new CustomEvent("ab-dialog", { detail: { kind, message: String(message ?? ""), answer, ts: Date.now() } }),
    );
  // The agent's choice for this action, set by the content engine on <html>
  // before it acts. Default accept: the agent clicked the thing that asks.
  const dismiss = () => document.documentElement.getAttribute("data-ab-dialog") === "dismiss";
  window.alert = (m) => report("alert", m, "ok");
  window.confirm = (m) => {
    const ok = !dismiss();
    report("confirm", m, ok ? "ok" : "cancel");
    return ok;
  };
  window.prompt = (m, d) => {
    if (dismiss()) return report("prompt", m, null), null;
    const text = document.documentElement.getAttribute("data-ab-dialog-text") ?? d ?? "";
    report("prompt", m, text);
    return text;
  };
  window.addEventListener("beforeunload", (e) => {
    e.stopImmediatePropagation();
    delete e.returnValue;
  }, true);
  // A page can ask the browser to save a credential (credentials.store) with
  // no prompt at all. In this persistent profile that would keep a test
  // password for good; refuse it and say so in the action's result.
  try {
    if (navigator.credentials && typeof navigator.credentials.store === "function") {
      navigator.credentials.store = (cred) => {
        window.dispatchEvent(new CustomEvent("ab-credential", {
          detail: { kind: "credentials.store", type: String(cred?.type ?? ""), id: String(cred?.id ?? ""), ts: Date.now() },
        }));
        return Promise.resolve(undefined);
      };
    }
  } catch {}
}

chrome.webNavigation.onCommitted.addListener((d) => {
  // A mobile-emulated tab keeps its page-world patches on every load.
  if (MOBILE.has(d.tabId))
    chrome.scripting.executeScript({ target: { tabId: d.tabId, frameIds: [d.frameId] }, world: "MAIN", injectImmediately: true, func: mobilePatch, args: [MOBILE.get(d.tabId).ua] }).catch(() => {});
  if (d.frameId !== 0) return;
  recordNav(d.url, d.tabId); // so redirect-based flows can be inspected after the fact
  NAV_COUNT.set(d.tabId, (NAV_COUNT.get(d.tabId) || 0) + 1);
  ensureConnected(); // navigation wakes the SW — opportunistically (re)connect
  chrome.scripting
    .executeScript({ target: { tabId: d.tabId }, world: "MAIN", func: dialogTamer })
    .catch(() => {});
  // Private-network dev servers cannot be written as match patterns; hook
  // them here instead (a little later than document_start).
  let host = "";
  try { host = new URL(d.url).hostname; } catch {}
  if (PRIVATE_IP.test(host))
    chrome.scripting
      .executeScript({ target: { tabId: d.tabId }, world: "MAIN", files: ["src/content/diag-hook.js"] })
      .catch(() => {});
});
// A same-document route change (pushState, a hash route) is a navigation too.
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId !== 0) return;
  recordNav(d.url, d.tabId);
  NAV_COUNT.set(d.tabId, (NAV_COUNT.get(d.tabId) || 0) + 1);
});
chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => {
  if (d.frameId !== 0) return;
  recordNav(d.url, d.tabId);
  NAV_COUNT.set(d.tabId, (NAV_COUNT.get(d.tabId) || 0) + 1);
});

// Backstop: chrome.alarms survives SW suspension and wakes it to reconnect.
chrome.alarms.create("ab-reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "ab-reconnect") ensureConnected();
  if (a.name === "ab-net-prune") netPrune().catch(() => {});
});
chrome.runtime.onStartup.addListener(ensureConnected);
chrome.runtime.onInstalled.addListener(ensureConnected);

// Chrome keeps running an unpacked extension's cached service worker after
// sw.js changes on disk — across browser restarts, and even past a manifest
// version bump — until someone presses Reload on chrome://extensions. The
// worker also keeps the secret and port it imported when it was loaded, so
// after an update the halves silently disagree (this worker sat on a
// September build for a month; a test browser kept dialling last run's port).
// On every start and every reconnect, compare the code running, and every
// file the extension is made of, with what is on disk; reload once if they differ.
const EXTENSION_FILES = [
  "manifest.json", "src/sw.js", "src/generated-secret.js", "src/content/engine.js", "src/content/diag-hook.js",
  "src/content/net-relay.js", "src/main/net-hook.js", "src/lib/netstore.js", "src/lib/redact.js", "src/lib/net-merge.js",
];
async function diskHash() {
  let h = 5381;
  for (const f of EXTENSION_FILES) {
    const text = await (await fetch(chrome.runtime.getURL(f), { cache: "no-store" })).text().catch(() => "");
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return h;
}
async function reloadIfStale() {
  try {
    const sw = await (await fetch(chrome.runtime.getURL("src/sw.js"), { cache: "no-store" })).text();
    const running = [connect, dispatch, callEngine, screenshot, screenshotElement, captureRegion, robustClick, evalInPage, applyConfig, setViewport, setMobile, mobilePatch, diskHash, reloadIfStale, netIntake, netQuery, netDispatch, applyNetConfig];
    const codeStale = !running.every((fn) => sw.includes(String(fn)));
    const disk = await diskHash();
    const { loadedFor, reloadedFor } = await chrome.storage.local.get(["loadedFor", "reloadedFor"]);
    if (!codeStale && loadedFor === disk) return false;
    // First start of this version of the check: take what is loaded as current.
    if (!codeStale && loadedFor === undefined) {
      await chrome.storage.local.set({ loadedFor: disk });
      return false;
    }
    // Remember which disk version we reloaded for, in storage that survives
    // the reload, so a reload that doesn't take can never loop.
    if (reloadedFor === disk) return false;
    await chrome.storage.local.set({ loadedFor: disk, reloadedFor: disk });
    console.log("[agent-bridge] the extension on disk differs from the one running — reloading");
    chrome.runtime.reload();
    return true;
  } catch (e) {
    console.warn("[agent-bridge] stale-worker check failed", e);
    return false;
  }
}

// Check before connecting, so a stale worker never takes calls it is about to
// drop by reloading.
reloadIfStale().then((reloading) => reloading || ensureConnected());
