import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Unit tests use their own override file, never the person's.
const dir = mkdtempSync(join(tmpdir(), "ab-config-"));
const local = join(dir, "local.json");
process.env.AB_LOCAL_CONFIG = local;
const { loadConfig, reloadLocal, extensionConfig } = await import("../../packages/mcp-server/dist/config.js");

test("network and jobs have defaults, and the blocklist covers identity and payment hosts", () => {
  writeFileSync(local, "{}");
  const cfg = loadConfig();
  assert.equal(cfg.network.enabled, true);
  assert.ok(cfg.network.blockedDomains.includes("accounts.google.com"));
  assert.equal(cfg.jobs.defaults.maxLoadsPerHour, 4);
});

test("a list in local.json replaces the default; other fields merge", () => {
  writeFileSync(local, JSON.stringify({ network: { blockedDomains: ["mybank.example"] }, jobs: { defaults: { maxLoadsPerHour: 2 } } }));
  const cfg = loadConfig();
  assert.deepEqual(cfg.network.blockedDomains, ["mybank.example"]);
  assert.equal(cfg.network.maxBodyChars, 65536);
  assert.equal(cfg.jobs.defaults.maxLoadsPerHour, 2);
  assert.equal(cfg.jobs.defaults.cooldownMs, 300000);
});

test("reloading picks up an edit, and a deleted line goes back to its default", () => {
  writeFileSync(local, JSON.stringify({ network: { blockedDomains: ["a.example"] } }));
  const cfg = loadConfig();
  writeFileSync(local, JSON.stringify({ diagnostics: { hosts: ["shop.internal"] } }));
  reloadLocal(cfg); // in place: every module holds this same object
  assert.deepEqual(cfg.diagnostics.hosts, ["shop.internal"]);
  assert.ok(cfg.network.blockedDomains.includes("paypal.com"));
});

test("the extension is sent what it acts on, without the comment", () => {
  writeFileSync(local, "{}");
  const ext = extensionConfig(loadConfig());
  assert.deepEqual(Object.keys(ext).sort(), ["diagnosticsHosts", "network"]);
  assert.equal("comment" in ext.network, false);
  assert.equal(typeof ext.network.redactKeys, "string");
});
