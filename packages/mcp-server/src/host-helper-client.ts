import { readFileSync, existsSync } from "node:fs";

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
