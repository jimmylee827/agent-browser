// Page world (MAIN), at document_start: records what the page's own fetch,
// XMLHttpRequest, WebSocket and EventSource send and receive. chrome.webRequest
// sees headers but never bodies, so this is the only way to read the data a
// page loaded — without CDP.
//
// Two rules, in this order:
//   1. The page must behave exactly as without us. fetch returns the very
//      promise the browser made; we clone a response before anyone reads it
//      and read only our copy; nothing we do can throw into the page.
//   2. The page must not be able to tell. Each patched function is a Proxy of
//      the original (same name, length, no prototype, not a constructor), and
//      Function.prototype.toString answers for it as for the original. State
//      lives in closures and WeakMaps, never on window or on the objects.
//
// It runs before any page script, so the originals captured here are the
// browser's own, whatever the page patches later.
(() => {
  const W = window;
  const apply = Reflect.apply;
  const construct = Reflect.construct;
  const FnProto = Function.prototype;
  const nativeToString = FnProto.toString;
  const WM = WeakMap;
  const wmGet = WM.prototype.get;
  const wmSet = WM.prototype.set;
  const stringify = JSON.stringify;
  const now = Date.now;
  const qmt = W.queueMicrotask;
  const setT = W.setTimeout;
  const clearT = W.clearTimeout;
  const P = Promise;
  const then = P.prototype.then;
  const race = P.race;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const addEL = EventTarget.prototype.addEventListener;
  const removeEL = EventTarget.prototype.removeEventListener;
  const CE = CustomEvent;
  const URLc = URL;
  const doc = document;
  const loc = location;
  // Installed after the page started (the extension was updated under an open
  // tab, and re-armed it): what came before is not recorded, so say so.
  const late = doc.readyState !== "loading";

  const get = (m, k) => apply(wmGet, m, [k]);
  const put = (m, k, v) => apply(wmSet, m, [k, v]);
  const on = (t, type, fn) => apply(addEL, t, [type, fn]);

  // Same-origin frames only by default: cross-origin ones are mostly ads and
  // fraud scripts that fingerprint native functions hardest.
  try {
    if (W !== W.top && W.top.location.origin !== loc.origin) return;
  } catch {
    return;
  }

  // ---- disguise ------------------------------------------------------------
  const originals = new WM();
  const tsProxy = new Proxy(nativeToString, {
    apply(target, self, args) {
      const orig = get(originals, self);
      return apply(target, orig === undefined ? self : orig, args);
    },
  });
  put(originals, tsProxy, nativeToString);
  FnProto.toString = tsProxy;

  /** Our own frames out of a stack that is about to reach the page. */
  const scrub = (e) => {
    try {
      if (e && typeof e.stack === "string" && e.stack.includes("chrome-extension://")) {
        e.stack = e.stack.split("\n").filter((l) => !l.includes("chrome-extension://")).join("\n");
      }
    } catch {}
    return e;
  };
  const disguise = (orig, handler) => {
    const p = new Proxy(orig, handler);
    put(originals, p, orig);
    return p;
  };

  // ---- config (pushed by the relay; safe defaults until then) --------------
  const cfg = {
    enabled: true,
    maxBodyChars: 65536,
    skipBodyTypes: ["image/", "font/", "video/", "audio/", "application/octet-stream", "application/wasm", "application/pdf", "text/css", "javascript", "text/event-stream"],
    blockedDomains: [],
    captureWebSockets: true,
    maxFramesPerSocket: 200,
    maxFrameChars: 2000,
  };
  const blocked = (url) => {
    try {
      const h = new URLc(url, loc.href).hostname;
      return cfg.blockedDomains.some((d) => h === d || h.endsWith("." + d));
    } catch {
      return false;
    }
  };
  const skipType = (ct) => {
    const c = String(ct || "").toLowerCase();
    return cfg.skipBodyTypes.some((t) => c.includes(t));
  };
  const abs = (u) => {
    try {
      return new URLc(String(u), loc.href).href;
    } catch {
      return String(u);
    }
  };

  // ---- channel to the extension --------------------------------------------
  // A fixed name is used once, at document_start before any page script, to
  // learn a per-document secret name from the relay (isolated world). Records
  // then travel as CustomEvents only a listener knowing that name receives —
  // postMessage would hand every body to every message listener on the page.
  let channel = null;
  const queue = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (!channel || !queue.length) return;
    const batch = queue.splice(0, queue.length);
    try {
      apply(dispatch, doc, [new CE(channel, { detail: stringify(batch) })]);
    } catch {}
  };
  const emit = (rec) => {
    if (!cfg.enabled) return;
    rec.ts ??= now();
    if (W !== W.top) rec.frameUrl = loc.href;
    if (late) rec.late = true;
    queue.push(rec);
    if (queue.length > 200) queue.shift(); // no relay yet: keep the newest
    if (channel && !scheduled) {
      scheduled = true;
      qmt(flush);
    }
  };
  const HELLO = "ab-net-hello";
  const onHello = (e) => {
    if (channel || typeof e.detail !== "string" || e.detail === "hook") return;
    let msg;
    try {
      msg = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (!msg || typeof msg.channel !== "string") return;
    channel = msg.channel;
    apply(removeEL, doc, [HELLO, onHello]);
    on(doc, channel + ":cfg", (c) => {
      try {
        Object.assign(cfg, JSON.parse(c.detail));
      } catch {}
    });
    if (msg.config) Object.assign(cfg, msg.config);
    // Tell the relay we are here even before there is traffic.
    try {
      apply(dispatch, doc, [new CE(channel, { detail: stringify([{ kind: "hello", late }]) })]);
    } catch {}
    flush();
  };
  on(doc, HELLO, onHello);
  try {
    apply(dispatch, doc, [new CE(HELLO, { detail: "hook" })]);
  } catch {}
  // No relay by the time the page has parsed: stop listening for one, so a
  // page script cannot hand us a channel of its own.
  on(doc, "DOMContentLoaded", () => apply(removeEL, doc, [HELLO, onHello]));

  // ---- bodies --------------------------------------------------------------
  const clip = (s, max) => (s.length > max ? [s.slice(0, max), true] : [s, false]);

  /** A request body as text: what was sent, or what kind of thing it was. */
  const bodyText = (b) => {
    try {
      if (b == null) return undefined;
      if (typeof b === "string") return clip(b, cfg.maxBodyChars)[0];
      if (b instanceof URLSearchParams) return clip(b.toString(), cfg.maxBodyChars)[0];
      if (b instanceof FormData) {
        const parts = [];
        b.forEach((v, k) => parts.push(`${encodeURIComponent(k)}=${typeof v === "string" ? encodeURIComponent(v) : `[file ${v.name || ""} ${v.size} bytes]`}`));
        return clip(parts.join("&"), cfg.maxBodyChars)[0];
      }
      if (b instanceof Blob) return `[blob ${b.type || ""} ${b.size} bytes]`;
      if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return `[binary ${b.byteLength} bytes]`;
      return "[stream]";
    } catch {
      return undefined;
    }
  };

  const Reader = ReadableStreamDefaultReader.prototype;
  const rRead = Reader.read;
  const rCancel = Reader.cancel;
  const getReader = ReadableStream.prototype.getReader;
  const TD = TextDecoder;
  const decode = TD.prototype.decode;
  const clone = Response.prototype.clone;
  const hGet = Headers.prototype.get;

  /** Read our copy of a body, at most `max` characters, at most 30s. */
  async function readCapped(stream, max) {
    if (!stream) return { text: "", truncated: false };
    const reader = apply(getReader, stream, []);
    const dec = new TD();
    let text = "";
    let truncated = false;
    let timer;
    const timeout = new P((r) => (timer = apply(setT, W, [() => r("timeout"), 30000])));
    try {
      for (;;) {
        const step = await apply(race, P, [[apply(rRead, reader, []), timeout]]);
        if (step === "timeout") {
          truncated = "timeout";
          break;
        }
        if (step.done) break;
        text += apply(decode, dec, [step.value, { stream: true }]);
        if (text.length >= max) {
          text = text.slice(0, max);
          truncated = true;
          break;
        }
      }
    } finally {
      apply(clearT, W, [timer]);
      // Cancelling our branch of the clone leaves the page's branch alone.
      try {
        apply(rCancel, reader, []).catch(() => {});
      } catch {}
    }
    return { text, truncated };
  }

  // ---- fetch ---------------------------------------------------------------
  function observeFetch(p, args) {
    const t0 = now();
    const input = args[0];
    const init = args[1] || {};
    let url;
    let method = "GET";
    if (input && typeof input === "object" && "url" in input && "method" in input) {
      url = input.url;
      method = input.method;
    } else url = abs(input);
    if (init.method) method = String(init.method);
    method = method.toUpperCase();
    const requestBody = blocked(url) ? undefined : bodyText(init.body);
    apply(then, p, [
      (res) => {
        try {
          const ct = apply(hGet, res.headers, ["content-type"]) || "";
          const rec = { kind: "page", via: "fetch", ts: t0, method, url: res.url || url, status: res.status, statusText: res.statusText, contentType: ct, requestBody };
          if (res.type === "opaque" || res.type === "opaqueredirect") return emit({ ...rec, tsEnd: now(), skipped: "opaque" });
          if (blocked(rec.url)) return emit({ ...rec, requestBody: undefined, tsEnd: now(), skipped: "blocked" });
          if (skipType(ct)) return emit({ ...rec, tsEnd: now(), skipped: "type" });
          let copy;
          try {
            copy = apply(clone, res, []);
          } catch {
            return emit({ ...rec, tsEnd: now(), skipped: "body already read" });
          }
          readCapped(copy.body, cfg.maxBodyChars).then(
            ({ text, truncated }) => emit({ ...rec, tsEnd: now(), body: text, bodyChars: text.length, ...(truncated ? { truncated } : {}) }),
            () => emit({ ...rec, tsEnd: now(), skipped: "body unreadable" }),
          );
        } catch {}
      },
      (err) => {
        try {
          emit({ kind: "fault", via: "fetch", ts: t0, tsEnd: now(), method, url, error: String((err && err.message) || err) });
        } catch {}
      },
    ]);
  }

  if (typeof W.fetch === "function") {
    W.fetch = disguise(W.fetch, {
      apply(target, self, args) {
        let p;
        try {
          p = apply(target, self, args);
        } catch (e) {
          throw scrub(e);
        }
        try {
          observeFetch(p, args);
        } catch {}
        return p;
      },
    });
  }

  // ---- XMLHttpRequest ------------------------------------------------------
  const XHR = W.XMLHttpRequest;
  if (XHR) {
    const X = XHR.prototype;
    const meta = new WM();
    const status = Object.getOwnPropertyDescriptor(X, "status").get;
    const responseURL = Object.getOwnPropertyDescriptor(X, "responseURL").get;
    const responseType = Object.getOwnPropertyDescriptor(X, "responseType").get;
    const responseText = Object.getOwnPropertyDescriptor(X, "responseText").get;
    const response = Object.getOwnPropertyDescriptor(X, "response").get;
    const statusText = Object.getOwnPropertyDescriptor(X, "statusText").get;
    const getHeader = X.getResponseHeader;
    const onEnd = function () {
      const xhr = this;
      try {
        const m = get(meta, xhr);
        if (!m) return;
        const st = apply(status, xhr, []);
        const url = apply(responseURL, xhr, []) || m.url;
        if (st === 0) return emit({ kind: "fault", via: "xhr", ts: m.ts, tsEnd: now(), method: m.method, url, error: "network error, aborted or timed out" });
        const ct = apply(getHeader, xhr, ["content-type"]) || "";
        const rec = { kind: "page", via: "xhr", ts: m.ts, tsEnd: now(), method: m.method, url, status: st, statusText: apply(statusText, xhr, []), contentType: ct, requestBody: m.requestBody };
        if (blocked(url)) return emit({ ...rec, requestBody: undefined, skipped: "blocked" });
        if (skipType(ct)) return emit({ ...rec, skipped: "type" });
        const rt = apply(responseType, xhr, []);
        let text;
        if (rt === "" || rt === "text") text = apply(responseText, xhr, []);
        else if (rt === "json") text = stringify(apply(response, xhr, []));
        else return emit({ ...rec, skipped: `responseType ${rt}` });
        const [body, truncated] = clip(text || "", cfg.maxBodyChars);
        emit({ ...rec, body, bodyChars: body.length, ...(truncated ? { truncated } : {}) });
      } catch {}
    };
    X.open = disguise(X.open, {
      apply(target, self, args) {
        try {
          put(meta, self, { method: String(args[0] || "GET").toUpperCase(), url: abs(args[1]) });
        } catch {}
        try {
          return apply(target, self, args);
        } catch (e) {
          throw scrub(e);
        }
      },
    });
    X.send = disguise(X.send, {
      apply(target, self, args) {
        try {
          const m = get(meta, self);
          if (m && !m.armed) {
            m.armed = true;
            m.ts = now();
            if (!blocked(m.url)) m.requestBody = bodyText(args[0]);
            on(self, "loadend", onEnd);
          }
        } catch {}
        try {
          return apply(target, self, args);
        } catch (e) {
          throw scrub(e);
        }
      },
    });
  }

  // ---- WebSocket and EventSource -------------------------------------------
  let socketSeq = 0;
  const sockets = new WM();
  // Across every socket of this document: a chatty feed must not flood the store.
  let windowStart = 0;
  let inWindow = 0;
  const rateOk = () => {
    const t = now();
    if (t - windowStart > 1000) {
      windowStart = t;
      inWindow = 0;
    }
    return ++inWindow <= 50;
  };
  const frame = (sock, dir, data) => {
    const m = get(sockets, sock);
    if (!m || !cfg.captureWebSockets) return;
    if (m.count >= cfg.maxFramesPerSocket || !rateOk()) {
      m.dropped++;
      return;
    }
    m.count++;
    const rec = { kind: m.kind === "sse" ? "sse-event" : "ws-frame", socketId: m.id, dir };
    if (typeof data === "string") {
      const [d, truncated] = clip(data, cfg.maxFrameChars);
      rec.data = d;
      if (truncated) rec.truncated = true;
    } else {
      rec.binary = true;
      rec.size = data?.byteLength ?? data?.size ?? 0;
    }
    emit(rec);
  };

  const WS = W.WebSocket;
  if (WS) {
    const wsSend = WS.prototype.send;
    const wsUrl = Object.getOwnPropertyDescriptor(WS.prototype, "url").get;
    const WSP = disguise(WS, {
      construct(target, args, newTarget) {
        let ws;
        try {
          ws = construct(target, args, newTarget);
        } catch (e) {
          throw scrub(e);
        }
        try {
          const url = apply(wsUrl, ws, []);
          if (cfg.captureWebSockets && !blocked(url)) {
            const m = { id: ++socketSeq, kind: "ws", count: 0, dropped: 0 };
            put(sockets, ws, m);
            emit({ kind: "ws-open", via: "ws", socketId: m.id, method: "GET", url });
            on(ws, "message", (e) => frame(ws, "in", e.data));
            on(ws, "close", (e) => emit({ kind: "ws-close", socketId: m.id, code: e.code, reason: e.reason, dropped: m.dropped }));
          }
        } catch {}
        return ws;
      },
    });
    WS.prototype.send = disguise(wsSend, {
      apply(target, self, args) {
        try {
          frame(self, "out", args[0]);
        } catch {}
        try {
          return apply(target, self, args);
        } catch (e) {
          throw scrub(e);
        }
      },
    });
    // `ws.constructor === WebSocket` must stay true.
    WS.prototype.constructor = WSP;
    W.WebSocket = WSP;
  }

  const ES = W.EventSource;
  if (ES) {
    const esUrl = Object.getOwnPropertyDescriptor(ES.prototype, "url").get;
    const ESP = disguise(ES, {
      construct(target, args, newTarget) {
        let es;
        try {
          es = construct(target, args, newTarget);
        } catch (e) {
          throw scrub(e);
        }
        try {
          const url = apply(esUrl, es, []);
          if (cfg.captureWebSockets && !blocked(url)) {
            const m = { id: ++socketSeq, kind: "sse", count: 0, dropped: 0 };
            put(sockets, es, m);
            emit({ kind: "sse-open", via: "sse", socketId: m.id, method: "GET", url });
            // Only unnamed events: seeing `event: foo` would mean patching
            // addEventListener for every object on the page.
            on(es, "message", (e) => frame(es, "in", e.data));
            on(es, "error", () => {
              if (es.readyState === 2) emit({ kind: "ws-close", socketId: m.id, dropped: m.dropped });
            });
          }
        } catch {}
        return es;
      },
    });
    ES.prototype.constructor = ESP;
    W.EventSource = ESP;
  }
})();
