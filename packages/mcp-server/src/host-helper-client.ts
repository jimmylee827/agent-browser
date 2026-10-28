import { readFileSync, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Small client for the host-helper daemon. Its only job is launching the GUI
// Chrome on the host when the bridge isn't connected — the one thing the MCP
// server can't always do for itself (e.g. when it runs without a GUI session).
//
// It holds no credentials and touches no keychain.

const HOST = process.env.AB_HOST_HELPER_HOST || "127.0.0.1";
const PORT = process.env.AB_HOST_HELPER_PORT || "8789";
const SECRET_FILE = process.env.AB_HOST_HELPER_SECRET_FILE || "";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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
