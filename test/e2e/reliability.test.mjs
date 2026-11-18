import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { startHarness, chromeAvailable, extensionInstalled } from "./harness.mjs";

const ready = chromeAvailable() && extensionInstalled();
const skip = ready ? false : "isolated real Chrome extension setup required";
let h, A;
before(async () => {
  if (!ready) return;
  h = await startHarness({ log: !!process.env.AB_TEST_LOG });
  assert.ok(h.connected, "test extension did not connect");
  A = await h.client(`reliability-${Date.now()}`);
});
after(async () => h?.stop());
const probe = async (id) => (await fetch(h.url(`api/operation-probe?id=${id}`))).json();

test("fetch-only and delayed handlers each produce one request per robust invocation", { skip }, async () => {
  for (const [name, robust] of [["Fetch only", "auto"], ["Delayed fetch", "always"]]) {
    const id = `click-${Date.now()}`;
    assert.ok(!(await A("agent_browser_visit", { url: h.url(`reliability.html?id=${id}`) })).isError);
    const r = await A("agent_browser_act", { name, robust, waitForResponse: { urlPattern: `operation-probe\\?id=${id}`, timeout: 5000 } });
    assert.equal(r.data.dispatch, "completed", JSON.stringify(r.data));
    assert.equal(r.data.actionOutcome, "response_received");
    assert.equal(r.data.noEffect, undefined);
    assert.equal((await probe(id)).count, 1);
  }
});

test("navigation headers arrive on first request and do not persist", { skip }, async () => {
  const r = await A("agent_browser_visit", { url: h.url("probe-nav"), headers: { "x-ab-probe": "first-navigation" }, text: true });
  assert.ok(!r.isError, JSON.stringify(r.data));
  assert.match(r.data.text, /first-navigation/);
  const next = await A("agent_browser_visit", { url: h.url("probe-nav"), text: true });
  assert.match(next.data.text, /"probe":null/);
});

test("navigation headers do not leak across origins on redirects", { skip }, async () => {
  const r = await A("agent_browser_visit", { url: h.url("probe-redirect"), headers: { "x-ab-probe": "must-not-leak" }, text: true });
  assert.ok(!r.isError, JSON.stringify(r.data));
  assert.match(r.data.text, /"probe":null/);
});

test("explicit fetch and form POST each submit once and preserve their encodings", { skip }, async () => {
  for (const [mode, encoding] of [["fetch", "json"], ["form", "form"]]) {
    await A("agent_browser_visit", { url: h.url("reliability.html") });
    const id = `post-${mode}-${Date.now()}`;
    const r = await A("browser_post", { url: h.url(`api/operation-probe?id=${id}`), mode, encoding,
      ...(encoding === "json" ? { body: '{"q":"test"}' } : { fields: [["q", "test"], ["submit", "go"]] }) });
    assert.equal(r.data.dispatch, "completed", JSON.stringify(r.data));
    const p = await probe(id);
    assert.equal(p.count, 1);
    assert.match(p.records[0].headers["content-type"], encoding === "json" ? /application\/json/ : /application\/x-www-form-urlencoded/);
  }
});

test("CSP failure does not switch transport or dispatch a second request", { skip }, async () => {
  await A("agent_browser_visit", { url: h.url("csp-post.html") });
  const id = `csp-${Date.now()}`;
  const r = await A("browser_post", { url: h.url(`api/operation-probe?id=${id}`), mode: "fetch", encoding: "text", body: "test", timeoutMs: 1000 });
  assert.equal(r.data.dispatch, "unknown", JSON.stringify(r.data));
  assert.ok(r.data.error);
  assert.equal((await probe(id)).count, 0);
});

test("Incognito regular/private separation, shared private cookies and evidence warning", { skip }, async (t) => {
  const key = `ab_test_${Date.now()}`;
  const url = h.url(`reliability.html?cookie=${key}`);
  await A("agent_browser_visit", { url });
  await A("agent_browser_act", { name: "Set normal cookie" });
  const B = await h.client(`private-a-${Date.now()}`);
  const created = await B("agent_browser_visit", { url, incognito: true });
  if (created.data.code === "INCOGNITO_UNAVAILABLE") { t.skip("user must enable Allow in Incognito for the isolated test extension"); return; }
  assert.ok(!created.isError, JSON.stringify(created.data));
  assert.equal(created.data.incognito, true);
  assert.match(created.data.warning, /records evidence\/traffic on disk/);
  const before = await B("browser_eval", { expression: "document.cookie" });
  assert.equal(before.data.value.includes(`${key}=normal`), false);
  await B("agent_browser_act", { name: "Set private cookie" });
  const privateClient = `private-b-${Date.now()}`;
  const C = await h.client(privateClient);
  const second = await C("agent_browser_visit", { url, incognito: true });
  assert.ok(!second.isError, JSON.stringify(second.data));
  assert.match((await C("browser_eval", { expression: "document.cookie" })).data.value, new RegExp(`${key}=private`));
  assert.match((await A("browser_eval", { expression: "document.cookie" })).data.value, new RegExp(`${key}=normal`));
  assert.ok(created.data.evidence?.file, "private evidence persists as explicitly selected");
  assert.ok((await B("browser_tabs", {})).data.tabs.find((t) => t.tabId === created.data.tabId)?.incognito);

  // A deliberate legacy new-tab operation creates an unowned, user-like tab
  // in the private window; adopt it explicitly, then release that adopter.
  const focused = await B("agent_browser_act", { name: "Set private cookie", focusWindow: true });
  assert.ok(!focused.isError, JSON.stringify(focused.data));
  const userTab = await B("browser_tabs", { session: "default", action: "new", url });
  const external = userTab.data.tabs.find((t) => t.tabId === userTab.data.createdTabId);
  assert.ok(external?.incognito, JSON.stringify(userTab.data));
  const adopterId = `adopter-${Date.now()}`;
  const D = await h.client(adopterId);
  assert.ok(!(await D("browser_tabs", { action: "switch", tabId: external.tabId })).isError);
  const released = await fetch(`${h.base}/session/release?client=${encodeURIComponent(adopterId)}`, { method: "POST" });
  assert.equal(released.status, 200);
  let tabs = (await B("browser_tabs", {})).data.tabs;
  assert.ok(tabs.some((t) => t.tabId === external.tabId), "adopted private tab survives release");
  await fetch(`${h.base}/session/release?client=${encodeURIComponent(privateClient)}`, { method: "POST" });
  tabs = (await B("browser_tabs", {})).data.tabs;
  assert.equal(tabs.some((t) => t.tabId === second.data.tabId), false, "agent-created private tab closes on release");
});

test("CLI dispatch uses the same registered handler and JSON output", { skip }, async () => {
  const r = spawnSync(process.execPath, ["scripts/ab.mjs", "cooldowns", "--json"], { env: { ...process.env, AB_CONTROL_PORT: new URL(h.base).port }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Array.isArray(JSON.parse(r.stdout).pauses));
});

test("visit uses the final document status, not a background HTTP error", { skip }, async () => {
  const page = await A("agent_browser_visit", { url: h.url("visit-evidence/background"), snapshot: "none" });
  assert.equal(page.data.visit?.kind, "content", JSON.stringify(page.data));
  assert.equal(page.data.visit.httpStatus, 200);
  const denied = await A("agent_browser_visit", { url: h.url("visit-evidence/redirect"), snapshot: "none" });
  assert.equal(denied.data.outcome, "blocked", JSON.stringify(denied.data));
  assert.equal(denied.data.visit.httpStatus, 403);
  assert.ok(denied.data.url.endsWith("/denied"));
  assert.ok(denied.data.degraded.length);
  const reload = await A("agent_browser_visit", { history: "reload", snapshot: "none" });
  assert.equal(reload.data.visit?.httpStatus, 403, JSON.stringify(reload.data));
});

test("failed main-document transport is not a landed HTTP error", { skip }, async () => {
  const r = await A("agent_browser_visit", { url: h.url("visit-evidence/disconnect"), snapshot: "none" });
  assert.equal(r.isError, true, JSON.stringify(r.data));
  assert.equal(r.data.code, "LOAD_FAILED", JSON.stringify(r.data));
  assert.equal(r.data.visit?.kind, "transport_failure");
  assert.equal(r.data.visit?.httpStatus, undefined);
});

test("visible sign-in form is a human gate, not empty content", { skip }, async () => {
  const r = await A("agent_browser_visit", { url: h.url("evidence.html?login"), snapshot: "none" });
  assert.equal(r.data.visit?.kind, "login_required", JSON.stringify(r.data));
  assert.equal(r.data.outcome, "needs_human");
  assert.match(r.data.visit.nextStep, /user to sign in/);
});

test("single action distinguishes foreground, selection, weak mutation and route evidence", { skip }, async () => {
  await A("agent_browser_visit", { url: h.url("evidence.html") });
  const foreground = await A("agent_browser_act", { name: "Continue", role: "button", expect: { kind: "heading", name: "Foreground chosen" } });
  assert.equal(foreground.data.expectation?.state, "satisfied", JSON.stringify(foreground.data));
  assert.equal(foreground.data.activationTarget?.tag, "button");
  const selected = await A("agent_browser_act", { name: "Select plan", expect: { kind: "selected", name: "Select plan" } });
  assert.equal(selected.data.expectation?.state, "satisfied", JSON.stringify(selected.data));
  const quiet = await A("agent_browser_act", { name: "Activity only", expect: { kind: "selected", name: "Other plan" }, snapshot: "none" });
  assert.equal(quiet.data.expectation?.state, "unmet", JSON.stringify(quiet.data));
  assert.equal(quiet.data.evidenceStrength, "activity_only");
  assert.equal(quiet.data.automaticRetryAllowed, false);
  const check = await A("agent_browser_act", { name: "Verify count", expect: { kind: "heading", name: "Count 1" } });
  assert.equal(check.data.expectation?.state, "satisfied", JSON.stringify(check.data));
  const moved = await A("agent_browser_act", { name: "Same-document route", expect: { kind: "url", includes: "#routed" }, snapshot: "none" });
  assert.equal(moved.data.navigation, "route", JSON.stringify(moved.data));
  assert.equal(moved.data.navigated, true);
  assert.equal(moved.data.signals.navigated, true);
  const tie = await A("agent_browser_act", { name: "Duplicate", role: "button" });
  assert.equal(tie.data.code, "AMBIGUOUS_MATCH", JSON.stringify(tie.data));
  assert.equal(tie.data.dispatch, "not_dispatched");
  assert.equal(tie.data.candidates.length, 2);
});

test("ordinary article is not blocked; static block pauses subsequent host actions", { skip }, async () => {
  const article = await A("agent_browser_visit", { url: h.url("block-article.html") });
  assert.notEqual(article.data.outcome, "blocked");
  const blocked = await A("agent_browser_visit", { url: h.url("static-block.html") });
  assert.equal(blocked.data.outcome, "blocked", JSON.stringify(blocked.data));
  const next = await A("agent_browser_visit", { url: h.url("index.html") });
  assert.equal(next.data.code, "HOST_PAUSED");
  const inspect = await A("browser_observe", { mode: "read" });
  assert.ok(!inspect.isError);
  const override = await A("agent_browser_visit", { url: h.url("index.html"), overrideCooldown: true });
  assert.ok(!override.isError, JSON.stringify(override.data));
});
