import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { Bridge } from "../../packages/mcp-server/dist/bridge/server.js";
import { loadConfig } from "../../packages/mcp-server/dist/config.js";

async function openBridge(t) {
  const cfg = loadConfig();
  cfg.bridge.port = 0;
  cfg.bridge.host = "127.0.0.1";
  cfg.stateDir = "/nonexistent-ab-bridge-test-state";
  const bridge = new Bridge(cfg, "fixture-secret", { log() {} });
  bridge.start();
  const server = bridge.wss;
  await once(server, "listening");
  t.after(() => {
    for (const socket of server.clients) socket.terminate();
    server.close();
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  await once(socket, "open");
  async function authenticate() {
    const probe = new Promise((resolve) => socket.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id) resolve(msg);
    }));
    socket.send(JSON.stringify({ type: "auth", secret: "fixture-secret" }));
    return probe;
  }
  return { bridge, socket, authenticate };
}

test("an authenticated socket is not ready until the tab-independent worker probe answers", async (t) => {
  const { bridge, socket, authenticate } = await openBridge(t);
  const probe = await authenticate();
  assert.equal(probe.method, "engine.incognitoAccess");
  assert.equal(bridge.connected(), false);
  await assert.rejects(bridge.request("engine.act"), (e) => e.code === "BRIDGE_DOWN" && e.detail.bridgeNotSent);
  socket.send(JSON.stringify({ id: probe.id, ok: true, result: { allowed: false } }));
  assert.equal(await bridge.waitForConnection(1000), true);
  assert.equal(bridge.healthyEpoch, 0, "an initial response does not reset the wake allowance");
});

test("a possibly dispatched action is never replayed when its socket closes", async (t) => {
  const { bridge, socket, authenticate } = await openBridge(t);
  const probe = await authenticate();
  socket.send(JSON.stringify({ id: probe.id, ok: true, result: { allowed: false } }));
  assert.equal(await bridge.waitForConnection(1000), true);
  const message = once(socket, "message");
  const action = assert.rejects(bridge.request("engine.act"), /BRIDGE_DROPPED/);
  const [raw] = await message;
  assert.equal(JSON.parse(raw).method, "engine.act");
  socket.close();
  await action;
  await delay(20);
  assert.equal(bridge.connected(), false);
});
