import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AbError } from "./errors.js";
import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { AppConfig } from "./config.js";
import type { Bridge } from "./bridge/server.js";
import { BrowserRecovery, extensionRegistration } from "./readiness.js";
import { fileURLToPath } from "node:url";

/**
 * Getting a browser window to exist, without ever leaving a spare one behind.
 *
 * Chrome is one application. If it is already running, "launching" it does not
 * focus it — it opens ANOTHER window, and the caller then opens the window it
 * actually wanted, so one visit cost two windows. That is what filled the
 * screen with blank windows: every call that found the bridge down launched
 * again.
 *
 * So: launch only when Chrome is not running, otherwise open a window in it,
 * one wake at a time however many callers ask. And because a wake opens a
 * blank window of its own, remember it (noteSpareWindow) so one session that
 * needs a window can move into it instead of opening a second.
 */

export const chromeBinary = () => process.env.AB_CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Small client for the host-helper daemon. Its only job is launching the GUI
// Chrome on the host when the bridge isn't connected — the one thing the MCP
// server can't always do for itself (e.g. when it runs without a GUI session).
//
// It holds no credentials and touches no keychain.

const HOST = process.env.AB_HOST_HELPER_HOST || "127.0.0.1";
const PORT = process.env.AB_HOST_HELPER_PORT || "8789";
const SECRET_FILE = process.env.AB_HOST_HELPER_SECRET_FILE || "";

function readSecret(): string | null {
  const candidates = [SECRET_FILE, `${process.env.HOME ?? ""}/.agent-chrome/host-helper-secret`];
  for (const f of candidates) {
    try { if (f) return readFileSync(f, "utf8").trim() || null; } catch { /* try the default */ }
  }
  return null;
}

async function call<T = unknown>(path: string, body: object = {}): Promise<T> {
  const secret = readSecret();
  if (!secret) throw new Error("host-helper secret unavailable (file missing)");
  const r = await fetch(`http://${HOST}:${PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, ...body }),
    signal: AbortSignal.timeout(3000),
  });
  const j = (await r.json()) as { error?: string } & T;
  if (!r.ok || j.error) throw new Error(j.error || `host-helper ${path} HTTP ${r.status}`);
  return j;
}

export const hostHelper = {
  available(): boolean {
    return readSecret() !== null;
  },
  async health(): Promise<boolean> {
    try {
      const r = await fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(1000) });
      return r.ok;
    } catch {
      return false;
    }
  },
  async supportsWakeMarker(): Promise<boolean> {
    try {
      const r = await fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(1000) });
      return r.ok && (await r.json() as { wakeMarker?: boolean }).wakeMarker === true;
    } catch { return false; }
  },
  launchChrome: (marker: string) => call<{ ok: true; pid: number }>("/launch-chrome", { marker }),
};

/** Identify only the agent profile, not personal Chrome or the Testo collectors. */
function chromePid(profileDir: string): number | null {
  try {
    const lines = execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
    const prefix = chromeBinary() + " ";
    for (const line of lines.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match || !match[2].startsWith(prefix)) continue;
      const flag = ` --user-data-dir=${profileDir}`;
      const i = match[2].indexOf(flag);
      if (i >= 0 && (match[2].length === i + flag.length || match[2][i + flag.length] === " ")) return Number(match[1]);
    }
  } catch { /* unknown; preference check and single flight still apply */ }
  return null;
}

const recoveries = new WeakMap<Bridge, BrowserRecovery>();
export function browserRecovery(cfg: AppConfig, bridge: Bridge): BrowserRecovery {
  let recovery = recoveries.get(bridge);
  if (!recovery) {
    recovery = new BrowserRecovery(bridge, () => ({ chromePid: chromePid(cfg.profileDir),
      registration: extensionRegistration(cfg.profileDir, cfg.extensionDir), halted: existsSync(resolve(cfg.stateDir, "HALT")) }), async (state) => {
      const wakeId = ++wakeSeq;
      const marker = `http://127.0.0.1:${cfg.bridge.controlPort}/wake/${randomUUID()}`;
      lastWake.set(bridge, { wakeId, marker, at: Date.now() });
      if (state.chromePid === null) {
        await launchBrowser(cfg.profileDir, marker);
        return { via: "launch", wakeId, marker };
      }
      openChromeWindow(cfg.profileDir, marker);
      return { via: "window", wakeId, marker };
    });
    recoveries.set(bridge, recovery);
  }
  return recovery;
}

/** Open a window in the Chrome that is already running, without relaunching it. */
export function openChromeWindow(profileDir: string, marker: string): void {
  const child = spawn(chromeBinary(), [`--user-data-dir=${profileDir}`, "--new-window", marker], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

/** Launch through exactly one route. If the helper request loses its reply, it
 * may already have opened a window, so do not fall back after sending it. */
async function launchBrowser(profileDir: string, marker: string): Promise<void> {
  if (profileDir === resolve(homedir(), ".agent-chrome/profile") && hostHelper.available() && await hostHelper.supportsWakeMarker()) {
    await hostHelper.launchChrome(marker);
    return;
  }
  const script = process.env.AB_CHROME_LAUNCH_SCRIPT ?? resolve(repoRoot, "bin/launch-chrome.sh");
  const child = spawn(script, [marker], {
    cwd: dirname(dirname(script)),
    env: { ...process.env, AB_PROFILE_DIR: profileDir },
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

// Only adopt the tab explicitly opened for this wake, never a guess based on
// tab IDs or a user's blank window. An older helper may not support a marker.
const lastWake = new WeakMap<Bridge, { wakeId: number; marker: string; at: number }>();
let wakeSeq = 0;
export async function takeWakeTab(bridge: Bridge, owned: (tabId: number) => boolean): Promise<number | undefined> {
  const last = lastWake.get(bridge);
  if (!last || Date.now() - last.at > 90_000) return;
  const list = await bridge.request<{ tabs: { tabId: number; url: string; windowId: number }[] }>("engine.tabs", { action: "list" }).catch(() => null);
  if (lastWake.get(bridge) !== last) return;
  const tab = list?.tabs.find((t) => t.url === last.marker && !owned(t.tabId) &&
    list.tabs.filter((x) => x.windowId === t.windowId).length === 1);
  if (!tab) return;
  lastWake.delete(bridge);
  return tab.tabId;
}

export async function requireBrowser(cfg: AppConfig, bridge: Bridge, timeoutMs = 48_000) {
  if (bridge.connected() && !existsSync(resolve(cfg.stateDir, "HALT"))) return { state: "connected" as const };
  const recovery = browserRecovery(cfg, bridge);
  const result = await recovery.ensure(timeoutMs);
  if (result.state === "connected") return result;
  const human = result.state === "human" || result.state === "suppressed";
  const code = result.state === "halted" ? "HALTED" : result.state === "human" ? "EXTENSION_NOT_READY" : "BRIDGE_DOWN";
  throw new AbError(code, result.advice ?? "Agent Browser did not connect", {
    recovery: result.advice, readiness: recovery.status(),
    ...(human ? { agentCanFix: false, humanAction: result.advice } : {}),
  });
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
