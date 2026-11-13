import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { activateOnce } from "../../packages/extension/src/lib/activation.js";

function harness({ react = false, form = false, delay = 0 } = {}) {
  let requests = 0;
  const fire = () => delay ? setTimeout(() => requests++, delay) : requests++;
  const el = { type: "submit", removeAttribute() {}, getAttribute() { return null; },
    closest() { return this.form; }, getBoundingClientRect() { return { left: 0, top: 0, width: 80, height: 30 }; },
    focus() {}, click: fire, dispatchEvent(e) { if (e.type === "click") fire(); } };
  if (react) el.__reactProps$test = { onClick: fire };
  if (form) el.form = { requestSubmit: fire };
  const ctx = vm.createContext({ document: { querySelector: () => el, documentElement: {} }, location: { href: "https://example.test/" },
    window: {}, MutationObserver: class { observe() {} disconnect() {} },
    MouseEvent: class { constructor(type) { this.type = type; } }, PointerEvent: class { constructor(type) { this.type = type; } },
    setTimeout, Date, URL, console });
  return { run: (strategy) => vm.runInContext(`(${activateOnce.toString()})("target", ${JSON.stringify({ strategy, hydrationTimeoutMs: 0 })})`, ctx), count: () => requests };
}
for (const strategy of ["auto", "pointer", "native", "react", "form"]) {
  test(`robust ${strategy} performs only one activation with all alternatives present`, async () => {
    const h = harness({ react: true, form: true });
    const r = await h.run(strategy);
    assert.equal(h.count(), 1);
    assert.equal(r.dispatch, "completed");
    assert.equal(r.strategies.length, 1);
  });
}
test("fetch-only/late handler: no visible effect never triggers replay", async () => {
  const h = harness({ delay: 800 });
  const r = await h.run("auto");
  assert.equal(r.changed, false);
  assert.equal(r.dispatch, "completed");
  await new Promise((r) => setTimeout(r, 850));
  assert.equal(h.count(), 1);
});
test("agent can deliberately choose a later robust attempt", async () => {
  const h = harness();
  await h.run("auto");
  await h.run("native");
  assert.equal(h.count(), 2);
});
test("unsupported strategy is rejected before dispatch", async () => {
  const h = harness();
  const r = await h.run("react");
  assert.equal(r.dispatch, "not_dispatched");
  assert.equal(h.count(), 0);
});
