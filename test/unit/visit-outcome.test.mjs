import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyVisit } from "../../packages/mcp-server/dist/visit-outcome.js";

test("visit separates authentication, explicit blocks, HTTP errors and unknown pages", () => {
  for (const [wall, status, observed, kind] of [
    [undefined, 200, true, "content"],
    [undefined, undefined, false, "unknown"],
    [undefined, 200, false, "unknown"],
    ["login", 200, true, "login_required"],
    [undefined, 401, true, "login_required"],
    ["captcha", 403, true, "challenge"],
    ["access_block", 200, true, "access_blocked"],
    [undefined, 403, false, "access_blocked"],
    [undefined, 429, true, "access_blocked"],
    [undefined, 404, true, "http_error"],
    [undefined, 503, false, "http_error"],
    ["consent", 200, true, "notice"],
  ]) {
    const result = classifyVisit(wall, status, observed);
    assert.equal(result.kind, kind);
    assert.equal(result.httpStatus, status);
  }
});
