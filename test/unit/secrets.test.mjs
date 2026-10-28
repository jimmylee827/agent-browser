import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The file store, never the person's Keychain.
process.env.AB_SECRETS_FILE = "1";
process.env.AB_LOCAL_CONFIG = join(tmpdir(), "ab-unit-no-local.json");
const { totp, base32Decode, allowedOn, setSecret, getValue, listSecrets, removeSecret } = await import("../../packages/mcp-server/dist/secrets.js");
const { validateSpec } = await import("../../packages/mcp-server/dist/jobs.js");
const { loadConfig } = await import("../../packages/mcp-server/dist/config.js");
const { parseStep } = await import("../../scripts/step-spec.mjs");

const cfgIn = () => {
  const cfg = loadConfig();
  cfg.stateDir = mkdtempSync(join(tmpdir(), "ab-secrets-"));
  return cfg;
};

test("TOTP matches the RFC 6238 test vectors (SHA-1)", () => {
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // base32 of "12345678901234567890"
  assert.equal(base32Decode(seed).toString(), "12345678901234567890");
  for (const [t, code] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"]]) {
    assert.equal(totp(seed, t * 1000, { digits: 8 }), code, `t=${t}`);
  }
  assert.equal(totp(seed, 59_000), "287082"); // six digits by default
  assert.equal(totp(`otpauth://totp/x?secret=${seed}&digits=8`, 59_000), "94287082");
  assert.throws(() => totp("not base32!"), /base32/);
});

test("a secret is used only on its own hosts and their subdomains", () => {
  const meta = { hosts: ["login.shop.com"] };
  assert.equal(allowedOn(meta, "login.shop.com"), true);
  assert.equal(allowedOn(meta, "eu.login.shop.com"), true);
  assert.equal(allowedOn(meta, "shop.com"), false);
  assert.equal(allowedOn(meta, "login.shop.com.evil.example"), false);
  assert.equal(allowedOn(meta, "xlogin.shop.com"), false);
});

test("set, read back, list without values, remove", () => {
  const cfg = cfgIn();
  setSecret(cfg, { name: "shop-login", kind: "password", hosts: ["login.shop.com"], value: 'p@ss "x" 中文', by: "t" });
  assert.equal(getValue(cfg, "shop-login"), 'p@ss "x" 中文');
  const listed = JSON.stringify(listSecrets(cfg));
  assert.equal(listed.includes("p@ss"), false, "the list has no values");
  assert.equal(readFileSync(join(cfg.stateDir, "secrets.json"), "utf8").includes("p@ss"), false);
  assert.equal(statSync(join(cfg.stateDir, "secret-values.json")).mode & 0o777, 0o600);
  setSecret(cfg, { name: "shop-2fa", kind: "totp", hosts: ["login.shop.com"], value: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", by: "t" });
  assert.equal(getValue(cfg, "shop-2fa", 59_000), "287082");
  assert.equal(removeSecret(cfg, "shop-login"), true);
  assert.throws(() => getValue(cfg, "shop-login"), /no secret/);
});

test("bad secrets are refused when set", () => {
  const cfg = cfgIn();
  const base = { name: "a", kind: "password", hosts: ["x.example"], value: "v", by: "t" };
  assert.throws(() => setSecret(cfg, { ...base, name: "Bad Name" }), /name/);
  assert.throws(() => setSecret(cfg, { ...base, kind: "ssn" }), /kind/);
  assert.throws(() => setSecret(cfg, { ...base, hosts: [] }), /hosts/);
  assert.throws(() => setSecret(cfg, { ...base, kind: "totp", value: "!!" }), /base32/);
});

test("--step is read the way the help says", () => {
  assert.deepEqual(parseStep("dismiss-consent"), { action: "dismiss-consent" });
  assert.deepEqual(parseStep("click:Today"), { action: "click", name: "Today" });
  assert.deepEqual(parseStep("click?:Accept all"), { action: "click", optional: true, name: "Accept all" });
  assert.deepEqual(parseStep("fill:Search:a:b"), { action: "fill", name: "Search", value: "a:b" });
  assert.deepEqual(parseStep("fill:Password:@shop-login"), { action: "fill", name: "Password", secret: "shop-login" });
  assert.deepEqual(parseStep("click:Today@tab"), { action: "click", name: "Today", role: "tab" });
  assert.deepEqual(parseStep("wait:Reading"), { action: "wait", text: "Reading" });
  assert.throws(() => parseStep("hack:x"), /action/);
});

test("a job's steps are checked when it starts: secrets must exist and be approved for its host", () => {
  const cfg = cfgIn();
  setSecret(cfg, { name: "shop-login", kind: "password", hosts: ["login.shop.com"], value: "v", by: "t" });
  const base = { id: "j", url: "https://login.shop.com/", capture: [{ urlPattern: "/api" }] };
  assert.equal(validateSpec({ ...base, steps: [{ action: "fill", name: "Password", secret: "shop-login" }] }, cfg).steps.length, 1);
  const code = (spec) => {
    try {
      validateSpec(spec, cfg);
    } catch (e) {
      return e.code;
    }
  };
  assert.equal(code({ ...base, steps: [{ action: "fill", name: "Password", secret: "nope" }] }), "BAD_REQUEST");
  assert.equal(code({ ...base, url: "https://other.example/", steps: [{ action: "fill", name: "Password", secret: "shop-login" }] }), "POLICY_BLOCKED");
  assert.equal(code({ ...base, steps: [{ action: "click" }] }), "BAD_REQUEST");
  assert.equal(code({ ...base, steps: Array.from({ length: 11 }, () => ({ action: "dismiss-consent" })) }), "BAD_REQUEST");
  // The spec holds the secret's name, never its value.
  const spec = validateSpec({ ...base, steps: [{ action: "fill", name: "Password", secret: "shop-login" }] }, cfg);
  assert.equal(JSON.stringify(spec).includes('"v"'), false);
});
