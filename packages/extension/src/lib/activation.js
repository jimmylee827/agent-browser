// Passed to chrome.scripting.executeScript: this function must be self-contained.
// Preparation and strategy selection happen BEFORE the one activation. Never
// infer that it is safe to replay a handler from a quiet DOM or missing traffic.
export async function activateOnce(attr, options = {}) {
  const el = document.querySelector(`[${attr}]`);
  if (!el) return { found: false };
  el.removeAttribute(attr);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const props = () => el[Object.keys(el).find((k) => k.startsWith("__reactProps$"))];
  const strategies = ["pointer", "native", "react", "form", "form-action"];
  const strategy = options.strategy === "auto" || !options.strategy ? "pointer" : options.strategy;
  const base = { found: true, strategy, dispatch: "not_dispatched", strategies: [], frameUrl: location.href };
  if (!strategies.includes(strategy)) return { ...base, error: "unknown activation strategy" };
  const started = Date.now();
  // Only a recognisable React target needs a hydration wait. A plain DOM
  // button must not pay a four-second delay on every click.
  if (options.waitForHydration || strategy === "react" || Object.keys(el).some((k) => /^__react(Fiber|Props)\$/.test(k))) {
    while (!props()?.onClick && !el.form && Date.now() - started < (options.hydrationTimeoutMs ?? 4000)) await sleep(100);
  }
  const form = el.form || el.closest("form");
  const handler = props()?.onClick;
  const formAction = el.getAttribute("formaction") || props()?.formAction;
  if ((strategy === "react" && typeof handler !== "function") ||
      (strategy === "form" && typeof form?.requestSubmit !== "function") ||
      (strategy === "form-action" && (!form || typeof formAction !== "string")))
    return { ...base, error: `target does not support ${strategy}` };
  const before = { url: location.href, value: el.value, checked: el.checked };
  let mutations = 0;
  const mo = new MutationObserver((records) => { mutations += records.length; });
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const result = { ...base, hydrated: !!handler || !!form, preparationMs: Date.now() - started, dispatchedAt: Date.now() };
  try {
    // From this boundary on, an exception does NOT establish non-delivery.
    result.dispatch = "unknown";
    result.strategies.push(strategy);
    if (strategy === "pointer") {
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2, button: 0, view: window };
      el.dispatchEvent(new PointerEvent("pointerover", o));
      el.dispatchEvent(new MouseEvent("mouseover", o));
      el.dispatchEvent(new PointerEvent("pointermove", o));
      el.dispatchEvent(new MouseEvent("mousemove", o));
      el.dispatchEvent(new PointerEvent("pointerdown", o));
      el.dispatchEvent(new MouseEvent("mousedown", o));
      el.focus?.();
      el.dispatchEvent(new PointerEvent("pointerup", o));
      el.dispatchEvent(new MouseEvent("mouseup", o));
      el.dispatchEvent(new MouseEvent("click", o));
    } else if (strategy === "native") el.click();
    else if (strategy === "react") handler({ preventDefault() {}, stopPropagation() {}, target: el, currentTarget: el,
      isTrusted: false, type: "click", nativeEvent: new MouseEvent("click") });
    else if (strategy === "form") {
      const submitter = /^(submit|image)$/.test(el.type || "") ? el : undefined;
      form.requestSubmit(submitter);
    } else {
      const url = new URL(formAction, location.href);
      if (!/^https?:$/.test(url.protocol)) throw new Error("form action must be HTTP(S)");
      const data = new FormData(form);
      if (el.name) data.append(el.name, el.value || "");
      // Preserve the form's method; do not use a GET with a body.
      const method = (form.method || "get").toUpperCase();
      if (method === "GET") {
        for (const [k, v] of data) url.searchParams.append(k, String(v));
        fetch(url.href, { credentials: "include" }).catch(() => {});
      } else fetch(url.href, { method, body: data, credentials: "include" }).catch(() => {});
    }
    result.dispatch = "completed";
  } catch (e) { result.error = String(e.message || e); }
  finally { await sleep(100); mo.disconnect(); }
  const navigated = before.url !== location.href;
  const valueChanged = before.value !== el.value || before.checked !== el.checked;
  return { ...result, acted: result.dispatch !== "not_dispatched", changed: navigated || valueChanged || mutations > 0,
    signals: { navigated, valueChanged, domMutations: mutations }, navigated };
}
