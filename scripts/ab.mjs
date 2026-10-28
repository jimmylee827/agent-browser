#!/usr/bin/env node
// The agent browser from a terminal: everything an agent's tools can read or
// start, a person can too. A thin client of the control plane (127.0.0.1:8788);
// --json prints the server's own answer for scripts.
//
//   npm run ab -- status
//   npm run ab -- tabs
//   npm run ab -- network --tab 123 [--url RE] [--status 4xx] [--type api|all|…] [--bodies] [--limit N]
//   npm run ab -- network --tab 123 --export har|ndjson
//   npm run ab -- network --tab 123 --clear
//
// Exit codes: 0 ok, 1 error, 2 the browser is not connected or the kill switch is on.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const cfg = readJson(resolve(root, "config/default.json")) ?? {};
const local = readJson(process.env.AB_LOCAL_CONFIG ?? resolve(root, "config/local.json")) ?? {};
const port = process.env.AB_CONTROL_PORT ?? local.bridge?.controlPort ?? cfg.bridge?.controlPort ?? 8788;
const BASE = `http://127.0.0.1:${port}`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) {
    positional.push(a);
    continue;
  }
  const key = a.slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) flags[key] = true;
  else {
    flags[key] = next;
    i++;
  }
}
const JSON_OUT = !!flags.json;

function die(message, code = 1) {
  if (JSON_OUT) console.log(JSON.stringify({ error: message }));
  else console.error(message);
  process.exit(code);
}

async function call(path, init) {
  let r;
  try {
    r = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(60_000) });
  } catch {
    die(`the agent-browser server is not answering on ${BASE} (npm run setup starts it)`, 2);
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = body.error ?? `HTTP ${r.status}`;
    die(msg, /HALTED|not connected|BRIDGE/.test(msg) ? 2 : 1);
  }
  return body;
}

const qs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v === true ? "1" : v)}`)
    .join("&");

const out = (data, human) => {
  if (JSON_OUT) console.log(JSON.stringify(data, null, 2));
  else human(data);
};

const describe = (e) => {
  const status = e.error ? `failed (${e.error})` : (e.status ?? "?");
  const size = e.bodyChars !== undefined ? ` ${e.bodyChars}ch` : "";
  const frames = e.frames ? ` ${e.frames.length} msg` : "";
  return `${new Date(e.ts).toISOString().slice(11, 23)}  ${(e.via ?? "").padEnd(8)} ${String(e.method ?? "").padEnd(6)} ${String(status).padEnd(4)} ${e.url}${size}${frames}`;
};

const commands = {
  async status() {
    const s = await call("/status");
    out(s, (d) => {
      console.log(`bridge     ${d.bridgeConnected ? "connected" : "NOT connected"}`);
      console.log(`build      ${d.build?.running}${d.build?.staleBuild ? `  (stale: ${d.build.onDisk} on disk)` : ""}`);
      if (d.extension) console.log(`extension  ${d.extension.running ?? "?"}${d.extension.stale ? `  (stale: ${d.extension.onDisk} on disk)` : ""}`);
    });
    if (!s.bridgeConnected) process.exit(2);
  },

  async tabs() {
    const t = await call("/tabs");
    out(t, (d) => {
      for (const tab of d.tabs ?? []) console.log(`${String(tab.tabId).padEnd(12)} ${tab.active ? "*" : " "} ${tab.url}`);
    });
  },

  async network() {
    const tab = flags.tab ?? positional[0];
    if (!tab) die("say which tab: --tab <id> (ids: npm run ab -- tabs)");
    if (flags.clear) return out(await call(`/network/clear?${qs({ tabId: tab })}`), (d) => console.log(`cleared ${d.cleared} record(s)`));
    if (flags.export) {
      const r = await call(`/network/export?${qs({ tabId: tab, format: flags.export === true ? "har" : flags.export, url: flags.url, status: flags.status, type: flags.type ?? "all" })}`);
      return out(r, (d) => console.log(`${d.entries} entr${d.entries === 1 ? "y" : "ies"} → ${d.file}`));
    }
    const r = await call(
      `/network?${qs({ tabId: tab, url: flags.url, method: flags.method, status: flags.status, type: flags.type, since: flags.since, bodies: !!flags.bodies, headers: !!flags.headers, limit: flags.limit, bodyChars: flags["body-chars"] })}`,
    );
    out(r, (d) => {
      console.log(`${d.matched} matching of ${d.total} recorded on ${d.url}${d.blocked ? " (blocked host: metadata only)" : ""}`);
      for (const e of d.entries) {
        console.log(describe(e));
        if (e.requestBody) console.log(`    → ${e.requestBody}`);
        if (e.body) console.log(`    ← ${e.body}`);
        else if (e.bodyPreview) console.log(`    ← ${e.bodyPreview}${e.bodyChars > 200 ? " …" : ""}`);
      }
    });
  },
};

if (!cmd || cmd === "help" || flags.help || !commands[cmd]) {
  const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
  const header = lines.slice(0, lines.findIndex((l) => !l.startsWith("//")));
  console.log(header.map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(cmd && !commands[cmd] && cmd !== "help" ? 1 : 0);
}
await commands[cmd]();
