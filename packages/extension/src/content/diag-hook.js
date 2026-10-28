// Page-world diagnostics hook — development hosts only (see applyConfig in
// sw.js). Reports console errors and warnings, uncaught exceptions and
// unhandled rejections to the content engine. Wrapping console is something a
// determined page could still notice, so it is never injected on the open web.
//
// It talks the way the other page-world scripts do: a per-document channel
// from the relay, which keeps the records for the engine. Before the channel
// is known (it runs at document_start), records wait here.
(() => {
  const apply = Reflect.apply;
  const FnProto = Function.prototype;
  const WM = WeakMap;
  const wmGet = WM.prototype.get;
  const wmSet = WM.prototype.set;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const addEL = EventTarget.prototype.addEventListener;
  const removeEL = EventTarget.prototype.removeEventListener;
  const CE = CustomEvent;
  const stringify = JSON.stringify;
  const doc = document;

  // The console wrappers read as native, like every other patched function.
  const originals = new WM();
  const prevToString = FnProto.toString;
  const tsProxy = new Proxy(prevToString, {
    apply(target, self, args) {
      const orig = apply(wmGet, originals, [self]);
      return apply(target, orig === undefined ? self : orig, args);
    },
  });
  apply(wmSet, originals, [tsProxy, prevToString]);
  FnProto.toString = tsProxy;

  let channel = null;
  const pending = [];
  const MAX = 200;
  const clip = (s) => String(s).slice(0, 500);
  const text = (args) =>
    args
      .map((a) => {
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        if (typeof a === "object") {
          try {
            return stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(" ");
  const emit = (entry, wrapped) => {
    const rec = wrapped ?? { kind: "diag", entry: { ...entry, ts: Date.now() } };
    if (!channel) {
      pending.push(rec);
      if (pending.length > MAX) pending.shift();
      return;
    }
    try {
      apply(dispatch, doc, [new CE(channel, { detail: stringify([rec]) })]);
    } catch {}
  };
  const HELLO = "ab-net-hello";
  const onHello = (e) => {
    if (channel || typeof e.detail !== "string" || e.detail === "hook") return;
    try {
      channel = JSON.parse(e.detail).channel || null;
    } catch {}
    if (!channel) return;
    apply(removeEL, doc, [HELLO, onHello]);
    for (const rec of pending.splice(0)) emit(null, rec);
  };
  apply(addEL, doc, [HELLO, onHello]);
  try {
    apply(dispatch, doc, [new CE(HELLO, { detail: "hook" })]);
  } catch {}

  // Where in the page's code a console call came from: the first stack frame
  // outside this file.
  const source = () => {
    const lines = (new Error().stack || "").split("\n").slice(3);
    const m = lines.filter((l) => !l.includes("chrome-extension://")).map((l) => l.match(/(https?:\/\/[^\s)]+):(\d+):\d+/)).find(Boolean);
    return m ? `${m[1]}:${m[2]}` : undefined;
  };
  for (const level of ["error", "warn"]) {
    const orig = console[level];
    const p = new Proxy(orig, {
      apply(target, self, args) {
        try {
          emit({ kind: "console", level, text: clip(text(args)), source: source() });
        } catch {}
        return apply(target, self, args);
      },
    });
    apply(wmSet, originals, [p, orig]);
    console[level] = p;
  }
  apply(addEL, window, [
    "error",
    (e) => {
      // Resource load failures also arrive here (on the element, capturing);
      // the extension records those from the network side, with status codes.
      if (!(e instanceof ErrorEvent)) return;
      emit({ kind: "exception", level: "error", text: clip(e.message), source: e.filename ? `${e.filename}:${e.lineno}` : undefined });
    },
  ]);
  apply(addEL, window, [
    "unhandledrejection",
    (e) => {
      const r = e.reason;
      emit({ kind: "rejection", level: "error", text: clip(r instanceof Error ? `${r.name}: ${r.message}` : text([r])) });
    },
  ]);
})();
