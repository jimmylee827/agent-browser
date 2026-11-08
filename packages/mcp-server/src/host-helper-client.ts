import { readFileSync, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
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
    if (f && existsSync(f)) return readFileSync(f, "utf8").trim();
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
      const r = await fetch(`http://${HOST}:${PORT}/health`);
      return r.ok;
    } catch {
      return false;
    }
  },
  launchChrome: () => call<{ ok: true; pid: number }>("/launch-chrome"),
};

/** Is a Chrome running on the agent profile? (Unknown counts as yes.) */
export function agentChromeRunning(profileDir: string): boolean {
  try {
    // No leading "--" in the pattern: pgrep would read it as an option.
    execFileSync("pgrep", ["-f", `user-data-dir=${profileDir}`], { stdio: "ignore" });
    return true;
  } catch (e) {
    return (e as { status?: number }).status !== 1; // 1 = no match
  }
}

/**
 * Is the agent bridge loaded into that Chrome profile, and switched on? Read
 * from the profile's own record of its extensions, which is what decides
 * whether opening a window is enough to get the bridge back, or whether the
 * browser has to be started again: Chrome with no window open unloads the
 * profile — and the extension, and its worker — on macOS.
 *
 * A profile that cannot be read claims the extension, so the cheap path is
 * tried first and a real launch still follows if the bridge stays down.
 */
export function extensionLoaded(profileDir: string, extensionDir: string): boolean {
  for (const file of ["Secure Preferences", "Preferences"]) {
    let prefs: { extensions?: { settings?: Record<string, { path?: string; state?: number; disable_reasons?: number | number[] }> } };
    try {
      prefs = JSON.parse(readFileSync(resolve(profileDir, "Default", file), "utf8"));
    } catch {
      continue;
    }
    const settings = prefs?.extensions?.settings;
    if (!settings) continue;
    const entry = Object.values(settings).find((e) => e?.path && resolve(e.path) === resolve(extensionDir));
    if (entry) return !(Array.isArray(entry.disable_reasons) ? entry.disable_reasons.length : entry.disable_reasons) && entry.state !== 0;
    return false;
  }
  return true;
}

/**
 * Make sure a window exists: start Chrome when it is down (or has lost the
 * extension with its last window), otherwise open one in it.
 *
 * Single-flight: N callers that all find the bridge down make one wake, not N.
 * Settles before it hands back, because opening the window is what lets the
 * others find a connection and stop needing a wake of their own.
 * The blank window a wake opens is recorded here, daemon-wide, for exactly one
 * session to claim — the registry is module state, so every request's server
 * instance shares it.
 */
export async function wakeBrowser(
  profileDir: string,
  extensionDir: string,
): Promise<{ via: "launch" | "window"; wakeId: number; performed: boolean }> {
  const performed = !waking;
  if (!waking) waking = wake(profileDir, extensionDir).finally(() => (waking = null));
  return { ...(await waking), performed };
}

let waking: Promise<{ via: "launch" | "window"; wakeId: number }> | null = null;

async function wake(profileDir: string, extensionDir: string): Promise<{ via: "launch" | "window"; wakeId: number }> {
  const wakeId = ++wakeSeq;
  if (!extensionLoaded(profileDir, extensionDir) || !agentChromeRunning(profileDir)) {
    await launchBrowser();
    return { via: "launch", wakeId };
  }
  openChromeWindow(profileDir);
  await new Promise((r) => setTimeout(r, 750));
  return { via: "window", wakeId };
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

/**
 * Start the agent Chrome by whichever route works: the host helper when it
 * answers, otherwise spawning the launcher ourselves. The daemon runs as a
 * launchd agent in the user's GUI session, and a stdio server runs under the
 * user's terminal, so both can open a GUI app directly — the helper is only
 * needed when the server has no GUI session at all.
 *
 * A secret file on disk does not mean the helper is running (it outlives the
 * process), so a failed helper call falls through to the direct spawn.
 */
export async function launchBrowser(): Promise<"host-helper" | "direct"> {
  if (!launching) launching = doLaunch().finally(() => (launching = null));
  return launching;
}

let launching: Promise<"host-helper" | "direct"> | null = null;

async function doLaunch(): Promise<"host-helper" | "direct"> {
  if (hostHelper.available()) {
    try {
      await hostHelper.launchChrome();
      return "host-helper";
    } catch {}
  }
  const child = spawn(resolve(repoRoot, "bin/launch-chrome.sh"), [], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
  return "direct";
}

// ---- the blank window a wake leaves behind ----------------------------------

/**
 * The blank window a wake opened, claimable by exactly one session.
 *
 * A wake opens one window and N callers may each want a window of their own;
 * handing the same tab to all of them would put several sessions in one page.
 * So the spare is claimed once, and the claim is tied to the wake that made
 * it: a caller that did not wake anything has no claim on a blank window it
 * happens to see.
 */
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
