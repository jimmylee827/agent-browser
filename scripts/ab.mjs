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
//   npm run ab -- network --job ID [same filters]          a background job's live page
//   npm run ab -- jobs list | status ID [--check]
//   npm run ab -- jobs start --id ID --url URL --capture RE [--capture RE…] [--every 15m]
//                            [--health-text RE] [--health-response RE] [--max-loads N] [--keep-visible]
//   npm run ab -- jobs start --spec job.json
//   npm run ab -- jobs stop|resume|remove ID
//   npm run ab -- jobs tail ID [--follow] [--log] [--url RE]
//
// Exit codes: 0 ok, 1 error, 2 the browser is not connected or the kill switch is on,
// 3 (jobs status --check) a job needs attention.
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
  const value = next === undefined || next.startsWith("--") ? true : (i++, next);
  // A flag given twice (--capture a --capture b) collects its values.
  flags[key] = key in flags ? [].concat(flags[key], value) : value;
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
    let tab = flags.tab ?? positional[0];
    if (flags.job) {
      const j = await call(`/jobs/${encodeURIComponent(flags.job)}`);
      tab = j.state.tabId;
      if (tab === undefined) die(`job ${flags.job} has no page open now (status: ${j.state.status})`);
    }
    if (!tab) die("say which tab: --tab <id> (ids: npm run ab -- tabs), or --job <id>");
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

const duration = (v) => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(v));
  if (!m) die(`not a duration: ${v} (e.g. 90s, 15m, 1h)`);
  return Math.round(Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "ms"]);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (ts) => (ts ? `${Math.round((Date.now() - ts) / 1000)}s ago` : "never");

commands.jobs = async () => {
  const sub = positional[0] ?? "list";
  const id = positional[1] ?? flags.id;
  const one = () => id ?? die(`jobs ${sub} needs an id`);
  if (sub === "list") {
    const r = await call("/jobs");
    return out(r, (d) => {
      if (!d.jobs.length) return console.log("no jobs");
      for (const j of d.jobs)
        console.log(`${j.spec.id.padEnd(20)} ${j.state.status.padEnd(16)} ${String(j.state.records).padStart(6)} records, last ${ago(j.state.lastRecordAt)}  ${j.spec.url}`);
    });
  }
  if (sub === "status") {
    if (flags.check && !id) {
      const r = await call("/jobs");
      out({ needsAttention: r.needsAttention }, (d) => console.log(d.needsAttention.length ? `needs attention: ${d.needsAttention.join(", ")}` : "all jobs fine"));
      process.exit(r.needsAttention.length ? 3 : 0);
    }
    const j = await call(`/jobs/${encodeURIComponent(one())}`);
    out(j, (d) => {
      const s = d.state;
      console.log(`${d.spec.id}: ${s.status}${s.lastReason ? ` (${s.lastReason})` : ""}`);
      console.log(`  page     ${d.spec.url}  tab ${s.tabId ?? "-"}${s.windowState === "minimized" ? "  window minimised: its page is throttled (--keep-visible restores it)" : ""}`);
      console.log(`  records  ${s.records}, last ${ago(s.lastRecordAt)}; last good response ${ago(s.lastGoodAt)}`);
      console.log(`  ladder   rung ${s.rung}, ${s.loads.length} page load(s) in the last hour${s.lastError ? `; error: ${s.lastError}` : ""}`);
      console.log(`  files    ${d.files}`);
    });
    if (flags.check && j.state.status === "needs-attention") process.exit(3);
    return;
  }
  if (sub === "start") {
    let spec;
    if (flags.spec) spec = JSON.parse(readFileSync(resolve(flags.spec), "utf8"));
    else {
      const capture = [].concat(flags.capture ?? []).filter((c) => c !== true);
      spec = {
        id: one(),
        url: flags.url,
        capture: capture.map((urlPattern) => ({ urlPattern })),
        ...(flags.every ? { refresh: "reload", intervalMs: duration(flags.every) } : {}),
        ...(flags["health-text"] || flags["health-response"]
          ? { health: { ...(flags["health-text"] ? { text: flags["health-text"] } : {}), ...(flags["health-response"] ? { response: { urlPattern: flags["health-response"] } } : {}) } }
          : {}),
        ...(flags["max-loads"] ? { ladder: { maxLoadsPerHour: Number(flags["max-loads"]) } } : {}),
        ...(flags["keep-visible"] ? { keepVisible: true } : {}),
      };
    }
    const r = await call("/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec) });
    return out(r, (d) => console.log(`started ${d.spec.id}: ${d.spec.url}\n  records → ${d.files}\n  stop with: npm run ab -- jobs stop ${d.spec.id}`));
  }
  if (sub === "stop" || sub === "resume") {
    const r = await call(`/jobs/${encodeURIComponent(one())}/${sub}`, { method: "POST" });
    return out(r, (d) => console.log(`${d.spec.id}: ${d.state.status}`));
  }
  if (sub === "remove") {
    const r = await call(`/jobs/${encodeURIComponent(one())}`, { method: "DELETE" });
    return out(r, (d) => console.log(`removed ${d.removed}; ${d.note} (${d.records})`));
  }
  if (sub === "tail") {
    const path = `/jobs/${encodeURIComponent(one())}/${flags.log ? "log" : "records"}`;
    let after = "";
    for (;;) {
      const r = await call(`${path}?${qs({ after, limit: 200, url: flags.url })}`);
      for (const rec of r.records) {
        if (JSON_OUT) console.log(JSON.stringify(rec));
        else if (flags.log) console.log(`${new Date(rec.ts).toISOString()}  ${rec.event}${rec.reason ? `: ${rec.reason}` : ""}`);
        else console.log(describe(rec));
      }
      after = r.next || after;
      if (!flags.follow) return;
      if (!r.more) await sleep(2000);
    }
  }
  die(`unknown: jobs ${sub}`);
};

if (!cmd || cmd === "help" || flags.help || !commands[cmd]) {
  const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
  const header = lines.slice(0, lines.findIndex((l) => !l.startsWith("//")));
  console.log(header.map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(cmd && !commands[cmd] && cmd !== "help" ? 1 : 0);
}
await commands[cmd]();
