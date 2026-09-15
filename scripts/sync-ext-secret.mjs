// Writes the localhost bridge secret into the extension as a generated module,
// so the SW can authenticate with zero human interaction. Run before launch.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(resolve(root, "config/default.json"), "utf8"));
const exp = (p) => (p.startsWith("~") ? p.replace(/^~/, homedir()) : p);

const secretFile = exp(cfg.bridge.secretFile);
mkdirSync(dirname(secretFile), { recursive: true });
if (!existsSync(secretFile)) {
  writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  chmodSync(secretFile, 0o600);
  console.log("generated new bridge secret:", secretFile);
}
const secret = readFileSync(secretFile, "utf8").trim();

const out = resolve(root, "packages/extension/src/generated-secret.js");
writeFileSync(
  out,
  `// AUTO-GENERATED — do not commit. Source: ${secretFile}\n` +
    `export const BRIDGE_SECRET = ${JSON.stringify(secret)};\n` +
    `export const BRIDGE_PORT = ${JSON.stringify(cfg.bridge.port)};\n`,
);
console.log("wrote", out);
