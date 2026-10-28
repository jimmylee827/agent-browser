// Background jobs: a page kept open in its own window, its matching traffic
// written to disk as it arrives, and the page healed when it stops answering.
//
// The daemon drives it, not the page. testohelper had to put its self-healing
// in the content script because its service worker died; here the daemon is a
// launchd agent that outlives the worker, and its reloads go through
// chrome.tabs, which a page cannot see. The decisions are ladder.ts's.
//
// Files, under the state dir:
//   jobs.json                 every job's spec and state (written before each remedy)
//   jobs/<id>/<date>.ndjson   what it recorded, one entry per line
//   jobs/<id>/log.ndjson      what it did: loads, remedies, give-ups

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig, LadderSettings } from "./config.js";
import type { Bridge } from "./bridge/server.js";
import type { Audit } from "./audit.js";
import type { Session, SessionManager } from "./sessions.js";
import { AbError, codeOf } from "./errors.js";
import { evalBlockedBy } from "./policy.js";
import { decide, freshState, type LadderState, type Observation } from "./ladder.js";
import { agentChromeRunning, launchBrowser } from "./host-helper-client.js";
import type { NetEntry } from "./network.js";
import { allowedOn, findSecret, getValue } from "./secrets.js";

export interface CaptureRule {
  urlPattern: string;
  method?: string;
  status?: string;
}

export const STEP_ACTIONS = ["click", "fill", "type", "select", "check", "uncheck", "press", "wait", "dismiss-consent"] as const;

/** One thing a job does on its page after each load. */
export interface JobStep {
  action: (typeof STEP_ACTIONS)[number];
  name?: string;
  role?: string;
  /** fill/type/select: the text; press: the key; wait: text to wait for (or use `text`). */
  value?: string;
  text?: string;
  /** fill/type: the name of a secret the user approved (`npm run ab -- secrets set`), typed instead of `value`. */
  secret?: string;
  /** Skip, rather than fail, when the element is not there (a banner that does not always show). */
  optional?: boolean;
  timeoutMs?: number;
}

export interface JobSpec {
  id: string;
  url: string;
  /** "none": keep the page open, it polls by itself. "reload": refresh every intervalMs. */
  refresh: "none" | "reload";
  intervalMs?: number;
  capture: CaptureRule[];
  health?: { text?: string; response?: { urlPattern: string } };
  ladder?: Partial<LadderSettings>;
  keepVisible?: boolean;
  steps?: JobStep[];
  enabled: boolean;
  createdAt: number;
  createdBy: string;
}

export type JobStatus = "starting" | "running" | "healing" | "halted" | "waiting-bridge" | "needs-attention" | "stopped";

export interface JobState extends LadderState {
  status: JobStatus;
  tabId?: number;
  windowId?: number;
  records: number;
  lastRecordAt?: number;
  lastError?: string;
  lastReason?: string;
  heartbeatAt?: number;
  bridgeDownSince?: number;
  windowState?: string;
  /** The extension version the page was loaded under. */
  extVersion?: string;
  /** pageLoadedAt of the load the steps last ran after. */
  stepsRanFor?: number;
  lastStepError?: string;
  /** A step it would not do (no approved secret, the wrong host): stays until a person resumes the job. */
  refused?: string;
}

interface Job {
  spec: JobSpec;
  state: JobState;
}

interface JobsFile {
  version: 1;
  jobs: Job[];
  /** Browser launches the supervisor made, for its daily limit. */
  launches: number[];
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DAY = 24 * 3600_000;

const compiles = (p: string) => {
  try {
    new RegExp(p);
    return true;
  } catch {
    return false;
  }
};

/** A spec as asked for, made whole, or the reason it cannot run. */
export function validateSpec(input: Partial<JobSpec>, cfg: AppConfig, existing: string[] = [], by = "unknown", now = Date.now()): JobSpec {
  const bad = (m: string) => new AbError("BAD_REQUEST", m);
  const id = String(input.id ?? "").toLowerCase();
  if (!ID.test(id)) throw bad("id: lower-case letters, digits and dashes, up to 40, starting with a letter or digit");
  if (existing.includes(id)) throw bad(`a job called ${id} exists: stop and remove it first, or pick another id`);
  if (!cfg.jobs.enabled) throw new AbError("JOB_LIMIT", "background jobs are switched off (jobs.enabled in the config)");
  if (existing.length >= cfg.jobs.maxJobs) throw new AbError("JOB_LIMIT", `${existing.length} jobs already, and jobs.maxJobs is ${cfg.jobs.maxJobs}`);
  let url: URL;
  try {
    url = new URL(String(input.url));
  } catch {
    throw bad("url: a full http(s) address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw bad("url: http or https only");
  const blocked = evalBlockedBy(url.href, cfg.network.blockedDomains);
  if (blocked) throw new AbError("NETWORK_BLOCKED", `${url.hostname} is on network.blockedDomains (${blocked}): a job cannot record it`);
  const capture = (input.capture ?? []).map((c) => ({ ...c, urlPattern: String(c.urlPattern ?? "") }));
  if (!capture.length) throw bad("capture: at least one {urlPattern} — which responses to record");
  for (const c of capture) if (!c.urlPattern || !compiles(c.urlPattern)) throw bad(`capture.urlPattern is not a regular expression: ${c.urlPattern}`);
  if (input.health?.text && !compiles(input.health.text)) throw bad(`health.text is not a regular expression: ${input.health.text}`);
  if (input.health?.response?.urlPattern && !compiles(input.health.response.urlPattern)) throw bad("health.response.urlPattern is not a regular expression");
  const steps = (input.steps ?? []).map((st) => ({ ...st }));
  if (steps.length > 10) throw bad("steps: at most 10");
  for (const [i, st] of steps.entries()) {
    const at = `steps[${i}]`;
    if (!STEP_ACTIONS.includes(st.action)) throw bad(`${at}.action: one of ${STEP_ACTIONS.join(", ")}`);
    if (["click", "fill", "type", "select", "check", "uncheck"].includes(st.action) && !st.name && !st.role) throw bad(`${at}: say which element (name, and role if needed)`);
    if (["fill", "type"].includes(st.action) && st.value === undefined && !st.secret) throw bad(`${at}: ${st.action} needs value, or secret`);
    if (st.action === "press" && !st.value) throw bad(`${at}: press needs value (a key, e.g. Enter)`);
    if (st.action === "wait" && !st.text && !st.value) throw bad(`${at}: wait needs text`);
    if (st.secret) {
      const meta = findSecret(cfg, st.secret);
      if (!meta) throw bad(`${at}.secret: no secret called ${st.secret}; the user sets one with npm run ab -- secrets set ${st.secret} --kind … --host ${url.hostname}`);
      if (!allowedOn(meta, url.hostname))
        throw new AbError("POLICY_BLOCKED", `${at}.secret: ${st.secret} is approved for ${meta.hosts.join(", ")}, not ${url.hostname}`, {
          recovery: "ask the user; only they can approve a secret for another host",
        });
    }
  }
  const refresh = input.refresh === "reload" ? "reload" : "none";
  const settings = { ...cfg.jobs.defaults, ...(input.ladder ?? {}) };
  if (refresh === "reload") {
    const every = Number(input.intervalMs);
    if (!Number.isFinite(every) || every < cfg.jobs.minIntervalMs) throw bad(`intervalMs: at least ${cfg.jobs.minIntervalMs} (jobs.minIntervalMs)`);
    if (3_600_000 / every > settings.maxLoadsPerHour)
      throw new AbError("JOB_LIMIT", `a refresh every ${Math.round(every / 1000)}s is ${Math.ceil(3_600_000 / every)} loads an hour, over maxLoadsPerHour (${settings.maxLoadsPerHour})`, {
        recovery: "ask for a slower interval; a person may raise ladder.maxLoadsPerHour for this job",
      });
  }
  return {
    id,
    url: url.href,
    refresh,
    ...(refresh === "reload" ? { intervalMs: Number(input.intervalMs) } : {}),
    capture,
    ...(input.health ? { health: input.health } : {}),
    ...(input.ladder ? { ladder: input.ladder } : {}),
    keepVisible: !!input.keepVisible,
    ...(steps.length ? { steps } : {}),
    enabled: true,
    createdAt: now,
    createdBy: by,
  };
}

export const jobsFile = (cfg: AppConfig) => resolve(cfg.stateDir, "jobs.json");
export const jobDir = (cfg: AppConfig, id: string) => resolve(cfg.stateDir, "jobs", id);
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export function loadJobs(cfg: AppConfig): JobsFile {
  try {
    const f = JSON.parse(readFileSync(jobsFile(cfg), "utf8")) as JobsFile;
    return { version: 1, jobs: f.jobs ?? [], launches: f.launches ?? [] };
  } catch {
    return { version: 1, jobs: [], launches: [] };
  }
}

/** Atomic: a crash mid-write leaves the old file, never half of one. */
export function saveJobs(cfg: AppConfig, f: JobsFile): void {
  mkdirSync(cfg.stateDir, { recursive: true });
  const tmp = `${jobsFile(cfg)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, jobsFile(cfg));
}

function append(cfg: AppConfig, id: string, file: string, lines: unknown[]): void {
  if (!lines.length) return;
  const dir = jobDir(cfg, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(resolve(dir, file), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
}

/** Record files older than retainDays (never today's), and folders of jobs that no longer exist once empty. */
export function pruneJobs(cfg: AppConfig, liveIds: string[], now = Date.now()): number {
  const root = resolve(cfg.stateDir, "jobs");
  const cutoff = day(now - cfg.evidence.retainDays * DAY);
  let removed = 0;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return 0;
  }
  for (const id of dirs) {
    const dir = resolve(root, id);
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const m = /^(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(f);
      if (m && m[1] < cutoff && m[1] !== day(now)) {
        rmSync(resolve(dir, f), { force: true });
        removed++;
      }
    }
    if (!liveIds.includes(id) && readdirSync(dir).every((f) => f === "log.ndjson")) {
      const log = resolve(dir, "log.ndjson");
      if (!existsSync(log) || statSync(log).mtimeMs < now - cfg.evidence.retainDays * DAY) {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    }
  }
  return removed;
}

/**
 * Read a job's records from disk, oldest first, from a cursor
 * ("<date>:<line>") so `tail --follow` picks up where it left off.
 */
export function readRecords(cfg: AppConfig, id: string, opts: { after?: string; limit?: number; urlPattern?: string; file?: "records" | "log" } = {}) {
  const dir = jobDir(cfg, id);
  const limit = Math.min(opts.limit ?? 100, 1000);
  let re: RegExp | null = null;
  if (opts.urlPattern) {
    try {
      re = new RegExp(opts.urlPattern, "i");
    } catch {
      re = new RegExp(opts.urlPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
  }
  const files = opts.file === "log" ? ["log.ndjson"] : (existsSync(dir) ? readdirSync(dir) : []).filter((f) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f)).sort();
  const [afterFile, afterLine] = (opts.after ?? "").split(":");
  const out: unknown[] = [];
  let next = opts.after ?? "";
  for (const f of files) {
    const name = f.replace(/\.ndjson$/, "");
    if (afterFile && name < afterFile) continue;
    let lines: string[];
    try {
      lines = readFileSync(resolve(dir, f), "utf8").split("\n").filter(Boolean);
    } catch {
      continue;
    }
    const start = name === afterFile ? Number(afterLine) || 0 : 0;
    for (let i = start; i < lines.length; i++) {
      next = `${name}:${i + 1}`;
      let rec: { url?: string };
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (re && !re.test(rec.url ?? "")) continue;
      out.push(rec);
      if (out.length >= limit) return { records: out, next, more: true };
    }
  }
  return { records: out, next, more: false };
}

const isFailed = (e: NetEntry) => !!e.error || e.status === 0 || (typeof e.status === "number" && e.status >= 400);
const ok2xx = (e: NetEntry) => typeof e.status === "number" && e.status >= 200 && e.status < 300;
const matcher = (p?: string) => {
  if (!p) return null;
  try {
    const re = new RegExp(p, "i");
    return (u: string) => re.test(u);
  } catch {
    return (u: string) => u.includes(p);
  }
};

export class JobRunner {
  private file: JobsFile;
  private timers = new Map<string, NodeJS.Timeout>();
  private busy = new Set<string>();
  private supervisor?: NodeJS.Timeout;
  private lastLaunchAt = 0;

  constructor(
    private ctx: { cfg: AppConfig; bridge: Bridge; sessions: SessionManager; audit: Audit },
  ) {
    this.file = loadJobs(ctx.cfg);
  }

  private get cfg() {
    return this.ctx.cfg;
  }

  private save() {
    try {
      saveJobs(this.cfg, this.file);
    } catch (e) {
      this.ctx.audit.log("jobs.save_failed", { error: String((e as Error).message) });
    }
  }

  private find(id: string): Job {
    const j = this.file.jobs.find((x) => x.spec.id === id);
    if (!j) throw new AbError("JOB_NOT_FOUND", `no job called ${id}`, { jobs: this.file.jobs.map((x) => x.spec.id) });
    return j;
  }

  private log(j: Job, event: string, detail: Record<string, unknown> = {}) {
    append(this.cfg, j.spec.id, "log.ndjson", [{ ts: Date.now(), event, ...detail }]);
    this.ctx.audit.log(`job.${event}`, { job: j.spec.id, ...detail });
  }

  start(): void {
    // Each job resumes where it was: the tick finds its tab again, or opens one.
    for (const j of this.file.jobs) if (j.spec.enabled) this.schedule(j, 2000);
    this.supervisor = setInterval(() => void this.supervise(), 30_000);
    this.supervisor.unref();
  }

  stopAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.supervisor) clearInterval(this.supervisor);
    this.save();
  }

  private schedule(j: Job, delay = this.cfg.jobs.checkEveryMs) {
    clearTimeout(this.timers.get(j.spec.id));
    if (!j.spec.enabled) return;
    const t = setTimeout(() => {
      void this.tick(j).finally(() => {
        if (this.file.jobs.includes(j)) this.schedule(j);
      });
    }, delay);
    t.unref();
    this.timers.set(j.spec.id, t);
  }

  create(input: Partial<JobSpec>, by: string): { spec: JobSpec; state: JobState } {
    const spec = validateSpec(input, this.cfg, this.file.jobs.map((j) => j.spec.id), by);
    const j: Job = { spec, state: { ...freshState(Date.now()), status: "starting", records: 0 } };
    this.file.jobs.push(j);
    this.save();
    this.log(j, "created", { url: spec.url, by });
    this.schedule(j, 0);
    return this.view(j);
  }

  async stop(id: string, by: string) {
    const j = this.find(id);
    j.spec.enabled = false;
    clearTimeout(this.timers.get(id));
    await this.ctx.sessions.withLock(`j:${id}`, async () => {
      const s = this.ctx.sessions.jobSession(id);
      if (this.ctx.bridge.connected()) {
        await this.ctx.bridge.request("net.unwatch", { jobId: id }).catch(() => {});
        await this.drain(j).catch(() => {});
        if (s.windowId !== undefined) await this.ctx.bridge.request("engine.closeWindow", { windowId: s.windowId }).catch(() => {});
      }
      this.ctx.sessions.unbind(s);
    });
    j.state.status = "stopped";
    j.state.tabId = j.state.windowId = undefined;
    this.save();
    this.log(j, "stopped", { by });
    return this.view(j);
  }

  resume(id: string, by: string) {
    const j = this.find(id);
    if (j.spec.enabled) return this.view(j);
    j.spec.enabled = true;
    j.state = { ...j.state, ...freshState(Date.now()), status: "starting", records: j.state.records, refused: undefined, stepsRanFor: undefined };
    this.save();
    this.log(j, "resumed", { by });
    this.schedule(j, 0);
    return this.view(j);
  }

  async remove(id: string, by: string) {
    const j = this.find(id);
    if (j.spec.enabled) await this.stop(id, by);
    this.file.jobs = this.file.jobs.filter((x) => x !== j);
    this.ctx.sessions.drop(this.ctx.sessions.jobSession(id));
    this.save();
    this.log(j, "removed", { by });
    return { removed: id, records: jobDir(this.cfg, id), note: "its records stay on disk until evidence.retainDays has passed" };
  }

  list() {
    return this.file.jobs.map((j) => this.view(j));
  }

  status(id: string) {
    return this.view(this.find(id));
  }

  read(id: string, opts: Parameters<typeof readRecords>[2]) {
    this.find(id);
    return readRecords(this.cfg, id, opts);
  }

  /** The tab a job's live buffer is on, for browser_network({job}). */
  tabOf(id: string): number | undefined {
    return this.find(id).state.tabId;
  }

  needsAttention(): string[] {
    return this.file.jobs.filter((j) => j.state.status === "needs-attention").map((j) => j.spec.id);
  }

  private view(j: Job) {
    return { spec: j.spec, state: j.state, files: jobDir(this.cfg, j.spec.id) };
  }

  private settings(j: Job): LadderSettings {
    return { ...this.cfg.jobs.defaults, ...(j.spec.ladder ?? {}) };
  }

  private patterns(j: Job): string[] {
    return [...j.spec.capture.map((c) => c.urlPattern), ...(j.spec.health?.response ? [j.spec.health.response.urlPattern] : [])];
  }

  /** Records out of the browser and onto disk; what they say about the page's health. */
  private async drain(j: Job): Promise<Pick<Observation, "good" | "any" | "faults">> {
    const obs = { good: [] as number[], any: [] as number[], faults: [] as number[] };
    const health = matcher(j.spec.health?.response?.urlPattern);
    const capture = j.spec.capture.map((c) => ({ url: matcher(c.urlPattern)!, method: c.method?.toUpperCase(), status: c.status }));
    for (let batch = 0; batch < 20; batch++) {
      const r = await this.ctx.bridge.request<{ entries: NetEntry[]; ids: number[] }>("net.drain", { jobId: j.spec.id, olderThanMs: 2000, maxBytes: 2_000_000 });
      if (!r.ids.length) break;
      const keep = r.entries.filter((e) => !e.url || capture.some((c) => c.url(e.url) && (!c.method || c.method === e.method)) || health?.(e.url));
      append(this.cfg, j.spec.id, `${day(Date.now())}.ndjson`, keep.map((e) => ({ ...e, job: j.spec.id, uid: `${e.tabId}:${e.id}` })));
      await this.ctx.bridge.request("net.ack", { ids: r.ids });
      for (const e of keep) {
        if (e.socketId !== undefined && e.type !== "ws-open" && !e.status) {
          obs.any.push(e.ts);
          continue; // a message: alive, but not a response
        }
        obs.any.push(e.ts);
        if (isFailed(e)) obs.faults.push(e.ts);
        else if (ok2xx(e) && (health ? health(e.url) : true)) obs.good.push(e.ts);
      }
      j.state.records += keep.length;
      if (keep.length) j.state.lastRecordAt = Date.now();
      if (r.ids.length < 50) break;
    }
    return obs;
  }

  /** The job's tab, found again after a restart, or opened. */
  private async ensureTab(j: Job, s: Session): Promise<boolean> {
    const alive = async (tabId: number) => {
      const p = await this.ctx.bridge.request<{ tab?: { url?: string; windowId?: number } }>("engine.ping", { tabId }).catch((e) => (codeOf(e) === "TAB_GONE" ? null : { tab: undefined }));
      return p;
    };
    if (s.tabId !== undefined && (await alive(s.tabId))) return true;
    // The daemon restarted: the tab it had may still be open.
    if (j.state.tabId !== undefined) {
      const p = await alive(j.state.tabId);
      if (p?.tab?.url && new URL(p.tab.url).origin === new URL(j.spec.url).origin && !this.ctx.sessions.ownerOfTab(j.state.tabId)) {
        this.ctx.sessions.bind(s, j.state.tabId, p.tab.windowId ?? j.state.windowId);
        await this.ctx.bridge.request("net.watch", { tabId: j.state.tabId, jobId: j.spec.id, patterns: this.patterns(j) });
        this.log(j, "rebound", { tabId: j.state.tabId });
        return true;
      }
    }
    return false;
  }

  private async openTab(j: Job, s: Session): Promise<void> {
    if (s.windowId !== undefined) await this.ctx.bridge.request("engine.closeWindow", { windowId: s.windowId }).catch(() => {});
    // Watch before the page loads, so its first requests are the job's too.
    const w = await this.ctx.bridge.request<{ tabId: number; windowId: number }>("engine.openSessionWindow", { url: "about:blank" });
    this.ctx.sessions.bind(s, w.tabId, w.windowId);
    j.state.tabId = w.tabId;
    j.state.windowId = w.windowId;
    await this.ctx.bridge.request("net.watch", { tabId: w.tabId, jobId: j.spec.id, patterns: this.patterns(j) });
    await this.ctx.bridge.request("engine.navigate", { tabId: w.tabId, url: j.spec.url });
  }

  private async tick(j: Job): Promise<void> {
    if (this.busy.has(j.spec.id) || !j.spec.enabled) return;
    this.busy.add(j.spec.id);
    try {
      await this.ctx.sessions.withLock(`j:${j.spec.id}`, () => this.tickLocked(j));
    } catch (e) {
      j.state.lastError = String((e as Error).message ?? e).slice(0, 300);
      this.save();
    } finally {
      this.busy.delete(j.spec.id);
    }
  }

  private async tickLocked(j: Job): Promise<void> {
    const now = Date.now();
    // The kill switch first, and quietly: every bridge call would be refused
    // and audited, once a minute, for as long as it is on. The page itself
    // keeps recording into the browser; the backlog drains when it is off.
    if (existsSync(resolve(this.cfg.stateDir, "HALT"))) {
      if (j.state.status !== "halted") this.log(j, "halted");
      j.state.status = "halted";
      return this.save();
    }
    if (!this.ctx.bridge.connected()) {
      j.state.status = "waiting-bridge";
      j.state.bridgeDownSince ??= now;
      return this.save();
    }
    j.state.bridgeDownSince = undefined;
    if (j.state.refused) {
      j.state.status = "needs-attention";
      return this.save();
    }
    const s = this.ctx.sessions.jobSession(j.spec.id);

    const first = j.state.status === "starting" && j.state.tabId === undefined;
    let tabAlive = first ? false : await this.ensureTab(j, s);
    if (first) {
      await this.openTab(j, s);
      j.state.loads.push(now);
      j.state.pageLoadedAt = now;
      this.log(j, "opened", { tabId: j.state.tabId, url: j.spec.url });
      tabAlive = true;
    }

    // The extension was updated under the job's page: its record would start
    // in the middle. The tab is the job's own, so load it again (within the cap).
    const ext = this.ctx.bridge.extension?.version;
    if (tabAlive && !first && ext && j.state.extVersion && ext !== j.state.extVersion) {
      const recent = j.state.loads.filter((t) => t > now - 3_600_000 && t <= now);
      if (recent.length < this.settings(j).maxLoadsPerHour) {
        await this.ctx.bridge.request("engine.navigate", { tabId: j.state.tabId, action: "reload" });
        j.state.loads.push(now);
        j.state.pageLoadedAt = now;
        this.log(j, "rearmed", { from: j.state.extVersion, to: ext });
      } else this.log(j, "rearm_capped", { from: j.state.extVersion, to: ext });
    }
    if (ext) j.state.extVersion = ext;

    const seen = await this.drain(j);
    // The job's steps, once per page load, when the page has had time to start.
    if (tabAlive && j.spec.steps?.length && j.state.pageLoadedAt !== undefined && j.state.stepsRanFor !== j.state.pageLoadedAt && now - j.state.pageLoadedAt >= this.settings(j).pageGraceMs) {
      j.state.stepsRanFor = j.state.pageLoadedAt;
      const r = await this.runSteps(j);
      if (r.failedAt) seen.faults.push(r.failedAt);
      if (r.refused) {
        j.state.refused = r.refused;
        j.state.status = "needs-attention";
        j.state.lastReason = r.refused;
        this.save();
        return;
      }
    }
    let healthText: boolean | null = null;
    if (tabAlive && j.spec.health?.text) {
      const r = await this.ctx.bridge
        .request<{ found?: boolean; timedOut?: boolean; error?: string }>("engine.waitFor", { tabId: j.state.tabId, textPattern: j.spec.health.text, timeout: 1 })
        .catch(() => null);
      healthText = r && !r.error ? !!r.found : null;
    }
    if (tabAlive && j.state.windowId !== undefined) {
      const w = await this.ctx.bridge.request<{ state?: string; restored?: boolean }>("engine.windowState", { windowId: j.state.windowId, restore: j.spec.keepVisible }).catch(() => null);
      if (w?.restored) this.log(j, "unminimised");
      j.state.windowState = w?.state;
    }

    const d = decide(
      j.state,
      { ...seen, healthText, tabAlive },
      this.settings(j),
      { refresh: j.spec.refresh, intervalMs: j.spec.intervalMs, hasTextHealth: !!j.spec.health?.text, expectsResponses: !j.spec.health?.text || !!j.spec.health?.response },
      now,
    );
    j.state = { ...j.state, ...d.state };
    j.state.status = d.state.gaveUpAt !== undefined ? "needs-attention" : d.state.rung > 0 ? "healing" : "running";
    if (d.reason) j.state.lastReason = d.reason;
    j.state.heartbeatAt = now;
    j.state.lastError = undefined;
    // State first: if acting kills us (or the page), the next start knows.
    this.save();
    if (d.log) this.log(j, d.action === "none" ? "recovered" : d.action, { reason: d.reason, rung: d.state.rung });

    const tabId = j.state.tabId;
    if (d.action === "refresh" || d.action === "reload") await this.ctx.bridge.request("engine.navigate", { tabId, action: "reload" });
    else if (d.action === "renavigate") await this.ctx.bridge.request("engine.navigate", { tabId, url: j.spec.url });
    else if (d.action === "recreate") {
      await this.openTab(j, s);
      this.save();
    }
  }

  /**
   * Do the job's steps on its page. Never a value the user did not approve
   * into a password, one-time-code or card field: that stops the job and
   * says so. An approved secret is typed only on its own hosts, and its value
   * goes nowhere but the field (not the log, not the audit, not the record).
   */
  private async runSteps(j: Job): Promise<{ failedAt?: number; refused?: string }> {
    const tabId = j.state.tabId;
    const req = <T,>(m: string, p: Record<string, unknown> = {}) => this.ctx.bridge.request<T>(m, { ...p, tabId });
    for (const [i, st] of (j.spec.steps ?? []).entries()) {
      if (existsSync(resolve(this.cfg.stateDir, "HALT"))) return {};
      const label = `${st.action}${st.name ? ` "${st.name}"` : ""}${st.secret ? ` with secret ${st.secret}` : ""}`;
      const fail = (why: string) => {
        j.state.lastStepError = `step ${i + 1} (${label}): ${why}`;
        this.log(j, "step_failed", { step: i + 1, action: st.action, why });
        return { failedAt: Date.now() };
      };
      try {
        if (st.action === "wait") {
          const r = await req<{ timedOut?: boolean }>("engine.waitFor", { text: st.text ?? st.value, timeout: Math.min(st.timeoutMs ?? 10_000, 25_000) });
          if (r.timedOut && !st.optional) return fail("the text did not appear");
          continue;
        }
        if (st.action === "dismiss-consent") {
          const w = await req<{ needsHuman?: { reason?: string; dismiss?: { ref: number; name: string } } }>("engine.detectWall");
          const d = w.needsHuman?.reason === "consent" ? w.needsHuman.dismiss : undefined;
          if (!d) continue; // no banner this time
          if (process.env.AB_DRY_RUN !== "1") await req("engine.act", { ref: d.ref, action: "click", onDialog: "accept" });
          this.log(j, "step", { step: i + 1, action: st.action, clicked: d.name });
          continue;
        }
        const loc = await req<{ snapshotGeneration?: number; matches?: { ref: number; name: string }[] }>("engine.locate", { name: st.name, role: st.role });
        const m = loc.matches?.[0];
        if (!m) {
          if (st.optional) continue;
          return fail("no such element on the page");
        }
        let value = st.value;
        if (["fill", "type", "select", "press"].includes(st.action)) {
          const info = await req<{ sensitive?: boolean }>("engine.inspect", { ref: m.ref, gen: loc.snapshotGeneration });
          if (info.sensitive && !st.secret) {
            this.log(j, "step_refused", { step: i + 1, action: st.action, why: "a password, code or card field, and no approved secret" });
            return { refused: `step ${i + 1} (${label}) would type into a password, one-time-code or card field without a secret the user approved` };
          }
          if (st.secret) {
            const meta = findSecret(this.cfg, st.secret);
            const page = await req<{ tab?: { url?: string } }>("engine.ping");
            const host = (() => {
              try {
                return new URL(page.tab?.url ?? "").hostname;
              } catch {
                return "";
              }
            })();
            if (!meta) {
              this.log(j, "step_refused", { step: i + 1, why: `secret ${st.secret} was removed` });
              return { refused: `secret ${st.secret} no longer exists` };
            }
            if (!allowedOn(meta, host)) {
              // A redirect to another host (a look-alike login page) gets nothing.
              this.log(j, "step_refused", { step: i + 1, why: `secret ${st.secret} is not approved for ${host}` });
              return { refused: `step ${i + 1}: the page is on ${host || "an unknown host"}, and ${st.secret} is approved only for ${meta.hosts.join(", ")}` };
            }
            value = getValue(this.cfg, st.secret);
            // Before it is typed: the request that sends it is then redacted however its fields are named.
            await this.ctx.bridge.request("net.secret", { value });
          }
        }
        if (process.env.AB_DRY_RUN !== "1") {
          try {
            await req("engine.act", { ref: m.ref, gen: loc.snapshotGeneration, action: st.action, value, onDialog: "accept" });
          } catch (e) {
            // The step navigated: the page went away mid-call, which is success.
            if (!/PORT_CLOSED_AFTER_ACTION|back\/forward cache|message channel (is )?closed|Receiving end does not exist/i.test(String((e as Error).message))) throw e;
          }
        }
        this.log(j, "step", { step: i + 1, action: st.action, name: m.name, ...(st.secret ? { secret: st.secret } : {}) });
      } catch (e) {
        if (st.optional) continue;
        return fail(String((e as Error).message ?? e).slice(0, 200));
      }
    }
    j.state.lastStepError = undefined;
    return {};
  }

  /**
   * The bridge has been down a while and a job wants the browser. On macOS a
   * Chrome with no window open has unloaded its profile and the extension
   * with it; opening a window loads them back. A Chrome that is not running
   * is started. Both a few times a day at most.
   */
  private async supervise(): Promise<void> {
    if (!this.file.jobs.some((j) => j.spec.enabled)) return;
    if (this.ctx.bridge.connected() || existsSync(resolve(this.cfg.stateDir, "HALT"))) return;
    const downSince = Math.min(...this.file.jobs.map((j) => j.state.bridgeDownSince ?? Date.now()));
    const now = Date.now();
    if (now - downSince < this.cfg.jobs.bridgeDownRecoverAfterMs || now - this.lastLaunchAt < 10 * 60_000) return;
    this.file.launches = this.file.launches.filter((t) => t > now - DAY && t <= now);
    if (this.file.launches.length >= this.cfg.jobs.maxBrowserLaunchesPerDay) return;
    const running = agentChromeRunning(this.cfg.profileDir);
    this.lastLaunchAt = now;
    this.file.launches.push(now);
    this.save();
    const via = await launchBrowser();
    this.ctx.audit.log("jobs.recover_browser", { reason: running ? "chrome running with no agent window" : "chrome not running", via, attempt: this.file.launches.length });
  }
}
