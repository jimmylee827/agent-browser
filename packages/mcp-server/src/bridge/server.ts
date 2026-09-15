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
}

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
        ws.on("close", () => {
          if (this.client === ws) this.client = undefined;
          this.audit.log("bridge.disconnected", {});
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

  /** Global kill switch: `touch ~/.agent-chrome/HALT` stops all browser actions. */
  private halted(): boolean {
    return existsSync(resolve(this.cfg.stateDir, "HALT"));
  }

  /** Send a command to the extension engine and await its correlated reply. */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.halted()) {
      this.audit.log("bridge.halted", { method });
      return Promise.reject(
        new Error("HALTED: kill switch active (~/.agent-chrome/HALT). rm it to resume."),
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
      }, this.cfg.bridge.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.client!.send(JSON.stringify({ id, method, params }));
    });
  }
}
