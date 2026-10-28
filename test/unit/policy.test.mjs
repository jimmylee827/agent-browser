import { test } from "node:test";
import assert from "node:assert/strict";
import { Policy, evalBlockedBy } from "../../packages/mcp-server/dist/policy.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Unit tests use the defaults, never the person's own override file.
process.env.AB_LOCAL_CONFIG = join(tmpdir(), "ab-unit-no-local.json");

const cfg = { policy: { trustedDomains: ["example.com"], sensitiveActionClasses: ["payment"], redactSelectors: [] } };

test("ordinary actions run anywhere; labelled ones only on trusted domains", () => {
  const p = new Policy(cfg);
  assert.equal(p.evaluate({ url: "https://evil.test/" }).allow, true);
  assert.equal(p.evaluate({ url: "https://evil.test/", actionClass: "payment" }).allow, false);
  assert.equal(p.evaluate({ url: "https://shop.example.com/", actionClass: "payment" }).allow, true);
});

test("eval is refused on blocked domains and their subdomains only", () => {
  const blocked = ["paypal.com", "bank", "accounts.google.com"];
  assert.equal(evalBlockedBy("https://www.paypal.com/x", blocked), "paypal.com");
  assert.equal(evalBlockedBy("https://my.hsbc.bank/", blocked), "bank");
  assert.equal(evalBlockedBy("https://accounts.google.com/", blocked), "accounts.google.com");
  assert.equal(evalBlockedBy("https://mail.google.com/", blocked), undefined);
  assert.equal(evalBlockedBy("http://127.0.0.1:3000/", blocked), undefined);
  assert.equal(evalBlockedBy("https://notpaypal.com/", blocked), undefined);
});

test("a person's local override is honoured, and an approved edit takes effect at once", async () => {
  const { writeFileSync, utimesSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = join(mkdtempSync(join(tmpdir(), "ab-local-")), "local.json");
  const before = process.env.AB_LOCAL_CONFIG;
  process.env.AB_LOCAL_CONFIG = file;
  try {
    writeFileSync(file, JSON.stringify({ policy: { trustedDomains: ["shop.internal"] } }));
    const p = new Policy(cfg);
    assert.equal(p.evaluate({ url: "https://shop.internal/checkout", actionClass: "payment" }).allow, true);
    assert.equal(p.evaluate({ url: "https://other.test/", actionClass: "payment" }).allow, false);
    // An edit while the server runs is picked up on the next action.
    writeFileSync(file, JSON.stringify({ policy: { trustedDomains: ["other.test"] } }));
    const t = new Date(Date.now() + 2000);
    utimesSync(file, t, t);
    assert.equal(p.evaluate({ url: "https://other.test/", actionClass: "payment" }).allow, true);
    assert.equal(p.evaluate({ url: "https://shop.internal/checkout", actionClass: "payment" }).allow, false);
    assert.ok(p.localFile.endsWith("local.json"));
  } finally {
    if (before === undefined) delete process.env.AB_LOCAL_CONFIG;
    else process.env.AB_LOCAL_CONFIG = before;
  }
});
