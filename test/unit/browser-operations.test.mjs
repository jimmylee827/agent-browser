import { test } from "node:test";
import assert from "node:assert/strict";
import { actionOutcome, expectationResult, navigationEvidence, requestHeaders, httpUrl } from "../../packages/mcp-server/dist/browser-operations.js";

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

test("expectations distinguish a transition, an existing state and no evidence", () => {
  const p = (state) => ({ state });
  for (const [before, after, pending, expected] of [
    ["absent", "present", false, "satisfied"], ["present", "present", false, "already_true"],
    ["unobservable", "present", false, "true_after"], ["present", "absent", false, "unmet"],
    ["absent", "absent", true, "pending"], ["absent", "ambiguous", false, "ambiguous"],
  ]) assert.deepEqual(expectationResult(p(before), p(after), pending), { state: expected, before, after });
});
test("same-URL commit, route change, and new tab are separate observations", () => {
  const page = { documentId: "one", navCount: 2, url: "https://example.test" };
  assert.equal(navigationEvidence(page, page, false), "none");
  assert.equal(navigationEvidence(page, { ...page, documentId: "two" }, false), "document");
  assert.equal(navigationEvidence(page, { ...page, navCount: 3 }, false), "route");
  assert.equal(navigationEvidence(page, page, true), "new_tab");
});
