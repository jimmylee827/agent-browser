import { readFileSync, existsSync } from "node:fs";
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
  launchChrome: () => call<{ ok: true; pid: number }>("/launch-chrome"),
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
      if (state.chromePid === null) {
        await launchBrowser(cfg.profileDir);
        return { via: "launch", wakeId };
      }
      openChromeWindow(cfg.profileDir);
      return { via: "window", wakeId };
    });
    recoveries.set(bridge, recovery);
  }
  return recovery;
}

/** Open a window in the Chrome that is already running, without relaunching it. */
export function openChromeWindow(profileDir: string): void {
  const child = spawn(chromeBinary(), [`--user-data-dir=${profileDir}`, "--new-window", "about:blank"], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

/** Launch through exactly one route. If the helper request loses its reply, it
 * may already have opened a window, so do not fall back after sending it. */
async function launchBrowser(profileDir: string): Promise<void> {
  if (profileDir === resolve(homedir(), ".agent-chrome/profile") && hostHelper.available() && await hostHelper.health()) {
    await hostHelper.launchChrome();
    return;
  }
  const child = spawn(resolve(repoRoot, "bin/launch-chrome.sh"), [], {
    cwd: repoRoot,
    env: { ...process.env, AB_PROFILE_DIR: profileDir },
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

// Wake-created spare windows may be adopted exactly once.
let spare: { tabId: number; at: number; wakeId: number } | null = null;
let wakeSeq = 0;
const SPARE_MS = 30_000;
/** Wakes whose spare has been armed or claimed already: one window, one claim. */
const settled = new Set<number>();
const settle = (id: number) => {
  settled.add(id);
  // A daemon runs for weeks; only recent wakes can still be claimed.
  if (settled.size > 64) for (const old of settled) if (old <= id - 64) settled.delete(old);
};

/** Record the blank window a wake just opened, for one session to move into. */
export async function noteSpareWindow(
  tabs: { tabId: number; url: string; windowId: number }[],
  wakeId: number,
  owned: (tabId: number) => boolean,
): Promise<void> {
  if (settled.has(wakeId)) return;
  const perWindow = new Map<number, { tabId: number; url: string }[]>();
  for (const t of tabs) perWindow.set(t.windowId, [...(perWindow.get(t.windowId) ?? []), t]);
  // A lone blank tab no session holds; the newest one is the wake's (Chrome
  // numbers tabs in the order it makes them).
  const blank = [...perWindow.values()]
    .filter((g) => g.length === 1 && !owned(g[0].tabId) && /^(chrome:\/\/(newtab|new-tab-page)\/?|about:blank|)$/.test(g[0].url))
    .map((g) => g[0].tabId)
    .sort((a, b) => b - a)[0];
  if (blank === undefined) return;
  settle(wakeId);
  spare = { tabId: blank, at: Date.now(), wakeId };
}

/** Claim the spare tab — once per wake, and only for the caller that woke it. */
export function takeSpareWindow(wakeId: number): number | undefined {
  if (!spare || spare.wakeId !== wakeId) return undefined;
  const { tabId, at } = spare;
  spare = null;
  settle(wakeId);
  return Date.now() - at > SPARE_MS ? undefined : tabId;
}

// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
