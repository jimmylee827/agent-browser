import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeBrowserOperation } from "../../packages/mcp-server/dist/command-dispatch.js";
import { SessionManager, resolveKey } from "../../packages/mcp-server/dist/sessions.js";

function harness(options = {}) {
  const calls = [], sessions = new SessionManager();
  const s = sessions.get(resolveKey("test"), "test");
  sessions.bind(s, 1, 10);
  let activated = 0, lookups = 0;
  const entry = { id: 1, ts: Date.now(), method: "POST", url: "https://example.test/api", status: 200, body: '{"ok":true}', mimeType: "application/json" };
  const ctx = {
    sessions, client: { id: "test" }, warnedStale: new Set(),
    audit: { log() {} }, input: {},
    policy: { evaluate: () => ({ allow: !options.policyBlocked, reason: "policy test" }) },
    admission: { check() { if (options.paused) throw Object.assign(new Error("host paused"), { code: "HOST_PAUSED" }); }, list: () => [], observe() {}, pause() {} },
    cfg: { stateDir: "/nonexistent-ab-test-state", profileDir: "/nonexistent-profile", evidence: { enabled: false }, network: { redactHeaders: [] }, eval: { blockedDomains: [] } },
    bridge: { connected: () => true, request: async (method, args = {}) => {
      calls.push({ method, args });
      if (method === "engine.ping") return { tab: { id: 1, windowId: 10, url: "https://example.test/", incognito: !!options.incognito, navCount: 1 }, engine: { title: "test" } };
      if (method === "engine.incognitoAccess") return { allowed: options.permission !== false };
      if (method === "engine.openedFrom") return { opened: [] };
      if (method === "engine.downloads") return { scope: "browser-wide", attribution: "unknown", downloads: [{ id: args.id ?? 10, state: "interrupted", error: "NETWORK_FAILED", incognito: true }] };
      if (method === "engine.locate") return { matches: options.missOnce && lookups++ === 0 ? [] : [{ ref: 5, role: "button", name: "Send" }], snapshotGeneration: 1 };
      if (method === "engine.robustClick" || method === "engine.act") {
        activated++;
        if (options.lostReply) throw new Error("message channel closed");
        return { dispatch: "completed", acted: true, changed: false, strategy: args.strategy || "pointer", signals: {} };
      }
      if (method === "engine.observe") {
        if (options.snapshotFailure) throw new Error("snapshot failed");
        return { url: "https://example.test/", tree: [{ role: "button", name: "Send" }] };
      }
      if (method === "engine.setViewport") return { viewport: { width: 390, height: 575 }, note: "asked 390x844, got 390x575" };
      if (method === "engine.post") { activated++; return { dispatch: "completed", response: { status: 200, body: "ok" } }; }
      if (method === "net.query") return { entries: options.response && args.urlPattern ? [entry] : [], matched: 0, total: 0 };
      return {};
    } },
  };
  const invoke = async (name, args) => {
    const result = await invokeBrowserOperation(ctx, name, args);
    return { ...result, data: JSON.parse(result.content.find((c) => c.type === "text").text) };
  };
  return { ctx, s, calls, invoke, count: () => activated };
}

test("shared command handler runs robust as primary once; matching response suppresses noEffect", async () => {
  const h = harness({ response: true });
  const r = await h.invoke("agent_browser_act", { name: "Send", robust: "always", waitForResponse: { urlPattern: "/api" } });
  assert.equal(h.count(), 1);
  assert.equal(h.calls.some((c) => c.method === "engine.act"), false);
  assert.equal(r.data.dispatch, "completed");
  assert.equal(r.data.actionOutcome, "response_received");
  assert.equal(r.data.noEffect, undefined);
});
test("standalone robust recovery selects one explicit strategy", async () => {
  const h = harness();
  const r = await h.invoke("browser_robust_click", { ref: 5, strategy: "native", hydrationTimeoutMs: 0 });
  assert.equal(h.count(), 1);
  assert.equal(h.calls.find((c) => c.method === "engine.robustClick").args.strategy, "native");
  assert.equal(r.data.dispatch, "completed");
  assert.equal(r.data.businessSuccess, "not_verified");
});
test("response timeout preserves dispatched activation and snapshot", async () => {
  const h = harness();
  const r = await h.invoke("agent_browser_act", { name: "Send", waitForResponse: { urlPattern: "/missing", timeout: 100 } });
  assert.equal(h.count(), 1);
  assert.equal(r.data.dispatch, "completed");
  assert.equal(r.data.responseError.code, "RESPONSE_TIMEOUT");
  assert.ok(r.data.snapshotAfter.tree);
  assert.equal(JSON.stringify(r.data).includes("not done"), false);
});
test("lost reply and failed snapshot do not invent success or replay", async () => {
  const h = harness({ lostReply: true, snapshotFailure: true });
  const r = await h.invoke("agent_browser_act", { name: "Send" });
  assert.equal(h.count(), 1);
  assert.equal(r.data.dispatch, "unknown");
  assert.equal(r.data.actionOutcome, "unknown");
  assert.equal(r.data.acted, undefined);
});
test("lookup miss refreshes and retries only the same selector before activation", async () => {
  const h = harness({ missOnce: true });
  await h.invoke("agent_browser_act", { name: "Send", role: "button" });
  const lookups = h.calls.filter((c) => c.method === "engine.locate");
  assert.equal(lookups.length, 2);
  assert.deepEqual(lookups[0].args, lookups[1].args);
  assert.equal(h.count(), 1);
});
test("host pause prevents activation but leaves cooldown inspection available", async () => {
  const h = harness({ paused: true });
  const r = await h.invoke("agent_browser_act", { name: "Send" });
  assert.equal(r.data.code, "HOST_PAUSED");
  assert.equal(h.count(), 0);
  assert.deepEqual((await h.invoke("browser_cooldowns", {})).data.pauses, []);
});
test("strict viewport blocks dispatch; best-effort reports structured dimensions", async () => {
  const h = harness(); h.s.viewport = { width: 390, height: 844 }; h.s.strictViewport = true;
  const blocked = await h.invoke("agent_browser_act", { name: "Send" });
  assert.equal(blocked.data.code, "VIEWPORT_MISMATCH"); assert.equal(h.count(), 0);
  h.s.strictViewport = false;
  const r = await h.invoke("agent_browser_act", { name: "Send" });
  assert.equal(h.count(), 1); assert.equal(r.data.viewport.height, 575); assert.equal(r.data.requestedViewport.height, 844);
});
test("adopted Incognito context is labelled and recording persistence disclosed", async () => {
  const h = harness({ incognito: true });
  const r = await h.invoke("agent_browser_act", { name: "Send" });
  assert.equal(h.s.incognito, true); assert.equal(r.data.incognito, true);
  assert.match(r.data.warning, /records evidence\/traffic on disk/);
  assert.equal(h.s.opened, undefined, "adoption does not grant teardown ownership");
});
test("disabled Incognito permission does not fall back to regular activation", async () => {
  const h = harness({ incognito: true, permission: false });
  const r = await h.invoke("agent_browser_act", { name: "Send" });
  assert.equal(r.data.code, "INCOGNITO_UNAVAILABLE"); assert.equal(h.count(), 0);
});
test("POST policy gates before dispatch; ordinary POST shares the outcome contract", async () => {
  const h = harness({ policyBlocked: true });
  const args = { url: "https://example.test/api", mode: "fetch", encoding: "json", body: '{"x":1}', actionClass: "payment" };
  const denied = await h.invoke("browser_post", args);
  assert.equal(denied.data.code, "POLICY_BLOCKED"); assert.equal(h.count(), 0);
  const allowed = harness();
  const r = await allowed.invoke("browser_post", args);
  assert.equal(allowed.count(), 1); assert.equal(r.data.actionOutcome, "response_received");
});
test("download inspection preserves actual error/private metadata without invented tab attribution", async () => {
  const h = harness();
  const r = await h.invoke("browser_downloads", { id: 27 });
  assert.equal(r.data.scope, "browser-wide");
  assert.equal(r.data.attribution, "unknown");
  assert.equal(r.data.downloads[0].id, 27);
  assert.equal(r.data.downloads[0].error, "NETWORK_FAILED");
  assert.equal(r.data.downloads[0].incognito, true);
  assert.equal(h.count(), 0);
});

test("all command schemas reject unknown inputs before running", async () => {
  const h = harness();
  await assert.rejects(h.invoke("agent_browser_act", { name: "Send", nonsense: true }));
  assert.equal(h.count(), 0);
});
