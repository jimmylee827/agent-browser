// Network capture in real Google Chrome: what a page sent and received, read
// back by an agent, with secrets gone and the page none the wiser.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startHarness, chromeAvailable, extensionInstalled } from "./harness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ready = chromeAvailable() && extensionInstalled();
const skip = ready ? false : "the test browser is not set up: run `npm run test:e2e:setup` once";
let h;
let A;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (!ready) return;
  h = await startHarness({ log: !!process.env.AB_TEST_LOG });
  assert.ok(h.connected, "the extension in the test browser did not connect; run `npm run test:e2e:setup`");
  A = await h.client(`net-${Date.now()}`);
});
after(async () => h?.stop());

const click = (name, extra = {}) => A("agent_browser_act", { name, role: "button", snapshot: "none", ...extra });
const net = (args = {}) => A("browser_network", args);

test("fetch and XHR bodies are recorded, secrets removed, and the page still works", { skip }, async () => {
  await A("agent_browser_visit", { url: h.url("api.html") });
  await click("Load JSON");
  const page = await A("browser_observe", { mode: "read" });
  assert.match(JSON.stringify(page.data), /items: jacket, tee/, "the page read its own response");
  await click("Send XHR");
  await sleep(800);

  const items = (await net({ urlPattern: "/api/items\\?", includeBodies: true, includeHeaders: true })).data.entries[0];
  assert.equal(items.via, "fetch");
  assert.equal(items.status, 200);
  assert.equal(items.json.items[0].name, "jacket");
  assert.equal(items.json.token, "[redacted]", "a secret field in a response");
  assert.match(items.url, /token=\[redacted\]&q=jacket/, "a secret in the query");
  const auth = items.requestHeaders?.find((x) => x.name.toLowerCase() === "authorization");
  assert.ok(!auth || auth.value === "[redacted]", "the Authorization header");
  assert.ok(!items.responseHeaders?.some((x) => x.name.toLowerCase() === "set-cookie" && x.value !== "[redacted]"), "Set-Cookie");

  const echo = (await net({ urlPattern: "/api/echo", includeBodies: true })).data.entries[0];
  assert.equal(echo.via, "xhr");
  assert.equal(echo.method, "POST");
  assert.match(echo.requestBody, /"password":"\[redacted\]"/);
  assert.match(echo.requestBody, /"q":"x"/);
});

test("visit and act results name the API calls made during the call", { skip }, async () => {
  const r = await click("Load JSON");
  assert.match(r.data.network, /API call.*GET \/api\/items.*200 json/);
});

test("waiting for a response returns it, past the old 25s limit", { skip }, async () => {
  const quick = await A("agent_browser_act", { name: "Load JSON", role: "button", snapshot: "none", waitForResponse: { urlPattern: "/api/items" } });
  assert.equal(quick.data.response.json.items.length, 2);

  const t0 = Date.now();
  const [w] = await Promise.all([
    A("browser_wait", { response: { urlPattern: "/api/slow" }, timeout: 40_000, lookbackMs: 0 }),
    sleep(300).then(() => click("Slow")),
  ]);
  assert.ok(!w.isError, JSON.stringify(w.data));
  assert.equal(w.data.response.json.slow, true);
  assert.ok(Date.now() - t0 > 25_000);

  const miss = await A("browser_wait", { response: { urlPattern: "/never" }, timeout: 1500 });
  assert.equal(miss.data.code, "RESPONSE_TIMEOUT");
  assert.ok(Array.isArray(miss.data.recent));
});

test("a server error and a request that never got an answer are both recorded as failed", { skip }, async () => {
  await click("Fail");
  await click("Offline");
  await sleep(1000);
  const failed = (await net({ status: "failed", type: "all" })).data.entries;
  assert.ok(failed.some((e) => e.status === 500 && /status\/500/.test(e.url)));
  assert.ok(failed.some((e) => e.error && /127\.0\.0\.1:1\//.test(e.url)));
  // And the diagnostics tool still lists failures, as before.
  const d = await A("browser_diagnostics", {});
  assert.ok(d.data.network.some((n) => n.status === 500));
});

test("WebSocket and EventSource messages are recorded, and a flood is capped", { skip }, async () => {
  await click("Socket");
  await click("Stream");
  await click("Flood");
  await sleep(2500);
  const ws = (await net({ type: "ws", includeBodies: true })).data.entries;
  const chat = ws.find((e) => /\/ws$/.test(e.url) && e.frames.some((f) => f.data === "echo:hello"));
  assert.ok(chat, "the echo socket");
  assert.ok(chat.frames.some((f) => f.dir === "out" && f.data === "hello"));
  const flood = ws.find((e) => /flood=1/.test(e.url));
  assert.ok(flood.frames.length <= 200 && flood.dropped > 0, `${flood.frames.length} kept, ${flood.dropped} dropped`);
  const sse = (await net({ type: "sse", includeBodies: true })).data.entries[0];
  assert.deepEqual(sse.frames.map((f) => f.data).slice(0, 3), ["tick 1", "tick 2", "tick 3"]);
});

test("a page cannot tell it is being recorded", { skip }, async () => {
  const r = await A("agent_browser_visit", { url: h.url("api.html"), text: true, snapshot: "none" });
  const checks = r.data.text.match(/(\w+)=(true|false)/g);
  assert.ok(checks.length >= 7);
  assert.deepEqual(checks.filter((c) => c.endsWith("false")), []);
});

test("a same-origin frame is recorded; a cross-origin one is left alone", { skip }, async () => {
  await sleep(1500);
  const frames = (await net({ urlPattern: "from=frame" })).data.entries;
  // The page's hook runs in the same-origin frame: its fetch has a body.
  const same = frames.find((e) => e.via === "fetch");
  assert.ok(same?.bodyPreview?.includes("jacket"), JSON.stringify(frames));
  assert.ok(same.frameUrl?.includes("api-frame.html"));
  // Not in the cross-origin one: webRequest still saw it, with no body.
  const cross = frames.filter((e) => e.via !== "fetch");
  assert.ok(cross.length >= 1);
  assert.ok(cross.every((e) => e.bodyPreview === undefined));
});

test("a blocked domain records no bodies, live from local.json", { skip }, async () => {
  writeFileSync(h.localConfig, JSON.stringify({ network: { blockedDomains: ["localhost"] } }));
  await sleep(5000); // watched every 2s, then pushed to the extension
  const since = Date.now();
  const blocked = await A("agent_browser_visit", { url: h.url("api.html").replace("127.0.0.1", "localhost") });
  assert.ok(!blocked.isError);
  await click("Load JSON");
  await sleep(800);
  const q = (await net({ urlPattern: "/api/items", includeBodies: true, since })).data;
  assert.ok(q.entries.length >= 1, "the request is still listed");
  assert.equal(q.note?.includes("blockedDomains"), true);
  assert.ok(q.entries.every((e) => e.json === undefined && e.body === undefined));
  writeFileSync(h.localConfig, "{}");
  await sleep(5000);
});

test("HAR and NDJSON exports land in the session's evidence folder", { skip }, async () => {
  await A("agent_browser_visit", { url: h.url("api.html") });
  await click("Load JSON");
  await sleep(800);
  const har = (await net({ action: "export", format: "har" })).data;
  const parsed = JSON.parse(readFileSync(har.file, "utf8"));
  assert.equal(parsed.log.version, "1.2");
  assert.ok(parsed.log.entries.some((e) => /api\/items/.test(e.request.url) && /jacket/.test(e.response.content.text)));
  assert.ok(har.file.startsWith(h.state));
  const nd = (await net({ action: "export", format: "ndjson" })).data;
  const lines = readFileSync(nd.file, "utf8").trim().split("\n");
  assert.ok(lines.length >= 1 && JSON.parse(lines[0]).url);
});

test("the CLI reads the same record", { skip }, async () => {
  const tabId = (await A("browser_ping", {})).data.tab.id;
  const r = spawnSync(process.execPath, [resolve(root, "scripts/ab.mjs"), "network", "--tab", String(tabId), "--url", "/api/items", "--json"], {
    env: { ...process.env, AB_CONTROL_PORT: new URL(h.base).port },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).entries.some((e) => /api\/items/.test(e.url)));
});

test("a closed tab's record goes with it", { skip }, async () => {
  const B = await h.client(`net-close-${Date.now()}`);
  const v = await B("agent_browser_visit", { url: h.url("api.html") });
  await B("agent_browser_act", { name: "Load JSON", role: "button", snapshot: "none" });
  await B("browser_tabs", { action: "close", tabId: v.data.tabId });
  await sleep(500);
  const r = await A("browser_network", { tabId: v.data.tabId });
  assert.equal(r.isError, true, "the tab is gone");
});
