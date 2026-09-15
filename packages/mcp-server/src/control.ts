import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AppConfig } from "./config.js";
import type { Bridge } from "./bridge/server.js";
import type { Audit } from "./audit.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

interface McpHooks {
  makeMcpServer: () => McpServer;
  makeHttpTransport: () => StreamableHTTPServerTransport;
}

// Tiny localhost control plane so scripts/diagnostics talk to ONE persistent
// server (no per-test ephemeral servers racing the extension SW). Also hosts
// the Streamable HTTP MCP transport under POST /mcp.

export function startControl(
  cfg: AppConfig,
  bridge: Bridge,
  audit: Audit,
  mcp?: McpHooks,
): void {
  const send = (res: ServerResponse, code: number, body: unknown) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
    res.end(s);
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const ip = req.socket.remoteAddress ?? "";
    const inContainer = process.env.AB_BIND_HOST === "0.0.0.0";
    // On host: enforce loopback-only here. In container: the published port
    // is bound to 127.0.0.1 on the host side, so trust the forwarder.
    if (!inContainer && ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // ── Streamable HTTP MCP transport ──────────────────────────────────────
    // POST /mcp     — JSON-RPC over HTTP (single request/response)
    // GET  /mcp     — SSE stream (for server-initiated messages)
    // DELETE /mcp   — session close (stateless mode: no-op)
    if (url.pathname === "/mcp" && mcp) {
      try {
        // Stateless: spin up a fresh server+transport per request. Avoids
        // session bookkeeping; matches the way agents typically use MCP.
        const server = mcp.makeMcpServer();
        const transport = mcp.makeHttpTransport();
        res.on("close", () => {
          transport.close().catch(() => {});
        });
        await server.connect(transport);
        // Per the MCP SDK example, hand the raw req/res to the transport.
        await transport.handleRequest(req, res);
        return;
      } catch (e) {
        if (!res.headersSent) send(res, 500, { error: (e as Error).message });
        return;
      }
    }

    try {
      if (url.pathname === "/status") {
        return send(res, 200, { bridgeConnected: bridge.connected() });
      }
      if (url.pathname === "/ping") {
        return send(res, 200, await bridge.request("engine.ping", {}));
      }
      if (url.pathname === "/observe") {
        return send(res, 200, await bridge.request("engine.observe", {
          mode: url.searchParams.get("mode") ?? "semantic",
        }));
      }
      if (url.pathname === "/locate") {
        return send(res, 200, await bridge.request("engine.locate", {
          role: url.searchParams.get("role") ?? undefined,
          name: url.searchParams.get("name") ?? undefined,
        }));
      }
      if (url.pathname === "/wait") {
        return send(res, 200, await bridge.request("engine.waitForStable", {}));
      }
      if (url.pathname === "/visit") {
        // High-level visit: GENERAL policy (no allowlist restriction, only
        // sensitive-action escalation), navigate, wait for the new page to be
        // reachable (committed + content script injectable), wait-for-stable,
        // return a compact accessibility-tree snapshot.
        const to = url.searchParams.get("url") ?? "";
        let host = "";
        try { host = new URL(to).hostname; } catch { return send(res, 400, { error: "bad url" }); }
        if (!host) return send(res, 400, { error: "missing url" });
        audit.log("control.visit", { host });
        await bridge.request("engine.navigate", { url: to });

        // Poll engine.ping until the active tab has committed to the new
        // origin AND the content engine answers. Up to 15s for slow loads.
        const target = new URL(to);
        const wantHost = target.hostname;
        const t0 = Date.now();
        let lastErr = "navigation did not commit";
        while (Date.now() - t0 < 15000) {
          await new Promise((r) => setTimeout(r, 400));
          try {
            const p = (await bridge.request("engine.ping", {})) as {
              tab?: { url?: string };
              engine?: { error?: string; url?: string };
            };
            const tabUrl = p.tab?.url ?? "";
            const engineErr = p.engine?.error;
            if (engineErr) { lastErr = engineErr; continue; }
            if (!tabUrl) continue;
            try {
              const h = new URL(tabUrl).hostname;
              if (h === wantHost || h.endsWith("." + wantHost) || wantHost.endsWith("." + h)) {
                // Committed. Now settle and observe.
                await bridge.request("engine.waitForStable", { timeout: 8000, quietMs: 600 }).catch(() => {});
                return send(res, 200, await bridge.request("engine.observe", { mode: "semantic" }));
              }
            } catch {}
          } catch (e) { lastErr = String((e as Error).message || e); }
        }
        return send(res, 504, { error: `navigation did not commit to ${wantHost}: ${lastErr}` });
      }
      if (url.pathname === "/navigate") {
        const to = url.searchParams.get("url") ?? "";
        let host = "";
        try {
          host = new URL(to).hostname;
        } catch {
          return send(res, 400, { error: "bad url" });
        }
        if (!host) return send(res, 400, { error: "missing url" });
        audit.log("control.navigate", { host });
        return send(res, 200, await bridge.request("engine.navigate", { url: to }));
      }
      if (url.pathname === "/robust-click" && req.method === "POST") {
        const body = await new Promise<string>((resolve) => {
          let b = "";
          req.on("data", (c) => (b += c));
          req.on("end", () => resolve(b));
        });
        const p = JSON.parse(body || "{}");
        audit.log("control.robust_click", { ref: p.ref });
        return send(res, 200, await bridge.request("engine.robustClick", p));
      }
      if (url.pathname === "/act" && req.method === "POST") {
        const body = await new Promise<string>((resolve) => {
          let b = "";
          req.on("data", (c) => (b += c));
          req.on("end", () => resolve(b));
        });
        const p = JSON.parse(body || "{}");
        audit.log("control.act", { action: p.action, ref: p.ref });
        return send(res, 200, await bridge.request("engine.act", p));
      }
      send(res, 404, {
        error: "not found",
        routes: [
          "/status", "/ping", "/observe", "/locate", "/wait", "/navigate", "/visit",
          "POST /act", "POST /robust-click", "POST /mcp",
        ],
      });
    } catch (e) {
      send(res, 502, { error: (e as Error).message });
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    process.stderr.write(
      `[agent-browser] control port ${cfg.bridge.controlPort} error: ${err.code ?? err.message}\n`,
    );
    audit.log("control.listen_error", { code: err.code });
  });
  server.listen(cfg.bridge.controlPort, cfg.bridge.host, () => {
    audit.log("control.listening", { port: cfg.bridge.controlPort });
  });
}
