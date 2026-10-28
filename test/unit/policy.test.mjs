import { test } from "node:test";
import assert from "node:assert/strict";
import { Policy, evalBlockedBy } from "../../packages/mcp-server/dist/policy.js";

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
