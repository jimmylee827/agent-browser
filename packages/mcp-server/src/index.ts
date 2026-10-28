#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, ensureBridgeSecret } from "./config.js";
import { Audit } from "./audit.js";
import { Bridge } from "./bridge/server.js";
import { Policy } from "./policy.js";
import { SessionManager } from "./sessions.js";
import { startControl, type ClientInfo } from "./control.js";
import { registerTools } from "./tools/index.js";
import { buildId, RUNNING } from "./build.js";
import { pruneEvidence } from "./evidence.js";
import { InputHelper } from "./input.js";

async function main() {
  const cfg = loadConfig();
  const secret = ensureBridgeSecret(cfg);
  const audit = new Audit(cfg.audit.file);

  const bridge = new Bridge(cfg, secret, audit);
  bridge.start();

  // One session registry for the daemon's whole life. The HTTP transport makes
  // a fresh McpServer per request, so anything created per server — as the
  // session registry once was — forgets everything between calls.
  const sessions = new SessionManager();
  const policy = new Policy(cfg);
  const warnedStale = new Set<string>();
  const input = new InputHelper(cfg.input);
  const makeServer = (client: ClientInfo): McpServer => {
    const s = new McpServer({ name: "agent-browser", version: "0.0.1" });
    registerTools(s, { bridge, policy, sessions, audit, cfg, client, warnedStale, input });
    return s;
  };

  // A client that went away leaves its windows behind; close them.
  const releaseClient = async (id: string) => {
    let closed = 0;
    for (const s of sessions.release(id)) {
      if (s.windowId === undefined) continue;
      await bridge.request("engine.closeWindow", { windowId: s.windowId }).then(() => closed++, () => {});
    }
    audit.log("session.release", { client: id.slice(0, 8), closed });
    return closed;
  };
  // A private session idle for two hours lets go of its window (left open, in
  // case a person is looking at it) so it can't be driven by a stale caller.
  setInterval(() => {
    for (const s of sessions.idle(2 * 3600_000)) {
      audit.log("session.idle_unbind", { session: s.key.slice(0, 12), tabId: s.tabId });
      sessions.unbind(s);
    }
  }, 600_000).unref();
  if (cfg.evidence.enabled) pruneEvidence(cfg);

  // Transport 1: stdio — for direct `node packages/mcp-server/dist/index.js`
  // launches (Claude Code et al.). Skip if AB_DISABLE_STDIO_MCP=1 (Docker mode
  // where stdin is closed and stdio would log noisy EOF errors).
  if (process.env.AB_DISABLE_STDIO_MCP !== "1") {
    const stdioServer = makeServer({ id: "stdio" });
    const stdio = new StdioServerTransport();
    await stdioServer.connect(stdio);
  }

  // Transport 2: Streamable HTTP — for any HTTP-capable MCP client.
  // The control plane (control.ts) mounts it under POST /mcp.
  startControl(cfg, bridge, audit, {
    makeMcpServer: makeServer,
    makeHttpTransport: () => new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }), // stateless
    releaseClient,
  });

  // Say why we stopped. A daemon booted out by launchd, or killed, used to
  // leave a log of "MCP up" lines and nothing else.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      audit.log("mcp.stopped", { signal: sig });
      process.stderr.write(`[agent-browser] stopping on ${sig} at ${new Date().toISOString()}\n`);
      process.exit(0);
    });
  }

  audit.log("mcp.started", { bridgePort: cfg.bridge.port, build: buildId(RUNNING) });
  process.stderr.write(
    `[agent-browser] MCP up. Bridge :${cfg.bridge.port}  ` +
      `Control plane + HTTP MCP :${cfg.bridge.controlPort} (POST /mcp). Build ${buildId(RUNNING)}.\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`[agent-browser] fatal: ${(e as Error).stack}\n`);
  process.exit(1);
});
