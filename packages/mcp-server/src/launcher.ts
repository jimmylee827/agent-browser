#!/usr/bin/env node
// Stdio entry point for MCP clients (Claude Code et al.). It is what a client
// registers, and it is always startable, so the browser tools exist in every
// session — even when the daemon, the bridge and Chrome are all off.
//
// Why this exists: the daemon serves MCP over HTTP, and a client that starts a
// session while the daemon is down registers no tools from it and never looks
// again. The agent then has no tool with which to bring the browser up.
//
// The launcher lists the tools from the same code the daemon runs (so the list
// cannot drift), and forwards every call to the daemon over HTTP — starting the
// daemon first when it is down. Status calls report "off" without starting
// anything, and nothing is started while the kill switch is on.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { registerTools, HALT_ADVICE } from "./tools/index.js";

const cfg = loadConfig();
const here = dirname(fileURLToPath(import.meta.url));
const LABEL = "com.agent-browser.mcp-server";
const PLIST = resolve(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const BASE = `http://${cfg.bridge.host}:${cfg.bridge.controlPort}`;
const STATUS_TOOLS = new Set(["agent_browser_status", "browser_status"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (data: unknown, isError = false) => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

/** The tool list, taken from registerTools itself. Registration calls nothing
 *  on ctx, so a stub is enough to read names, descriptions and schemas. */
async function localToolList() {
  const s = new McpServer({ name: "agent-browser", version: "0.0.1" });
  registerTools(s, {} as Parameters<typeof registerTools>[1]);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await s.connect(a);
  const c = new Client({ name: "agent-browser-launcher", version: "0.0.1" });
  await c.connect(b);
  const { tools } = await c.listTools();
  await c.close();
  return tools;
}

async function daemonUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

const launchctl = (...args: string[]) => {
  try {
    execFileSync("launchctl", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** Start the daemon by the most durable route available, and wait for it. */
async function startDaemon(): Promise<{ via: string } | { error: string }> {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  let via: string;
  if (launchctl("print", `${domain}/${LABEL}`)) {
    via = "launchd (restarted)";
    launchctl("kickstart", "-k", `${domain}/${LABEL}`);
  } else if (existsSync(PLIST)) {
    via = "launchd (loaded)";
    launchctl("bootstrap", domain, PLIST);
  } else {
    // Not installed as a daemon: run it as a detached process for now. It
    // won't survive a logout; `npm run mcp:install` makes it permanent.
    via = "detached process";
    mkdirSync(cfg.stateDir, { recursive: true });
    const log = openSync(resolve(cfg.stateDir, "mcp-server.err.log"), "a");
    spawn(process.execPath, [resolve(here, "index.js")], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, AB_DISABLE_STDIO_MCP: "1" },
    }).unref();
  }
  for (let t0 = Date.now(); Date.now() - t0 < 15_000; ) {
    if (await daemonUp()) return { via };
    await sleep(300);
  }
  return { error: `the browser server did not come up within 15s (tried: ${via}); see ${cfg.stateDir}/mcp-server.err.log` };
}

const halted = () => existsSync(resolve(cfg.stateDir, "HALT"));

async function forward(name: string, args: Record<string, unknown> | undefined) {
  // A fresh client per call: the daemon's HTTP transport is stateless, a local
  // handshake costs milliseconds, and nothing goes stale across a daemon restart.
  const c = new Client({ name: "agent-browser-launcher", version: "0.0.1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  try {
    // Full-page captures and a cold browser launch both take a while.
    return await c.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  } finally {
    await c.close().catch(() => {});
  }
}

async function main() {
  const tools = await localToolList();
  const server = new Server({ name: "agent-browser", version: "0.0.1" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (!(await daemonUp())) {
      if (STATUS_TOOLS.has(name))
        return text({
          serverRunning: false,
          bridgeConnected: false,
          ready: false,
          hint: "the browser is off; agent_browser_ensure_running (or any browser tool) starts it",
        });
      if (halted()) return text({ error: "HALTED: kill switch active", recovery: HALT_ADVICE }, true);
      const started = await startDaemon();
      if ("error" in started)
        return text({ error: started.error, recovery: "run `npm run mcp:install` in the agent-browser repo and read its output" }, true);
      process.stderr.write(`[agent-browser launcher] started the server via ${started.via}\n`);
    }
    try {
      return (await forward(name, args)) as ReturnType<typeof text>;
    } catch (e) {
      // Never retry here: the call may have reached the daemon and acted.
      return text({ error: `could not reach the browser server: ${(e as Error).message}`, recovery: "check agent_browser_status before retrying — the action may have run" }, true);
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`[agent-browser launcher] fatal: ${(e as Error).stack}\n`);
  process.exit(1);
});
