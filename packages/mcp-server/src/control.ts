import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AppConfig } from "./config.js";
import type { Bridge } from "./bridge/server.js";
import type { Audit } from "./audit.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildStatus } from "./build.js";
import { rejectBrowserOrigin } from "./http-guard.js";
import { secondPassRedact, toHar, toNdjson, type NetEntry } from "./network.js";
import { writeEvidenceFile } from "./evidence.js";
import type { JobRunner } from "./jobs.js";
import { codeOf } from "./errors.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Who is calling: one id per MCP client connection (one launcher process). */
export interface ClientInfo {
  id: string;
  launcherBuild?: string;
}

interface McpHooks {
  makeMcpServer: (client: ClientInfo) => McpServer;
  makeHttpTransport: () => StreamableHTTPServerTransport;
  /** A client went away: close what it owned. */
  releaseClient: (id: string) => Promise<number>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });

const header = (req: IncomingMessage, name: string) => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) || undefined;
};

// Tiny localhost control plane so scripts/diagnostics talk to ONE persistent
// server (no per-test ephemeral servers racing the extension SW). Also hosts
// the Streamable HTTP MCP transport under POST /mcp.

export function startControl(
  cfg: AppConfig,
  bridge: Bridge,
  audit: Audit,
  mcp?: McpHooks,
  jobs?: JobRunner,
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
    const refused = rejectBrowserOrigin(req.headers);
    if (refused) {
      audit.log("control.refused", { reason: refused, path: (req.url ?? "").split("?")[0] });
      return send(res, 403, { error: refused });
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
        // The launcher names itself on every request. A client that does not
        // (a direct HTTP MCP client) shares one anonymous identity.
        const server = mcp.makeMcpServer({
          id: header(req, "x-ab-client") ?? "anonymous",
          launcherBuild: header(req, "x-ab-launcher-build"),
        });
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
        // The extension's version is what tells a person whether the one in
        // Chrome is the one on disk, so status is useful outside an MCP call.
        let onDisk = "";
        try {
          onDisk = JSON.parse(readFileSync(resolve(cfg.extensionDir, "manifest.json"), "utf8")).version;
        } catch {}
        const running = bridge.extension?.version;
        return send(res, 200, {
          bridgeConnected: bridge.connected(),
          build: buildStatus(),
          repoRoot: cfg.repoRoot,
          extension: running || onDisk ? { running: running ?? null, onDisk, stale: !!running && !!onDisk && running !== onDisk } : undefined,
        });
      }
      if (url.pathname === "/session/release" && req.method === "POST" && mcp) {
        const id = url.searchParams.get("client") ?? "";
        if (!id) return send(res, 400, { error: "missing client" });
        return send(res, 200, { closed: await mcp.releaseClient(id) });
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
      // Recorded traffic of one tab, for the CLI (`npm run ab -- network`).
      if (url.pathname === "/network" || url.pathname === "/network/export" || url.pathname === "/network/clear") {
        const q = url.searchParams;
        const tabId = Number(q.get("tabId"));
        if (!Number.isInteger(tabId) || !q.get("tabId")) return send(res, 400, { error: "tabId required (see `npm run ab -- tabs`)" });
        if (url.pathname === "/network/clear") {
          audit.log("control.network_clear", { tabId });
          return send(res, 200, await bridge.request("net.clear", { tabId }));
        }
        const exporting = url.pathname === "/network/export";
        const r = await bridge.request<{ url?: string; entries: NetEntry[]; matched: number }>("net.query", {
          tabId,
          urlPattern: q.get("url") ?? undefined,
          method: q.get("method") ?? undefined,
          status: q.get("status") ?? undefined,
          type: q.get("type") ?? "api",
          since: q.get("since") ? Number(q.get("since")) : undefined,
          includeBodies: exporting || q.get("bodies") === "1",
          includeHeaders: exporting || q.get("headers") === "1",
          bodyChars: exporting ? 65536 : Number(q.get("bodyChars") ?? 4000),
          limit: exporting ? 500 : Number(q.get("limit") ?? 50),
        });
        const entries = r.entries.map((e) => secondPassRedact(e, cfg.network.redactHeaders));
        if (!exporting) return send(res, 200, { ...r, entries });
        const format = q.get("format") === "ndjson" ? "ndjson" : "har";
        const oldest = [...entries].reverse();
        const file = writeEvidenceFile(cfg, `cli-tab-${tabId}`, "network", format, format === "har" ? JSON.stringify(toHar(oldest, { page: r.url }), null, 2) : toNdjson(oldest));
        audit.log("control.network_export", { tabId, format, file });
        return send(res, file ? 200 : 500, file ? { file, format, entries: entries.length, matched: r.matched } : { error: "could not write the export" });
      }
      if (url.pathname === "/tabs") return send(res, 200, await bridge.request("engine.tabs", { action: "list" }));
      // Background jobs, for `npm run ab -- jobs`.
      const jm = url.pathname.match(/^\/jobs(?:\/([a-z0-9-]+))?(?:\/(stop|resume|records|log))?$/);
      if (jm && jobs) {
        const [, id, verb] = jm;
        try {
          if (!id && req.method === "GET") return send(res, 200, { jobs: jobs.list(), needsAttention: jobs.needsAttention() });
          if (!id && req.method === "POST") {
            if (existsSync(resolve(cfg.stateDir, "HALT"))) return send(res, 423, { error: "HALTED: kill switch active", code: "HALTED" });
            const spec = JSON.parse((await readBody(req)) || "{}");
            return send(res, 200, jobs.create(spec, "cli"));
          }
          if (id && !verb && req.method === "GET") return send(res, 200, jobs.status(id));
          if (id && !verb && req.method === "DELETE") return send(res, 200, await jobs.remove(id, "cli"));
          if (verb === "stop" && req.method === "POST") return send(res, 200, await jobs.stop(id!, "cli"));
          if (verb === "resume" && req.method === "POST") return send(res, 200, jobs.resume(id!, "cli"));
          if (verb === "records" || verb === "log") {
            const q = url.searchParams;
            return send(res, 200, jobs.read(id!, { after: q.get("after") ?? undefined, limit: Number(q.get("limit") ?? 100), urlPattern: q.get("url") ?? undefined, file: verb === "log" ? "log" : "records" }));
          }
          return send(res, 405, { error: `${req.method} ${url.pathname} is not a jobs operation` });
        } catch (e) {
          const code = codeOf(e);
          return send(res, code === "JOB_NOT_FOUND" ? 404 : code === "BAD_REQUEST" || code === "NETWORK_BLOCKED" || code === "JOB_LIMIT" ? 400 : 502, {
            error: (e as Error).message,
            code,
          });
        }
      }
      if (url.pathname === "/robust-click" && req.method === "POST") {
        const p = JSON.parse((await readBody(req)) || "{}");
        audit.log("control.robust_click", { ref: p.ref });
        return send(res, 200, await bridge.request("engine.robustClick", p));
      }
      if (url.pathname === "/act" && req.method === "POST") {
        const p = JSON.parse((await readBody(req)) || "{}");
        audit.log("control.act", { action: p.action, ref: p.ref });
        return send(res, 200, await bridge.request("engine.act", p));
      }
      send(res, 404, {
        error: "not found",
        routes: [
          "/status", "/ping", "/observe", "/locate", "/wait", "/navigate", "/visit", "/tabs",
          "/network?tabId=", "/network/export?tabId=&format=har|ndjson", "/network/clear?tabId=",
          "GET|POST /jobs", "GET|DELETE /jobs/:id", "POST /jobs/:id/stop|resume", "GET /jobs/:id/records|log?after=",
          "POST /act", "POST /robust-click", "POST /mcp", "POST /session/release?client=",
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
