// Background jobs in real Google Chrome: a page kept open and recorded, healed
// when its server goes down, paused by the kill switch, found again after a
// restart. Timings are shrunk through this instance's own local.json.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startHarness, chromeAvailable, extensionInstalled } from "./harness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ready = chromeAvailable() && extensionInstalled();
const skip = ready ? false : "the test browser is not set up: run `npm run test:e2e:setup` once";
let h;
let A;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAST = {
  jobs: {
    checkEveryMs: 1000,
    minIntervalMs: 1000,
    defaults: { pageGraceMs: 2000, faultAfterMs: 3000, cooldownMs: 2000, recoveryQuietMs: 3000, staleAfterMs: 10_000, confirmStrikes: 2, maxLoadsPerHour: 6 },
  },
};

before(async () => {
  if (!ready) return;
  h = await startHarness({ log: !!process.env.AB_TEST_LOG });
  assert.ok(h.connected, "the extension in the test browser did not connect; run `npm run test:e2e:setup`");
  writeFileSync(h.localConfig, JSON.stringify(FAST));
  await sleep(3000); // the server re-reads local.json every 2s
  A = await h.client(`jobs-${Date.now()}`);
});
after(async () => {
  if (h) rmSync(join(h.state, "HALT"), { force: true });
  await h?.stop();
});

const mode = (set) => fetch(h.url(`api/mode?set=${set}`)).then((r) => r.json());
const jobs = (args) => A("browser_jobs", args);
const status = async (id) => (await jobs({ action: "status", id })).data.state;
async function until(id, pred, ms = 30_000) {
  const t = Date.now();
  let s;
  while (Date.now() - t < ms) {
    s = await status(id);
    if (pred(s)) return s;
    await sleep(500);
  }
  assert.fail(`job ${id} never got there; last state: ${JSON.stringify(s)}`);
}
const tabCount = async () => (await (await fetch(`${h.base}/tabs`)).json()).tabs.length;

test("a job opens its page, records what matches, and says it is running", { skip }, async () => {
  await mode("up");
  const r = await jobs({ action: "start", id: "poll", url: h.url("poll.html"), capture: [{ urlPattern: "/api/poll" }], health: { text: "Reading" } });
  assert.ok(!r.isError, JSON.stringify(r.data));
  assert.match(r.data.warning, /runs in the background/);
  const s = await until("poll", (x) => x.records >= 3 && x.status === "running");
  assert.ok(s.lastGoodAt);
  const read = (await jobs({ action: "read", id: "poll", limit: 2 })).data;
  assert.equal(read.records.length, 2);
  assert.ok(read.records.every((x) => /\/api\/poll/.test(x.url) && x.job === "poll"));
  assert.ok(read.next);
  // Its live page is readable too.
  const live = (await A("browser_network", { job: "poll", urlPattern: "/api/poll", includeBodies: true, limit: 1 })).data;
  assert.equal(live.entries[0].json.readings.length, 1);
});

test("when the server goes down the job heals its page, and settles once it is back", { skip }, async () => {
  const before_ = (await status("poll")).loads.length;
  await mode("down");
  const sick = await until("poll", (x) => x.rung >= 1, 30_000);
  assert.ok(sick.loads.length > before_, "it reloaded the page");
  assert.equal(sick.status, "healing");
  await mode("up");
  const well = await until("poll", (x) => x.rung === 0 && x.status === "running", 30_000);
  assert.ok(well.lastGoodAt > sick.lastHealAt);
  const log = (await jobs({ action: "read", id: "poll", log: true, limit: 200 })).data.records.map((r) => r.event);
  assert.ok(log.includes("reload") && log.includes("recovered"), log.join(","));
});

test("the kill switch pauses a job; what the page did meanwhile is written after", { skip }, async () => {
  writeFileSync(join(h.state, "HALT"), "");
  const halted = await until("poll", (x) => x.status === "halted", 10_000);
  await sleep(3000); // the page keeps polling; nothing is drained
  assert.equal((await status("poll")).records, halted.records);
  rmSync(join(h.state, "HALT"));
  const resumed = await until("poll", (x) => x.status === "running" && x.records > halted.records + 2, 15_000);
  assert.ok(resumed.records > halted.records);
});

test("after a server restart the job finds its tab again: no second window", { skip }, async () => {
  const tab = (await status("poll")).tabId;
  const n = await tabCount();
  const restartedAt = Date.now();
  assert.ok(await h.restartDaemon(), "server back");
  // The new server's own word that it found the tab (the old one's last
  // heartbeat is still in jobs.json, so a recent heartbeat proves nothing).
  let rebound;
  for (let t = Date.now(); !rebound && Date.now() - t < 15_000; await sleep(500)) {
    const log = (await jobs({ action: "read", id: "poll", log: true, limit: 500 })).data.records;
    rebound = log.find((r) => r.event === "rebound" && r.ts >= restartedAt);
  }
  assert.ok(rebound, "the restarted server rebound the job's tab");
  assert.equal(rebound.tabId, tab);
  assert.equal((await status("poll")).tabId, tab);
  assert.equal(await tabCount(), n);
});

test("page loads are capped per hour, and the cap is logged once", { skip }, async () => {
  await jobs({ action: "start", id: "capped", url: h.url("poll.html"), capture: [{ urlPattern: "/api/poll" }], maxLoadsPerHour: 2 });
  await until("capped", (x) => x.status === "running");
  await mode("down");
  await sleep(20_000);
  const s = await status("capped");
  assert.ok(s.loads.length <= 2, `${s.loads.length} loads`);
  const log = (await jobs({ action: "read", id: "capped", log: true, limit: 200 })).data.records.map((r) => r.event);
  assert.equal(log.filter((e) => e === "capped").length, 1, log.join(","));
  await mode("up");
  await jobs({ action: "remove", id: "capped" });
});

test("stop closes the window and keeps the data; the CLI lists and reads it", { skip }, async () => {
  const n = await tabCount();
  const r = await jobs({ action: "stop", id: "poll" });
  assert.equal(r.data.state.status, "stopped");
  assert.equal(await tabCount(), n - 1);
  const env = { ...process.env, AB_CONTROL_PORT: new URL(h.base).port };
  const list = spawnSync(process.execPath, [resolve(root, "scripts/ab.mjs"), "jobs", "list", "--json"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).jobs.find((j) => j.spec.id === "poll").state.status, "stopped");
  const tail = spawnSync(process.execPath, [resolve(root, "scripts/ab.mjs"), "jobs", "tail", "poll", "--json"], { env, encoding: "utf8" });
  assert.ok(tail.stdout.trim().split("\n").length > 3);
  await jobs({ action: "remove", id: "poll" });
  assert.ok(existsSync(join(h.state, "jobs", "poll")), "records stay after remove");
});

test("a job that would hammer a site, or record a blocked one, is refused", { skip }, async () => {
  const fast = await jobs({ action: "start", id: "fast", url: h.url("poll.html"), capture: [{ urlPattern: "/api" }], refresh: "reload", intervalMs: 2000 });
  assert.equal(fast.data.code, "JOB_LIMIT");
  const pay = await jobs({ action: "start", id: "pay", url: "https://www.paypal.com/", capture: [{ urlPattern: "/" }] });
  assert.equal(pay.data.code, "NETWORK_BLOCKED");
  const missing = await jobs({ action: "status", id: "nope" });
  assert.equal(missing.data.code, "JOB_NOT_FOUND");
  const mine = await A("agent_browser_visit", { url: h.url("index.html"), session: "job:poll" });
  assert.equal(mine.data.code, "BAD_REQUEST");
});
