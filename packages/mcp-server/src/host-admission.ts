import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { AbError } from "./errors.js";

export interface Pause { host: string; until: number; reason: string; source: string }
export function retryAfter(value: string | undefined, now: number): number | undefined {
  if (!value?.trim()) return;
  const v = value.trim();
  const end = /^\d+$/.test(v) ? now + Number(v) * 1000 : Date.parse(v);
  return Number.isFinite(end) && end > now && end - now <= 30 * 86_400_000 ? end : undefined;
}
const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ""); } catch { return ""; } };

/** Synchronous admission/update: shared by jobs and tools, including CLI callers.
 * This prevents our next operation, not the page's autonomous background traffic. */
export class HostAdmission {
  private pauses = new Map<string, Pause>();
  private observed = new Set<string>();
  constructor(private file: string, private cooldown: () => number = () => 300_000, private clock = Date.now) {
    try {
      for (const p of JSON.parse(readFileSync(file, "utf8")))
        if (typeof p.host === "string" && Number.isFinite(p.until) && p.until > clock()) this.pauses.set(p.host, p);
    } catch {}
  }
  list(): (Pause & { remainingMs: number })[] {
    const now = this.clock();
    return [...this.pauses.values()].filter((p) => p.until > now).map((p) => ({ ...p, remainingMs: p.until - now }));
  }
  check(url: string, override = false): void {
    const p = this.pauses.get(hostOf(url));
    if (!override && p && p.until > this.clock())
      throw new AbError("HOST_PAUSED", `host paused: ${p.host}; inspect the page or wait, do not repeat the action`, { ...p, remainingMs: p.until - this.clock(), dispatch: "not_dispatched" });
  }
  observe(entries: { url: string; status?: number; ts?: number; id?: number; tabId?: number; responseHeaders?: { name: string; value: string }[] }[], source: string): void {
    for (const e of entries) {
      const retry = e.responseHeaders?.find((h) => h.name.toLowerCase() === "retry-after")?.value;
      if (e.status === 429 || (e.status === 503 && retryAfter(retry, this.clock())))
        this.pause(e.url, `HTTP ${e.status}`, source, retry, e.ts === undefined ? undefined : `request:${e.tabId}:${e.id}:${e.ts}`);
    }
  }
  pause(url: string, reason: string, source: string, retry?: string, evidenceId?: string): Pause | undefined {
    const host = hostOf(url);
    if (!host) return;
    // Reading the same response/document again is not a fresh rejection and
    // must not turn a finite cooldown into an everlasting pause.
    if (evidenceId) {
      const key = `${host}:${evidenceId}`;
      if (this.observed.has(key)) return this.pauses.get(host);
      this.observed.add(key);
      if (this.observed.size > 4096) this.observed.delete(this.observed.values().next().value!);
    }
    const now = this.clock();
    const until = Math.max(now + this.cooldown(), retryAfter(retry, now) ?? 0, this.pauses.get(host)?.until ?? 0);
    const p = { host, until, reason, source };
    this.pauses.set(host, p);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = this.file + ".new";
      writeFileSync(temp, JSON.stringify(this.list()), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch { /* admission remains effective in memory */ }
    return p;
  }
}
