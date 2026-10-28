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
  /** The unpacked extension Chrome loads (for version checks). */
  extensionDir: string;
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
  eval: { blockedDomains: string[] };
  input: { enabled: boolean; port: number; secretFile: string };
  diagnostics: { hosts: string[] };
  evidence: { enabled: boolean; retainDays: number };
  audit: { file: string };
}

/**
 * A person's own settings, kept out of the repository: the file an agent may
 * propose an edit to (Claude Code shows the diff, the person approves) when a
 * policy block needs a domain allowed, and where private hosts live so they
 * never get pushed.
 *
 *   { "policy": { "trustedDomains": ["shop.internal"] } }
 */
export function localConfigPath(): string {
  return process.env.AB_LOCAL_CONFIG ?? resolve(repoRoot, "config/local.json");
}

export function readLocalOverride(file = localConfigPath()): Partial<AppConfig> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Partial<AppConfig>;
  } catch {
    return null;
  }
}

function applyLocal(cfg: AppConfig, local: Partial<AppConfig> | null): AppConfig {
  if (!local) return cfg;
  if (local.policy) {
    cfg.policy = {
      ...cfg.policy,
      ...local.policy,
      // A list in the override replaces the default, it does not append:
      // what a person writes there is what they mean.
      trustedDomains: (local.policy as { trustedDomains?: string[] }).trustedDomains ?? cfg.policy.trustedDomains,
    };
  }
  if (local.eval?.blockedDomains) cfg.eval.blockedDomains = local.eval.blockedDomains;
  if (local.diagnostics?.hosts) cfg.diagnostics.hosts = local.diagnostics.hosts;
  if (local.input) cfg.input = { ...cfg.input, ...local.input };
  if (local.evidence) cfg.evidence = { ...cfg.evidence, ...local.evidence };
  return cfg;
}

export function loadConfig(): AppConfig {
  const raw = readFileSync(process.env.AB_CONFIG ?? resolve(repoRoot, "config/default.json"), "utf8");
  const cfg = JSON.parse(raw) as AppConfig;
  const env = process.env;
  // A second, isolated instance (the end-to-end tests) moves everything that
  // would collide with the user's own: state, profile, ports.
  if (env.AB_STATE_DIR) {
    cfg.stateDir = env.AB_STATE_DIR;
    cfg.bridge.secretFile = resolve(env.AB_STATE_DIR, "bridge-secret");
    cfg.audit.file = resolve(env.AB_STATE_DIR, "audit.log");
  }
  if (env.AB_PROFILE_DIR) cfg.profileDir = env.AB_PROFILE_DIR;
  if (env.AB_BRIDGE_PORT) cfg.bridge.port = Number(env.AB_BRIDGE_PORT);
  if (env.AB_CONTROL_PORT) cfg.bridge.controlPort = Number(env.AB_CONTROL_PORT);
  cfg.extensionDir = env.AB_EXTENSION_DIR ?? resolve(repoRoot, "packages/extension");
  cfg.profileDir = expandHome(cfg.profileDir);
  cfg.stateDir = expandHome(cfg.stateDir);
  cfg.bridge.secretFile = expandHome(cfg.bridge.secretFile);
  cfg.audit.file = expandHome(cfg.audit.file);
  cfg.eval ??= { blockedDomains: [] };
  cfg.input ??= { enabled: false, port: 8790, secretFile: "~/.agent-chrome/input-helper-secret" };
  cfg.diagnostics ??= { hosts: [] };
  cfg.evidence ??= { enabled: true, retainDays: 14 };
  if (env.AB_BIND_HOST) cfg.bridge.host = env.AB_BIND_HOST;
  if (env.AB_BRIDGE_SECRET_FILE) cfg.bridge.secretFile = env.AB_BRIDGE_SECRET_FILE;
  return applyLocal(cfg, readLocalOverride());
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
