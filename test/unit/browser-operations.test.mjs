import { test } from "node:test";
import assert from "node:assert/strict";
import { actionOutcome, requestHeaders, httpUrl } from "../../packages/mcp-server/dist/browser-operations.js";

test("no DOM effect is an unknown business outcome, never permission to replay", () => {
  assert.deepEqual(actionOutcome({ dispatch: "completed", changed: false }), {
    dispatch: "completed", actionOutcome: "unknown", businessSuccess: "not_verified", automaticRetryAllowed: false,
  });
});
test("matching response takes precedence over a quiet DOM but is not business success", () => {
  const r = actionOutcome({ dispatch: "completed", changed: false, response: { status: 200 } });
  assert.equal(r.actionOutcome, "response_received");
  assert.equal(r.businessSuccess, "not_verified");
});
test("header overrides reject browser-managed, malformed and duplicate names", () => {
  assert.deepEqual(requestHeaders({ Accept: "application/json" }), { accept: "application/json" });
  for (const h of [{ Cookie: "a=b" }, { Host: "other.test" }, { "Sec-Fetch-Site": "none" }, { "X-Test": "x\r\ny" }, { Accept: "a", accept: "b" }])
    assert.throws(() => requestHeaders(h), { code: "BAD_REQUEST" });
});
test("request URLs exclude non-HTTP and embedded credentials", () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://a:b@example.test/"]) assert.throws(() => httpUrl(url));
  assert.equal(httpUrl("https://example.test/x").hostname, "example.test");
});
