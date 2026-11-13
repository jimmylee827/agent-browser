import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { headerRule, postInPage } from "../../packages/extension/src/lib/requests.js";

test("navigation header rule is exact-URL, tab, method and main-frame scoped", () => {
  const r = headerRule(8, 3, "https://example.test/a?q=x.y#fragment", { accept: "application/json" }, "POST");
  const match = new RegExp(r.condition.regexFilter);
  assert.equal(match.test("https://example.test/a?q=x.y"), true);
  for (const url of ["https://example.test/a?q=xay", "https://other.test/a?q=x.y", "https://example.test/a?q=x.y&token=other"]) assert.equal(match.test(url), false);
  assert.deepEqual(r.condition.tabIds, [3]);
  assert.deepEqual(r.condition.resourceTypes, ["main_frame"]);
  assert.deepEqual(r.condition.requestMethods, ["post"]);
});

function run(spec, fetchImpl, formSubmit) {
  const ctx = vm.createContext({ URL, URLSearchParams, FormData, TextDecoder, AbortController, location: { href: "https://example.test/current" },
    fetch: fetchImpl, setTimeout: (fn, ms) => ms === 30000 ? 0 : setTimeout(fn, ms), clearTimeout,
    HTMLFormElement: { prototype: { submit: formSubmit } },
    document: { createElement(tag) { return tag === "form" ? { style: {}, inputs: [], append(i) { this.inputs.push(i); }, remove() {} } : {}; }, documentElement: { append() {} } },
  });
  return vm.runInContext(`(${postInPage.toString()})(${JSON.stringify(spec)})`, ctx);
}
test("fetch POST dispatches once, returns data, includes tab cookies and does not auto-follow redirects", async () => {
  let calls = 0;
  const r = await run({ url: "https://example.test/api", mode: "fetch", encoding: "json", body: '{"x":1}', maxBodyChars: 100 }, async (url, init) => {
    calls++;
    assert.equal(init.method, "POST"); assert.equal(init.body, '{"x":1}');
    assert.equal(init.credentials, "include"); assert.equal(init.redirect, "manual");
    return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
  });
  assert.equal(calls, 1); assert.equal(r.dispatch, "completed"); assert.equal(r.response.body, '{"ok":true}');
});
test("CSP/CORS/network rejection produces unknown dispatch and no alternate transport", async () => {
  let calls = 0;
  const r = await run({ url: "https://example.test/api", mode: "fetch", encoding: "text", body: "test" }, async () => { calls++; throw new Error("Failed to fetch"); });
  assert.equal(calls, 1); assert.equal(r.dispatch, "unknown"); assert.equal(r.actionOutcome, "unknown");
});
test("form POST uses native submit once, including a field named submit", async () => {
  let calls = 0;
  const r = await run({ url: "https://example.test/api", mode: "form", encoding: "form", fields: [["submit", "go"], ["q", "test"]] }, () => { throw new Error("must not fetch"); }, function () {
    calls++; assert.equal(this.method, "POST"); assert.equal(this.inputs.length, 2);
    assert.equal(this.inputs[0].name, "submit"); assert.equal(this.enctype, "application/x-www-form-urlencoded");
  });
  assert.equal(calls, 1); assert.equal(r.dispatch, "completed");
});
test("response read is bounded", async () => {
  const r = await run({ url: "https://example.test/api", mode: "fetch", encoding: "text", body: "test", maxBodyChars: 100 }, async () => new Response("x".repeat(1000)));
  assert.equal(r.response.body.length, 100); assert.equal(r.response.truncated, true);
});
