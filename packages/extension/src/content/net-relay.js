// Isolated world, at document_start: the other half of net-hook.js. It hands
// the hook a per-document secret event name and the capture settings, and
// passes what the hook records on to the service worker in batches.
//
// It is separate from engine.js because engine.js runs at document_idle, and
// the requests that matter (a page's first API calls) fire before that. The
// page cannot see this world's globals, so window.__abNetRelay is ours alone;
// the engine reads it to say whether this document is being recorded.
(() => {
  if (window.__abNetRelay) return;
  const state = (window.__abNetRelay = { hooked: false, records: 0, dropped: 0 });
  const channel = "ab" + crypto.randomUUID().replace(/-/g, "");
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

  document.addEventListener(channel, (e) => {
    let batch;
    try {
      batch = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (!Array.isArray(batch)) return;
    state.hooked = true;
    if (topOnly && window !== window.top) return;
    state.records += batch.length;
    for (const r of batch) out.push(r);
    if (batch.length) schedule();
  });

  const reply = () =>
    document.dispatchEvent(new CustomEvent(HELLO, { detail: JSON.stringify({ channel, config }) }));
  // Whichever of the two scripts runs second completes the exchange.
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
      const { enabled, maxBodyChars, skipBodyTypes, blockedDomains, captureWebSockets, maxFramesPerSocket, maxFrameChars } = netConfig;
      document.dispatchEvent(
        new CustomEvent(channel + ":cfg", {
          detail: JSON.stringify({ enabled, maxBodyChars, skipBodyTypes, blockedDomains, captureWebSockets, maxFramesPerSocket, maxFrameChars }),
        }),
      );
    })
    .catch(() => {});

  // The last batch of a page being left.
  window.addEventListener("pagehide", flush);
})();
