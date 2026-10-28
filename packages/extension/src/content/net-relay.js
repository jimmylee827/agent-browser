// Isolated world, at document_start: the hub between the page-world scripts
// (main/page.js, main/net-hook.js, content/diag-hook.js) and the extension.
// It hands each of them the same per-document secret event name — the only
// way they talk, so a page hears nothing under a name it could know — and:
//   - passes network records on to the service worker, in batches;
//   - keeps dialog, credential and console records here, for the engine
//     (same world, same frame) to read from window.__abNetRelay.
//
// It is separate from engine.js because engine.js runs at document_idle, and
// what matters (a page's first API calls, a dialog on load) comes before. The
// page cannot see this world's globals, so window.__abNetRelay is ours alone.
(() => {
  // A relay left from before the extension reloaded cannot reach it any more
  // (its chrome.runtime is gone): replace it. A live one stays.
  try {
    if (window.__abNetRelay?.alive?.()) return;
  } catch {}
  const channel = "ab" + crypto.randomUUID().replace(/-/g, "");
  const state = (window.__abNetRelay = {
    channel,
    hooked: false,
    late: false,
    records: 0,
    dropped: 0,
    dialogs: [],
    credentials: [],
    diag: [],
    alive: () => {
      try {
        return !!chrome.runtime?.id;
      } catch {
        return false;
      }
    },
  });
  const HELLO = "ab-net-hello";
  let config = null;
  let topOnly = false;
  const out = [];
  let timer = null;

  // A sleeping or reloading service worker rejects asynchronously, and an
  // extension being updated throws synchronously. Neither may surface in a
  // tab that stays open for days.
  const tell = (records) => {
    try {
      chrome.runtime.sendMessage({ type: "ab-net", records }).catch(() => {
        state.dropped += records.length;
      });
    } catch {
      state.dropped += records.length;
    }
  };
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!out.length) return;
    tell(out.splice(0, out.length));
  };
  const schedule = () => {
    if (out.length >= 20) flush();
    else if (!timer) timer = setTimeout(flush, 250);
  };
  const keep = (list, rec, max) => {
    list.push(rec);
    if (list.length > max) list.shift();
  };

  document.addEventListener(channel, (e) => {
    let batch;
    try {
      batch = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (!Array.isArray(batch)) return;
    let net = 0;
    for (const r of batch) {
      if (!r || typeof r !== "object") continue;
      if (r.kind === "hello") {
        // The network hook is in this document (and whether it came late).
        state.hooked = true;
        state.late = !!r.late;
      } else if (r.kind === "dialog") keep(state.dialogs, r, 20);
      else if (r.kind === "credential") keep(state.credentials, r, 20);
      else if (r.kind === "diag") keep(state.diag, r, 200);
      else if (!(topOnly && window !== window.top)) {
        out.push(r);
        net++;
      }
    }
    state.records += net;
    if (net) schedule();
  });

  const netPart = ({ enabled, maxBodyChars, skipBodyTypes, blockedDomains, captureWebSockets, maxFramesPerSocket, maxFrameChars }) => ({
    enabled, maxBodyChars, skipBodyTypes, blockedDomains, captureWebSockets, maxFramesPerSocket, maxFrameChars,
  });
  const reply = () =>
    document.dispatchEvent(new CustomEvent(HELLO, { detail: JSON.stringify({ channel, config: config && netPart(config) }) }));
  // Whichever side runs second completes the exchange; every page-world
  // script that says hello gets the same channel.
  document.addEventListener(HELLO, (e) => {
    if (e.detail === "hook") reply();
  });
  reply();

  chrome.storage.local
    .get("netConfig")
    .then(({ netConfig }) => {
      if (!netConfig) return;
      config = netConfig;
      topOnly = netConfig.frames === "top";
      document.dispatchEvent(new CustomEvent(channel + ":cfg", { detail: JSON.stringify(netPart(netConfig)) }));
    })
    .catch(() => {});

  // The last batch of a page being left.
  window.addEventListener("pagehide", flush);
})();
