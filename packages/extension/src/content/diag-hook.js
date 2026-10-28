// Page-world diagnostics hook — development hosts only (see applyConfig in
// sw.js). Reports console errors and warnings, uncaught exceptions and
// unhandled rejections to the content engine. It wraps console methods, which
// a page could notice, so it is never injected on the open web.
//
// It runs at document_start, before the engine listens (document_idle), so it
// keeps what it saw and replays it when the engine asks ("ab-diag-flush").
(() => {
  if (window.__abDiagHook) return;
  window.__abDiagHook = true;
  const buffer = [];
  const MAX = 200;
  const clip = (s) => String(s).slice(0, 500);
  const text = (args) =>
    args
      .map((a) => {
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        if (typeof a === "object") {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(" ");
  const emit = (entry) => {
    entry.ts = Date.now();
    buffer.push(entry);
    if (buffer.length > MAX) buffer.shift();
    window.dispatchEvent(new CustomEvent("ab-diag", { detail: entry }));
  };
  // Where in the page's code a console call came from: the first stack frame
  // outside this file.
  const source = () => {
    const lines = (new Error().stack || "").split("\n").slice(3);
    const m = lines.map((l) => l.match(/(https?:\/\/[^\s)]+):(\d+):\d+/)).find(Boolean);
    return m ? `${m[1]}:${m[2]}` : undefined;
  };
  for (const level of ["error", "warn"]) {
    const orig = console[level];
    console[level] = function (...args) {
      try {
        emit({ kind: "console", level, text: clip(text(args)), source: source() });
      } catch {}
      return orig.apply(this, args);
    };
  }
  window.addEventListener("error", (e) => {
    // Resource load failures also arrive here (on the element, capturing);
    // the extension records those from the network side, with status codes.
    if (!(e instanceof ErrorEvent)) return;
    emit({ kind: "exception", level: "error", text: clip(e.message), source: e.filename ? `${e.filename}:${e.lineno}` : undefined });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    emit({ kind: "rejection", level: "error", text: clip(r instanceof Error ? `${r.name}: ${r.message}` : text([r])) });
  });
  window.addEventListener("ab-diag-flush", () => {
    for (const entry of buffer) window.dispatchEvent(new CustomEvent("ab-diag", { detail: { ...entry, replay: true } }));
  });
})();
