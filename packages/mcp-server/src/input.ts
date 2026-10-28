import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { expandHome } from "./config.js";

/**
 * Real input through macOS Accessibility (native/input-helper).
 *
 * Synthetic DOM events from the extension carry isTrusted:false, so a page can
 * tell them from a person's, and Chrome refuses what it gates on a real
 * gesture: sound, fullscreen, some native dialogs. This posts the event from
 * the operating system instead, aimed at the agent Chrome's own process — the
 * page sees trusted input, and the person's cursor does not move.
 *
 * Scoped by design: only the agent Chrome (found by its profile), only the tab
 * the session owns (the caller passes its window's bounds), and the window is
 * brought forward for the instant of the gesture, then focus goes back.
 * Off unless `input.enabled` is set in config.
 */
export interface InputConfig {
  enabled: boolean;
  port: number;
  secretFile: string;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Point {
  x: number;
  y: number;
}

export type Event = { type: "move" | "down" | "up"; x: number; y: number; waitMs?: number; button?: "left" | "right" };

export class InputHelper {
  constructor(private cfg: InputConfig) {}

  private secret(): string | null {
    const file = expandHome(this.cfg.secretFile);
    try {
      return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
    } catch {
      return null;
    }
  }

  async call(cmd: string, body: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const secret = this.secret();
    if (!secret) throw new Error("input helper: no secret (npm run input-helper:install)");
    const r = await fetch(`http://127.0.0.1:${this.cfg.port}/`, {
      method: "POST",
      body: JSON.stringify({ secret, cmd, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await r.json()) as Record<string, unknown>;
  }

  /** Running, and allowed into Accessibility? */
  async status(): Promise<{ ok: boolean; trusted: boolean; error?: string }> {
    if (!this.cfg.enabled) return { ok: false, trusted: false, error: "input.enabled is off in config" };
    try {
      const s = await this.call("status", {}, 1500);
      return { ok: !!s.ok, trusted: !!s.trusted, ...(s.error ? { error: String(s.error) } : {}) };
    } catch (e) {
      return { ok: false, trusted: false, error: (e as Error).message };
    }
  }

  /** The agent Chrome's browser process (not a renderer), by its profile path. */
  pid(profileDir: string): number | undefined {
    try {
      const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
      const line = out.split("\n").find((l) => l.includes(`user-data-dir=${profileDir}`) && !l.includes("--type="));
      return line ? Number(line.trim().split(/\s+/)[0]) : undefined;
    } catch {
      return undefined;
    }
  }

  /** A point on the screen for a point in the page. */
  static screenPoint(
    p: Point,
    metrics: { screenX: number; screenY: number; outerHeight: number; innerHeight: number; scrollX: number; scrollY: number },
  ): Point {
    const chrome = metrics.outerHeight - metrics.innerHeight; // the browser's own chrome above the page
    return { x: metrics.screenX + (p.x - metrics.scrollX), y: metrics.screenY + chrome + (p.y - metrics.scrollY) };
  }

  static windowOf(metrics: { screenX: number; screenY: number; outerWidth: number; outerHeight: number }): Rect {
    return { x: metrics.screenX, y: metrics.screenY, width: metrics.outerWidth, height: metrics.outerHeight };
  }

  /**
   * Post a gesture at the agent Chrome. `raise` brings the window forward for
   * the gesture (macOS needs it frontmost); `restoreFocus` hands focus back to
   * whatever the person was using. The cursor never moves with route "pid".
   */
  async gesture(
    pid: number,
    window: Rect,
    events: Event[],
    opts: { route?: "pid" | "global"; raise?: boolean; restoreFocus?: boolean; restoreCursor?: boolean; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.call(
      "pointer",
      {
        pid,
        window,
        events,
        // "global" posts a real pointer event; the cursor moves for the
        // instant of the gesture and is put back. Events posted to Chrome's
        // process ("pid") are ignored for the mouse — measured — so this is
        // the only route that reaches a page.
        route: opts.route ?? "global",
        // The extension has already made the session's window the active one;
        // a second "raise" picks a window by frame alone and can pick the
        // wrong Chrome window when two sit at the same place.
        raise: opts.raise ?? false,
        // A real hover lasts only while the pointer stays there: putting the
        // cursor back would end the state the caller asked to see.
        restoreCursor: opts.restoreCursor ?? true,
        restoreFocus: opts.restoreFocus ?? true,
      },
      opts.timeoutMs ?? 15_000,
    );
  }

  /**
   * Bring the session's window to the front, chosen by its frame and title
   * (two Chrome windows often sit at the same frame; the title tells them
   * apart). macOS delivers input to the frontmost window, so this is what
   * makes a gesture land in the right place.
   */
  async focus(pid: number, window: Rect, title?: string): Promise<Record<string, unknown>> {
    return this.call("focus", { pid, window, ...(title ? { title } : {}) }, 8000);
  }

  /** Type into whatever the page has focused, as a keyboard would. */
  async type(pid: number, window: Rect, text: string, keys: string[] = []): Promise<Record<string, unknown>> {
    return this.call("keys", { pid, window, text, keys, restoreFocus: true });
  }
}
