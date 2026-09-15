#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, ensureBridgeSecret } from "./config.js";
import { Audit } from "./audit.js";
import { Bridge } from "./bridge/server.js";
import { Policy } from "./policy.js";
import { SessionManager } from "./sessions.js";
import { startControl } from "./control.js";
import { registerTools } from "./tools/index.js";

async function main() {
  const cfg = loadConfig();
  const secret = ensureBridgeSecret(cfg);
  const audit = new Audit(cfg.audit.file);

  const bridge = new Bridge(cfg, secret, audit);
  bridge.start();

  // Factory: each MCP transport gets its OWN McpServer instance (stateless HTTP
  // sessions are simplest when we don't share state across transports).
  const makeServer = (): McpServer => {
    const s = new McpServer({ name: "agent-browser", version: "0.0.1" });
    registerTools(s, {
      bridge,
      policy: new Policy(cfg),
      sessions: new SessionManager(),
      audit,
      cfg,
    });
    return s;
  };

  // Transport 1: stdio — for direct `node packages/mcp-server/dist/index.js`
  // launches (Claude Code et al.). Skip if AB_DISABLE_STDIO_MCP=1 (Docker mode
  // where stdin is closed and stdio would log noisy EOF errors).
  if (process.env.AB_DISABLE_STDIO_MCP !== "1") {
    const stdioServer = makeServer();
    const stdio = new StdioServerTransport();
    await stdioServer.connect(stdio);
  }

  // Transport 2: Streamable HTTP — for any HTTP-capable MCP client.
  // The control plane (control.ts) mounts it under POST /mcp.
  startControl(cfg, bridge, audit, {
    makeMcpServer: makeServer,
    makeHttpTransport: () => new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }), // stateless
  });

  audit.log("mcp.started", { bridgePort: cfg.bridge.port });
  process.stderr.write(
    `[agent-browser] MCP up. Bridge :${cfg.bridge.port}  ` +
      `Control plane + HTTP MCP :${cfg.bridge.controlPort} (POST /mcp).\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`[agent-browser] fatal: ${(e as Error).stack}\n`);
  process.exit(1);
});
