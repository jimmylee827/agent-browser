import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "../config.js";
import type { Audit } from "../audit.js";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  ws: WebSocket;
}

/**
 * Engine methods that change nothing, so re-sending one after the extension
 * dropped mid-call is safe. Anything else may already have acted.
 */
const READ_ONLY = new Set([
  "engine.ping", "engine.observe", "engine.locate", "engine.waitForStable",
  "engine.screenshot", "engine.navHistory", "engine.waitFor",
]);
const DROPPED = "BRIDGE_DROPPED";

/** Comfortably inside Chrome's ~30s service-worker idle timeout. */
const HEARTBEAT_MS = 20_000;

/**
 * Localhost-only bridge. The MV3 extension service worker connects OUT to this
 * server (browser WebSocket can't set headers, so auth is the first message).
 * No CDP anywhere — this is just a JSON command channel to the content engine.
 */
export class Bridge {
  private wss?: WebSocketServer;
  private client?: WebSocket;
  private pending = new Map<string, Pending>();

  constructor(
    private cfg: AppConfig,
    private secret: string,
    private audit: Audit,
  ) {}

  start(): void {
    this.wss = new WebSocketServer({ host: this.cfg.bridge.host, port: this.cfg.bridge.port });
    this.wss.on("error", (err: NodeJS.ErrnoException) => {
      const msg =
        err.code === "EADDRINUSE"
          ? `bridge port ${this.cfg.bridge.port} already in use — another agent-browser server is running. ` +
            `Stop it (e.g. kill the persistent 'npm run mcp') and use only one.`
          : `bridge listen error: ${err.message}`;
      process.stderr.write(`[agent-browser] FATAL: ${msg}\n`);
      this.audit.log("bridge.listen_error", { code: err.code });
      process.exit(1);
    });
    this.wss.on("listening", () => this.audit.log("bridge.listening", { port: this.cfg.bridge.port }));
    this.wss.on("connection", (ws, req) => {
      const ip = req.socket.remoteAddress ?? "";
      // On host: enforce loopback-only here. In container: trust the published
      // port's 127.0.0.1 restriction (Docker forwards from a non-loopback IP).
      const inContainer = process.env.AB_BIND_HOST === "0.0.0.0";
      if (!inContainer && ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
        ws.close(1008, "localhost only");
        return;
      }
      let authed = false;
      ws.once("message", (buf) => {
        let msg: { type?: string; secret?: string };
        try {
          msg = JSON.parse(buf.toString());
        } catch {
          ws.close(1008, "bad handshake");
          return;
        }
        if (msg.type !== "auth" || msg.secret !== this.secret) {
          this.audit.log("bridge.auth_reject", { ip });
          ws.close(1008, "auth failed");
          return;
        }
        authed = true;
        this.client = ws;
        this.audit.log("bridge.connected", { ip });
        ws.send(JSON.stringify({ type: "auth_ok" }));
        ws.on("message", (b) => this.onMessage(b.toString()));

        // Keep the MV3 service worker alive.
        //
        // An extension service worker is torn down after ~30s idle, which
        // closes this socket. The extension's chrome.alarms backstop rebuilds
        // it, but alarms fire at most once a minute, leaving a window where
        // the bridge is simply down and every tool call fails. Chrome resets
        // the idle timer whenever the worker *receives* a WebSocket message,
        // so a steady heartbeat from this side keeps it resident for as long
        // as the browser is open. The extension ignores these frames.
        const heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "keepalive", ts: Date.now() }));
          }
        }, HEARTBEAT_MS);

        ws.on("close", () => {
          clearInterval(heartbeat);
          if (this.client === ws) this.client = undefined;
          this.audit.log("bridge.disconnected", {});
          // Nothing will ever answer a request sent on this socket. Fail them
          // now instead of leaving each to its 30s timeout — that is what made
          // the first call after an extension self-reload hang.
          for (const [id, p] of this.pending) {
            if (p.ws !== ws) continue;
            this.pending.delete(id);
            clearTimeout(p.timer);
            p.reject(new Error(`${DROPPED}: the browser extension restarted while the call was in flight`));
          }
        });
      });
      setTimeout(() => {
        if (!authed) ws.close(1008, "auth timeout");
      }, 5000);
    });
  }

  private onMessage(raw: string): void {
    let msg: { id?: string; ok?: boolean; result?: unknown; error?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg.id) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "engine error"));
  }

  connected(): boolean {
    return !!this.client && this.client.readyState === WebSocket.OPEN;
  }

  /**
   * Resolve once the extension is attached, or false at the deadline.
   *
   * The heartbeat keeps the worker resident while it's connected, but there
   * are still gaps where it isn't: the browser just started, the worker was
   * evicted under memory pressure, or the extension was reloaded. In those
   * cases it reconnects within seconds, so a caller should wait briefly
   * rather than fail on a race it would have won.
   */
  async waitForConnection(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.connected()) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
    return true;
  }

  /** Global kill switch: `touch ~/.agent-chrome/HALT` stops all browser actions. */
  private halted(): boolean {
    return existsSync(resolve(this.cfg.stateDir, "HALT"));
  }

  /** Send a command to the extension engine and await its correlated reply. */
  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.cfg.bridge.requestTimeoutMs,
  ): Promise<T> {
    try {
      return await this.send<T>(method, params, timeoutMs);
    } catch (e) {
      // A read-only call lost to an extension restart is re-sent once on the
      // new connection. A state-changing one is not: it may have run.
      if (!String((e as Error).message).startsWith(DROPPED) || !READ_ONLY.has(method)) throw e;
      if (!(await this.waitForConnection(8_000))) throw e;
      return await this.send<T>(method, params, timeoutMs);
    }
  }

  private send<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    if (this.halted()) {
      this.audit.log("bridge.halted", { method });
      return Promise.reject(
        new Error("HALTED: kill switch active — the user stopped all browser actions"),
      );
    }
    if (!this.connected()) {
      return Promise.reject(
        new Error("bridge not connected: launch the agent Chrome (npm run launch)"),
      );
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge request timeout: ${method}`));
      }, timeoutMs);
      const ws = this.client!;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, ws });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
