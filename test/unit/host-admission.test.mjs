import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostAdmission, retryAfter } from "../../packages/mcp-server/dist/host-admission.js";

test("Retry-After supports seconds/date but rejects garbage, expired and unbounded values", () => {
  const now = Date.parse("2026-11-13T00:00:00Z");
  assert.equal(retryAfter("60", now), now + 60_000);
  assert.equal(retryAfter("Fri, 13 Nov 2026 00:01:00 GMT", now), now + 60_000);
  for (const v of ["garbage", "-1", "99999999999999999", "0"]) assert.equal(retryAfter(v, now), undefined);
});
test("shared pause survives restart, explicit override does not clear it, and expires", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-host-"));
  try {
    let now = Date.now();
    const file = join(dir, "pauses.json");
    const h = new HostAdmission(file, () => 300_000, () => now);
    h.pause("https://EXAMPLE.test/a", "blocked", "foreground");
    assert.throws(() => h.check("https://example.test/b"), { code: "HOST_PAUSED" });
    h.check("https://example.test/", true);
    assert.throws(() => h.check("https://example.test/"));
    h.check("https://other.test/");
    const jobs = new HostAdmission(file, () => 300_000, () => now);
    assert.throws(() => jobs.check("https://example.test/"));
    now += 300_001;
    jobs.check("https://example.test/");
    assert.equal(jobs.list().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("re-observing the same document or request does not renew its cooldown", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-host-"));
  let now = Date.now();
  try {
    const h = new HostAdmission(join(dir, "p.json"), () => 300_000, () => now);
    h.pause("https://a.test/", "blocked", "page", undefined, "document:1");
    const until = h.list()[0].until;
    now += 200_000;
    h.pause("https://a.test/", "blocked", "job", undefined, "document:1");
    assert.equal(h.list()[0].until, until);
    now += 100_001;
    h.pause("https://a.test/", "blocked", "page", undefined, "document:1");
    h.check("https://a.test/");
    h.pause("https://a.test/", "blocked", "page", undefined, "document:2");
    assert.throws(() => h.check("https://a.test/"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("generic 403/503 do not cause pauses; 429 and valid 503 Retry-After do", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-host-"));
  try {
    const h = new HostAdmission(join(dir, "p.json"));
    h.observe([{ url: "https://a.test/", status: 403 }, { url: "https://b.test/", status: 503 }], "job");
    assert.equal(h.list().length, 0);
    h.observe([{ url: "https://a.test/", status: 429 }, { url: "https://b.test/", status: 503, responseHeaders: [{ name: "Retry-After", value: "600" }] }], "job");
    assert.equal(h.list().length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
