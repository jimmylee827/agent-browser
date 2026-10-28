// Values a person has approved a background job to type: a password, the seed
// of an authenticator app (the job computes the current code), a card's
// number, expiry or CVC. Each may be used only on the hosts named with it.
//
// The value lives in the macOS login Keychain; this file holds only names,
// kinds and hosts. It is handed to `security` on stdin, never as an argument
// (which `ps` would show), base64-encoded so the Keychain only ever holds
// ASCII (`find-generic-password -w` prints anything else as hex). Nothing
// here logs or returns a value except getValue, which only the job runner
// calls, at the moment it types.

import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./config.js";
import { AbError } from "./errors.js";

export type SecretKind = "password" | "totp" | "card-number" | "card-expiry" | "card-cvc" | "text";
export const KINDS: SecretKind[] = ["password", "totp", "card-number", "card-expiry", "card-cvc", "text"];

export interface SecretMeta {
  name: string;
  kind: SecretKind;
  hosts: string[];
  addedAt: number;
  addedBy: string;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HOST = /^[a-z0-9.-]+$/i;
const service = () => process.env.AB_SECRETS_SERVICE || "agent-browser";
const metaFile = (cfg: AppConfig) => resolve(cfg.stateDir, "secrets.json");
// Off macOS there is no Keychain: a private file, and the CLI says so.
const valueFile = (cfg: AppConfig) => resolve(cfg.stateDir, "secret-values.json");
export const usesKeychain = () => process.platform === "darwin" && !process.env.AB_SECRETS_FILE;

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writePrivate(file: string, data: unknown) {
  mkdirSync(resolve(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

export function listSecrets(cfg: AppConfig): SecretMeta[] {
  return readJson<SecretMeta[]>(metaFile(cfg), []);
}

export function findSecret(cfg: AppConfig, name: string): SecretMeta | undefined {
  return listSecrets(cfg).find((s) => s.name === name);
}

/** A double-quoted word for `security -i`, which splits its input like a shell. */
const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function setSecret(cfg: AppConfig, input: { name: string; kind: string; hosts: string[]; value: string; by: string }): SecretMeta {
  const name = String(input.name ?? "").toLowerCase();
  if (!NAME.test(name)) throw new AbError("BAD_REQUEST", "name: lower-case letters, digits, dot, dash, underscore; up to 64");
  if (!KINDS.includes(input.kind as SecretKind)) throw new AbError("BAD_REQUEST", `kind: one of ${KINDS.join(", ")}`);
  const hosts = [...new Set((input.hosts ?? []).map((h) => String(h).toLowerCase().trim()).filter(Boolean))];
  if (!hosts.length || hosts.some((h) => !HOST.test(h))) throw new AbError("BAD_REQUEST", "hosts: at least one host name it may be used on, e.g. login.shop.com");
  if (typeof input.value !== "string" || !input.value) throw new AbError("BAD_REQUEST", "value: empty");
  if (input.kind === "totp") totp(input.value); // a seed that does not decode is refused now, not at 3am
  const b64 = Buffer.from(input.value, "utf8").toString("base64");
  if (usesKeychain()) {
    execFileSync("security", ["-i"], { input: `add-generic-password -U -s ${quote(service())} -a ${quote(name)} -w ${quote(b64)}\n`, stdio: ["pipe", "ignore", "pipe"] });
  } else {
    const all = readJson<Record<string, string>>(valueFile(cfg), {});
    all[name] = b64;
    writePrivate(valueFile(cfg), all);
  }
  const meta: SecretMeta = { name, kind: input.kind as SecretKind, hosts, addedAt: Date.now(), addedBy: input.by };
  writePrivate(metaFile(cfg), [...listSecrets(cfg).filter((s) => s.name !== name), meta]);
  return meta;
}

export function removeSecret(cfg: AppConfig, name: string): boolean {
  const had = !!findSecret(cfg, name);
  if (usesKeychain()) {
    try {
      execFileSync("security", ["delete-generic-password", "-s", service(), "-a", name], { stdio: "ignore" });
    } catch {}
  } else {
    const all = readJson<Record<string, string>>(valueFile(cfg), {});
    delete all[name];
    writePrivate(valueFile(cfg), all);
  }
  writePrivate(metaFile(cfg), listSecrets(cfg).filter((s) => s.name !== name));
  return had;
}

/** May this secret be typed on this host? Its own host or a subdomain of one. */
export function allowedOn(meta: SecretMeta, host: string): boolean {
  const h = host.toLowerCase();
  return meta.hosts.some((a) => h === a || h.endsWith("." + a));
}

/** The value to type: for a TOTP seed, the current code. */
export function getValue(cfg: AppConfig, name: string, now = Date.now()): string {
  const meta = findSecret(cfg, name);
  if (!meta) throw new AbError("BAD_REQUEST", `no secret called ${name} (npm run ab -- secrets list)`);
  let b64: string | undefined;
  if (usesKeychain()) {
    try {
      b64 = execFileSync("security", ["find-generic-password", "-s", service(), "-a", name, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      throw new AbError("BAD_REQUEST", `secret ${name} is listed but not in the Keychain: set it again`);
    }
  } else b64 = readJson<Record<string, string>>(valueFile(cfg), {})[name];
  if (!b64) throw new AbError("BAD_REQUEST", `secret ${name} has no value: set it again`);
  const value = Buffer.from(b64, "base64").toString("utf8");
  return meta.kind === "totp" ? totp(value, now) : value;
}

// ---- TOTP (RFC 6238): what an authenticator app shows, from its seed.

export function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = alphabet.indexOf(c);
    if (i < 0) throw new AbError("BAD_REQUEST", "totp: the seed is not base32 (letters A–Z and digits 2–7, as an authenticator app shows it)");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (!out.length) throw new AbError("BAD_REQUEST", "totp: empty seed");
  return Buffer.from(out);
}

/**
 * The code for `now`. A seed may be given as base32 or as an otpauth:// URI
 * (what the QR code holds), whose digits and period are honoured.
 */
export function totp(seed: string, now = Date.now(), opts: { digits?: number; period?: number } = {}): string {
  let secret = seed.trim();
  let digits = opts.digits ?? 6;
  let period = opts.period ?? 30;
  if (secret.startsWith("otpauth://")) {
    const u = new URL(secret);
    secret = u.searchParams.get("secret") ?? "";
    digits = Number(u.searchParams.get("digits") ?? digits);
    period = Number(u.searchParams.get("period") ?? period);
  }
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)));
  const h = createHmac("sha1", key).update(counter).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}
