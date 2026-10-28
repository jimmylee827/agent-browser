import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveKey, SessionManager } from "../../packages/mcp-server/dist/sessions.js";

test("no session name means a session private to the client", () => {
  const a = resolveKey("client-a");
  const b = resolveKey("client-b");
  assert.equal(a.shared, false);
  assert.notEqual(a.key, b.key);
});

test("a plain name is private too; only shared:<name> is shared", () => {
  assert.notEqual(resolveKey("a", "work").key, resolveKey("b", "work").key);
  assert.equal(resolveKey("a", "shared:qa").key, resolveKey("b", "shared:qa").key);
  assert.equal(resolveKey("a", "shared:qa").shared, true);
});

test("\"default\" keeps the old, legacy behaviour", () => {
  const r = resolveKey("a", "default");
  assert.equal(r.legacy, true);
  assert.equal(r.key, resolveKey("b", "default").key);
});

test("a tab belongs to the session it is bound to", () => {
  const m = new SessionManager();
  const s = m.get(resolveKey("a"), "a");
  m.bind(s, 42, 7);
  assert.equal(m.ownerOfTab(42), s);
  assert.equal(m.ownerOfTab(43), undefined);
  m.unbind(s);
  assert.equal(m.ownerOfTab(42), undefined);
});

test("another client acting on a shared session is reported, with what changed", () => {
  const m = new SessionManager();
  const s = m.get(resolveKey("a", "shared:qa"), "a");
  assert.equal(m.touch(s, "a", { navCount: 1, docGen: "x.0" }, 1000), null);
  // b arrives at a tab someone else has been driving: it is told so, even
  // with nothing of its own to compare against.
  assert.deepEqual(m.touch(s, "b", { navCount: 1, docGen: "x.0" }, 2000), { lastActor: "a", actedAgoMs: 1000 });
  const seen = m.touch(s, "a", { navCount: 3, docGen: "y.0" }, 5000);
  assert.ok(seen);
  assert.equal(seen.actedAgoMs, 3000);
  assert.deepEqual(seen.changedSinceYourLastCall, { navigations: 2, documentGeneration: "y.0" });
  assert.equal(m.touch(s, "a", {}, 6000), null, "own consecutive calls are not foreign");
});

test("a lease keeps other clients out until it ends", () => {
  const m = new SessionManager();
  const s = m.get(resolveKey("a", "shared:qa"), "a");
  m.takeLease(s, "a", 1000, 0);
  assert.throws(() => m.checkLease(s, "b", 500), (e) => e.code === "SESSION_LOCKED");
  assert.doesNotThrow(() => m.checkLease(s, "a", 500));
  assert.doesNotThrow(() => m.checkLease(s, "b", 1500));
});

test("releasing a client drops its private sessions, not shared ones", () => {
  const m = new SessionManager();
  m.get(resolveKey("a"), "a");
  m.get(resolveKey("a", "shared:qa"), "a");
  const gone = m.release("a");
  assert.equal(gone.length, 1);
  assert.equal(m.all().length, 1);
});

test("the lock serialises calls on one session and is cleaned up", async () => {
  const m = new SessionManager();
  const order = [];
  await Promise.all([
    m.withLock("k", async () => { order.push("a1"); await new Promise((r) => setTimeout(r, 20)); order.push("a2"); }),
    m.withLock("k", async () => { order.push("b1"); }),
  ]);
  assert.deepEqual(order, ["a1", "a2", "b1"]);
  assert.equal(m["locks"].size, 0);
});

test("calls in flight are counted per client", async () => {
  const m = new SessionManager();
  let inside;
  await m.track("a", async () => { inside = m.othersRunning("b"); });
  assert.equal(inside, 1);
  assert.equal(m.othersRunning("b"), 0);
});
