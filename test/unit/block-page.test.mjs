import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Exercise the actual content-script branch without introducing a page-global
// helper or a second classifier implementation merely to make it importable.
const source = readFileSync(new URL("../../packages/extension/src/content/engine.js", import.meta.url), "utf8");
const start = source.indexOf("  function detectWall() {");
const end = source.indexOf("  const wallError =", start);
assert.ok(start >= 0 && end > start);
const detector = source.slice(start, end);
function detect(heading, text, title = heading) {
  const context = vm.createContext({ document: { body: { innerText: text }, title,
    querySelector: () => heading ? { textContent: heading } : null, querySelectorAll: () => [] },
    isCaptchaFrame: () => false, overlayRoots: () => [] });
  return vm.runInContext(`${detector}; detectWall()`, context);
}
test("static full-document block needs no dialog or positioned overlay", () => {
  const r = detect("Access denied", "Access denied. Your request was blocked.");
  assert.equal(r.reason, "access_block");
  assert.equal(r.rule, "short-document-block-heading");
});
test("static rate-limit heading is distinguished from CAPTCHA/consent", () => {
  assert.equal(detect("Too many requests", "Try later").reason, "rate_limit");
});
test("ordinary article, body mention and large app documents are not static blocks", () => {
  assert.equal(detect("Understanding access errors", "Access denied can have several causes."), null);
  assert.equal(detect("Sign in", "Access denied. Please sign in."), null);
  assert.equal(detect("Access denied", "x".repeat(6000)), null);
});
