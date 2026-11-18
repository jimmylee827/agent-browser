import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserRecovery, extensionRegistration } from "../../packages/mcp-server/dist/readiness.js";

const extensionDir = "/repo/packages/extension";
test("registration checks both preference files and distinguishes missing from unknown", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ab-readiness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = join(root, "Default");
  mkdirSync(profile);
  const write = (f, settings) => writeFileSync(join(profile, f), JSON.stringify({ extensions: { settings } }));
  assert.equal(extensionRegistration(root, extensionDir), "unknown");
  write("Secure Preferences", { unrelated: { path: "/other" } });
  assert.equal(extensionRegistration(root, extensionDir), "missing");
  for (const [details, expected] of [[{ disable_reasons: [16777216] }, "disabled"], [{ disable_reasons: 1 }, "disabled"],
    [{ state: 0 }, "disabled"], [{ disable_reasons: [] }, "enabled"], [{ disable_reasons: 0 }, "enabled"]]) {
    write("Preferences", { bridge: { path: extensionDir, ...details } });
    assert.equal(extensionRegistration(root, extensionDir), expected);
  }
  writeFileSync(join(profile, "Preferences"), "{partial");
  assert.equal(extensionRegistration(root, extensionDir), "unknown");
});

function harness() {
  let calls = 0;
  const state = { chromePid: 7, registration: "enabled", halted: false };
  const bridge = { up: false, connectionEpoch: 0, connected() { return this.up; }, async waitForConnection() { return this.up; } };
  const recovery = new BrowserRecovery(bridge, () => ({ ...state }), async () => ({ via: "window", wakeId: ++calls }));
  return { bridge, state, recovery, calls: () => calls };
}

test("confirmed disabled, missing-on-running and halted skip launch", async () => {
  const h = harness();
  for (const registration of ["disabled", "missing"]) {
    h.state.registration = registration;
    assert.equal((await h.recovery.ensure(10_000)).state, "human");
    assert.match(h.recovery.status().nextStep, /chrome:\/\/extensions/);
  }
  h.state.halted = true;
  assert.equal((await h.recovery.ensure(10_000)).state, "halted");
  assert.equal(h.calls(), 0);
});

test("concurrent and repeated calls share one failed wake; new connection permits recovery again", async () => {
  const h = harness();
  const r = await Promise.all(Array.from({ length: 8 }, () => h.recovery.ensure(10_000)));
  assert.equal(h.calls(), 1);
  assert.equal(r.filter((x) => x.attempted).length, 1);
  assert.ok(r.every((x) => x.state === "failed"));
  assert.equal((await h.recovery.ensure(10_000)).state, "suppressed");
  h.bridge.connectionEpoch++;
  assert.equal((await h.recovery.ensure(10_000)).state, "failed");
  assert.equal(h.calls(), 2);
});

test("a launch creating a new PID does not open a second window in the same outage", async () => {
  const state = { chromePid: null, registration: "unknown", halted: false };
  const recovery = new BrowserRecovery({ connected: () => false, waitForConnection: async () => false }, () => ({ ...state }), async () => {
    state.chromePid = 42;
    return { via: "launch", wakeId: 1 };
  });
  assert.equal((await recovery.ensure(10_000)).wake.via, "launch");
  assert.equal((await recovery.ensure(10_000)).state, "suppressed");
});
