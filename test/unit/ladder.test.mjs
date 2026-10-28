import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, freshState } from "../../packages/mcp-server/dist/ladder.js";

const set = { maxLoadsPerHour: 4, staleAfterMs: 20 * 60_000, faultAfterMs: 90_000, cooldownMs: 5 * 60_000, recoveryQuietMs: 120_000, pageGraceMs: 30_000, confirmStrikes: 2 };
const poll = { refresh: "none", hasTextHealth: false, expectsResponses: true };
const text = { refresh: "none", hasTextHealth: true, expectsResponses: false };
const obs = (o = {}) => ({ good: [], any: [], faults: [], healthText: null, tabAlive: true, ...o });
const MIN = 60_000;

/** Run ticks one minute apart; each tick's observation from fn(t). */
function run(state, job, fromT, toT, fn, s = set) {
  const actions = [];
  for (let t = fromT; t <= toT; t += MIN) {
    const d = decide(state, fn(t), s, job, t, () => 0.5);
    state = d.state;
    actions.push([t, d.action, d.log]);
  }
  return { state, actions, act: actions.filter(([, a]) => a !== "none").map(([t, a]) => `${t / MIN}:${a}`) };
}

test("a healthy page is left alone", () => {
  const r = run(freshState(0), poll, MIN, 60 * MIN, (t) => obs({ good: [t - 1000], any: [t - 1000] }));
  assert.deepEqual(r.act, []);
});

test("a page whose requests keep failing climbs reload → navigate → reopen → one give-up", () => {
  let s = { ...freshState(0), pageLoadedAt: 0 };
  const r = run(s, poll, MIN, 60 * MIN, (t) => obs({ faults: [t - 1000], any: [t - 1000] }));
  // First failure seen at 0:59, so 90s of them by minute 3; then remedies 5 minutes apart, then quiet.
  assert.deepEqual(r.act.filter((a) => !a.endsWith("cooldown")), ["3:reload", "8:renavigate", "13:recreate", "18:give-up"]);
  assert.equal(r.state.gaveUpAt, 18 * MIN);
  assert.equal(r.actions.filter(([, a, log]) => a === "give-up" && log).length, 1);
});

test("nothing is done within the grace period after a load", () => {
  const s = { ...freshState(0), pageLoadedAt: 10 * MIN, faultSince: 0, lastFaultAt: 9 * MIN };
  const d = decide(s, obs({ faults: [10 * MIN + 5000] }), set, poll, 10 * MIN + 20_000);
  assert.equal(d.action, "none");
});

test("a cached 200 right after our own reload does not reset the ladder", () => {
  let s = { ...freshState(0), pageLoadedAt: 0 };
  let r = run(s, poll, MIN, 3 * MIN, (t) => obs({ faults: [t - 1000] }));
  assert.equal(r.state.rung, 1);
  // A good response (from cache) at once, while the real requests still fail.
  r = run(r.state, poll, 4 * MIN, 8 * MIN, (t) => obs({ good: t === 4 * MIN ? [t - 2000] : [], faults: [t - 1000] }));
  assert.equal(r.state.rung, 2, "still sick: the next rung was taken");
});

test("a quiet recovery does reset it", () => {
  let s = { ...freshState(0), pageLoadedAt: 0 };
  let r = run(s, poll, MIN, 3 * MIN, (t) => obs({ faults: [t - 1000] }));
  assert.equal(r.state.rung, 1);
  r = run(r.state, poll, 4 * MIN, 9 * MIN, (t) => obs({ good: [t - 1000] }));
  assert.equal(r.state.rung, 0);
  assert.ok(r.actions.some(([, , log]) => log));
});

test("a blank page counts only after two checks in a row, and with failures acts at once", () => {
  const s = { ...freshState(0), pageLoadedAt: 0 };
  let d = decide(s, obs({ healthText: false, faults: [MIN - 1000] }), set, text, MIN);
  assert.equal(d.action, "none");
  assert.equal(d.state.strikes, 1);
  d = decide(d.state, obs({ healthText: false }), set, text, 2 * MIN);
  assert.equal(d.action, "reload");
  // One good check in between starts the count again.
  let e = decide(s, obs({ healthText: false }), set, text, MIN);
  e = decide(e.state, obs({ healthText: true }), set, text, 2 * MIN);
  e = decide(e.state, obs({ healthText: false }), set, text, 3 * MIN);
  assert.equal(e.state.strikes, 1);
});

test("blank with no failures is acted on only after staleAfterMs", () => {
  const r = run({ ...freshState(0), pageLoadedAt: 0 }, text, MIN, 25 * MIN, () => obs({ healthText: false }));
  assert.equal(r.act[0], "21:reload");
});

test("the hourly cap holds, counts scheduled refreshes, and is logged once", () => {
  const job = { refresh: "reload", intervalMs: 10 * MIN, hasTextHealth: false, expectsResponses: false };
  const r = run(freshState(0), job, MIN, 59 * MIN, () => obs(), { ...set, maxLoadsPerHour: 3 });
  const refreshes = r.act.filter((a) => a.endsWith("refresh"));
  assert.equal(refreshes.length, 3);
  assert.ok(r.act.includes("41:capped"));
  assert.equal(r.actions.filter(([, a, log]) => a === "capped" && log).length, 1);
});

test("scheduled refreshes have jitter within ±10%", () => {
  const job = { refresh: "reload", intervalMs: 10 * MIN, hasTextHealth: false, expectsResponses: false };
  for (const rnd of [0, 1]) {
    const d = decide({ ...freshState(0), pageLoadedAt: 0, nextRefreshAt: 10 * MIN }, obs(), set, job, 10 * MIN, () => rnd);
    assert.equal(d.action, "refresh");
    assert.equal(d.state.nextRefreshAt, 10 * MIN + (rnd ? 11 * MIN : 9 * MIN));
  }
});

test("loads stamped in the future do not count toward the cap", () => {
  const s = { ...freshState(0), pageLoadedAt: 0, loads: [99 * MIN, 98 * MIN, 97 * MIN, 96 * MIN] };
  const d = decide(s, obs({ faults: [MIN] }), set, poll, 3 * MIN);
  assert.equal(d.action, "reload");
});

test("a closed tab is reopened, as a load", () => {
  const d = decide(freshState(0), obs({ tabAlive: false }), set, poll, MIN);
  assert.equal(d.action, "recreate");
  assert.equal(d.state.loads.length, 1);
});
