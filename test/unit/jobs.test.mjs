import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSpec, readRecords, pruneJobs, saveJobs, loadJobs, jobDir } from "../../packages/mcp-server/dist/jobs.js";

process.env.AB_LOCAL_CONFIG = join(tmpdir(), "ab-unit-no-local.json");
const { loadConfig } = await import("../../packages/mcp-server/dist/config.js");

const cfgIn = (dir) => {
  const cfg = loadConfig();
  cfg.stateDir = dir;
  return cfg;
};
const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return "none";
};

test("a spec is made whole, and refused for what would go wrong", () => {
  const cfg = cfgIn(mkdtempSync(join(tmpdir(), "ab-jobs-")));
  const ok = validateSpec({ id: "Shop", url: "http://127.0.0.1:3000/x", capture: [{ urlPattern: "/api/" }] }, cfg, [], "t");
  assert.equal(ok.id, "shop");
  assert.equal(ok.refresh, "none");
  assert.equal(ok.enabled, true);

  const base = { id: "a", url: "https://example.com/", capture: [{ urlPattern: "/api" }] };
  assert.equal(codeOf(() => validateSpec({ ...base, id: "bad id!" }, cfg)), "BAD_REQUEST");
  assert.equal(codeOf(() => validateSpec(base, cfg, ["a"])), "BAD_REQUEST");
  assert.equal(codeOf(() => validateSpec({ ...base, capture: [] }, cfg)), "BAD_REQUEST");
  assert.equal(codeOf(() => validateSpec({ ...base, capture: [{ urlPattern: "(" }] }, cfg)), "BAD_REQUEST");
  assert.equal(codeOf(() => validateSpec({ ...base, url: "file:///etc/passwd" }, cfg)), "BAD_REQUEST");
  assert.equal(codeOf(() => validateSpec({ ...base, url: "https://www.paypal.com/x" }, cfg)), "NETWORK_BLOCKED");
  assert.equal(codeOf(() => validateSpec(base, cfg, ["1", "2", "3", "4", "5"])), "JOB_LIMIT");
  // Every 5 minutes is 12 loads an hour, over the default 4.
  assert.equal(codeOf(() => validateSpec({ ...base, refresh: "reload", intervalMs: 300_000 }, cfg)), "JOB_LIMIT");
  assert.equal(validateSpec({ ...base, refresh: "reload", intervalMs: 900_000 }, cfg).intervalMs, 900_000);
  assert.equal(codeOf(() => validateSpec({ ...base, refresh: "reload", intervalMs: 1000 }, cfg)), "BAD_REQUEST");
});

test("jobs.json round-trips, written atomically", () => {
  const cfg = cfgIn(mkdtempSync(join(tmpdir(), "ab-jobs-")));
  saveJobs(cfg, { version: 1, jobs: [{ spec: { id: "x" }, state: { status: "running" } }], launches: [1] });
  assert.equal(loadJobs(cfg).jobs[0].spec.id, "x");
  assert.deepEqual(readdirSync(cfg.stateDir), ["jobs.json"]); // no temp file left
});

test("records read from a cursor, across days, filtered by URL", () => {
  const cfg = cfgIn(mkdtempSync(join(tmpdir(), "ab-jobs-")));
  const dir = jobDir(cfg, "x");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-10-27.ndjson"), ['{"url":"/a","n":1}', '{"url":"/b","n":2}'].join("\n") + "\n");
  writeFileSync(join(dir, "2026-10-28.ndjson"), ['{"url":"/a","n":3}'].join("\n") + "\n");
  let r = readRecords(cfg, "x", { limit: 2 });
  assert.deepEqual(r.records.map((x) => x.n), [1, 2]);
  assert.equal(r.more, true);
  r = readRecords(cfg, "x", { after: r.next });
  assert.deepEqual(r.records.map((x) => x.n), [3]);
  assert.equal(readRecords(cfg, "x", { after: r.next }).records.length, 0);
  assert.deepEqual(readRecords(cfg, "x", { urlPattern: "/a" }).records.map((x) => x.n), [1, 3]);
});

test("pruning removes old days, never today, and folders of removed jobs once quiet", () => {
  const cfg = cfgIn(mkdtempSync(join(tmpdir(), "ab-jobs-")));
  cfg.evidence.retainDays = 14;
  const now = Date.parse("2026-10-28T12:00:00Z");
  const live = jobDir(cfg, "live");
  const gone = jobDir(cfg, "gone");
  mkdirSync(live, { recursive: true });
  mkdirSync(gone, { recursive: true });
  writeFileSync(join(live, "2026-09-01.ndjson"), "{}\n");
  writeFileSync(join(live, "2026-10-28.ndjson"), "{}\n");
  writeFileSync(join(gone, "2026-09-01.ndjson"), "{}\n");
  writeFileSync(join(gone, "log.ndjson"), "{}\n");
  const old = new Date("2026-09-01T00:00:00Z");
  utimesSync(join(gone, "log.ndjson"), old, old);
  pruneJobs(cfg, ["live"], now);
  assert.deepEqual(readdirSync(live), ["2026-10-28.ndjson"]);
  assert.equal(existsSync(gone), false);
});
