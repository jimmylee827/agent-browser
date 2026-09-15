import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

export function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace(/^~/, homedir()) : p;
}

export interface AppConfig {
  profileDir: string;
  stateDir: string;
  bridge: {
    host: string;
    port: number;
    controlPort: number;
    secretFile: string;
    requestTimeoutMs: number;
  };
  policy: {
    trustedDomains: string[];
    sensitiveActionClasses: string[];
    redactSelectors: string[];
  };
  perception: { maxSnapshotTokensApprox: number; screenshotOnAmbiguity: boolean };
  audit: { file: string };
}

export function loadConfig(): AppConfig {
  const raw = readFileSync(resolve(repoRoot, "config/default.json"), "utf8");
  const cfg = JSON.parse(raw) as AppConfig;
  cfg.profileDir = expandHome(cfg.profileDir);
  cfg.stateDir = expandHome(cfg.stateDir);
  cfg.bridge.secretFile = expandHome(cfg.bridge.secretFile);
  cfg.audit.file = expandHome(cfg.audit.file);
  if (process.env.AB_BIND_HOST) cfg.bridge.host = process.env.AB_BIND_HOST;
  if (process.env.AB_BRIDGE_SECRET_FILE) cfg.bridge.secretFile = process.env.AB_BRIDGE_SECRET_FILE;
  return cfg;
}

/** Generate (once) and read the localhost bridge shared secret, 0600. */
export function ensureBridgeSecret(cfg: AppConfig): string {
  mkdirSync(cfg.stateDir, { recursive: true });
  if (!existsSync(cfg.bridge.secretFile)) {
    writeFileSync(cfg.bridge.secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
    chmodSync(cfg.bridge.secretFile, 0o600);
  }
  return readFileSync(cfg.bridge.secretFile, "utf8").trim();
}
