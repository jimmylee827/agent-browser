import { AbError } from "./errors.js";

/**
 * Sessions: who may drive which tab.
 *
 * Every MCP client connection (one launcher process — one agent conversation)
 * has an id. By default a client's calls go to its own private session, which
 * owns its own browser window, so two agents never type into, navigate, or
 * screenshot each other's page. Sharing is explicit: callers that pass the same
 * `session: "shared:<name>"` drive one tab together, and every result tells
 * them when someone else acted on it in between.
 *
 * `session: "default"` keeps the old behaviour — act on whatever tab is active —
 * for callers that rely on it, with a warning.
 *
 * One SessionManager lives for the whole daemon. (It used to be created per
 * MCP server, and the HTTP transport makes a server per request, so its mutex
 * never serialised anything.)
 */

export interface Session {
  key: string;
  /** Callers' own name for it, as they passed it. */
  label: string;
  shared: boolean;
  legacy: boolean;
  ownerClient: string;
  tabId?: number;
  windowId?: number;
  /** "popup" once the session has a viewport: only popup windows go below 500px wide. */
  windowType?: string;
  /** What the session asked its pages to be: a viewport, a phone, with sound. */
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  mobile?: boolean;
  sound?: boolean;
  lastActor?: string;
  lastActAt?: number;
  lease?: { client: string; until: number };
  /** What each client last saw, to tell it what changed since. */
  lastSeen: Map<string, { at: number; navCount?: number; docGen?: string }>;
  usedAt: number;
  /** A background job's own window (jobs.ts): never idled, never released with a client. */
  job?: string;
}

export interface Resolved {
  key: string;
  label: string;
  shared: boolean;
  legacy: boolean;
}

export const LEGACY = "default";
const SHARED = /^shared:(.+)$/;

/** Map a caller's `session` argument to a registry key. */
export function resolveKey(client: string, name?: string): Resolved {
  if (name?.startsWith("job:"))
    throw new AbError("BAD_REQUEST", `"${name}" is a background job's window, which only the job runner drives`, {
      recovery: "read what a job recorded with browser_network({job}) or browser_jobs({action:\"read\"}); use your own session for anything else",
    });
  if (name === LEGACY) return { key: LEGACY, label: LEGACY, shared: true, legacy: true };
  const m = name?.match(SHARED);
  if (m) return { key: `s:${m[1]}`, label: name!, shared: true, legacy: false };
  return name
    ? { key: `c:${client}:${name}`, label: name, shared: false, legacy: false }
    : { key: `c:${client}`, label: "(private)", shared: false, legacy: false };
}

export class SessionManager {
  private locks = new Map<string, Promise<void>>();
  private sessions = new Map<string, Session>();
  /** Tool calls running now, per client. */
  private running = new Map<string, number>();

  get(r: Resolved, client: string): Session {
    let s = this.sessions.get(r.key);
    if (!s) {
      s = { ...r, ownerClient: client, lastSeen: new Map(), usedAt: Date.now() };
      this.sessions.set(r.key, s);
    }
    return s;
  }

  /** The session a background job owns. */
  jobSession(id: string): Session {
    const s = this.get({ key: `j:${id}`, label: `job:${id}`, shared: false, legacy: false }, "jobs");
    s.job = id;
    return s;
  }

  drop(s: Session): void {
    this.sessions.delete(s.key);
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }

  /** The session that holds a tab, if any. */
  ownerOfTab(tabId: number): Session | undefined {
    return this.all().find((s) => s.tabId === tabId);
  }

  bind(s: Session, tabId: number, windowId?: number): void {
    s.tabId = tabId;
    if (windowId !== undefined) s.windowId = windowId;
  }

  unbind(s: Session): void {
    s.tabId = undefined;
    s.windowId = undefined;
  }

  /** Refuse when another client holds a live lease on a shared session. */
  checkLease(s: Session, client: string, now = Date.now()): void {
    if (s.lease && s.lease.until > now && s.lease.client !== client)
      throw new AbError("SESSION_LOCKED", `session ${s.label} is locked by client ${short(s.lease.client)}`, {
        lockedBy: short(s.lease.client),
        lockedFor: s.lease.until - now,
      });
  }

  takeLease(s: Session, client: string, ms: number, now = Date.now()): void {
    this.checkLease(s, client, now);
    s.lease = { client, until: now + ms };
  }

  releaseLease(s: Session, client: string): void {
    if (s.lease?.client === client) s.lease = undefined;
  }

  /**
   * Record that `client` acted, and say what others did since its last call.
   * Returns null when nothing foreign happened.
   */
  touch(
    s: Session,
    client: string,
    page: { navCount?: number; docGen?: string } = {},
    now = Date.now(),
  ): { lastActor: string; actedAgoMs: number; changedSinceYourLastCall?: { navigations?: number; documentGeneration?: string } } | null {
    const seen = s.lastSeen.get(client);
    const foreign = !!s.lastActor && s.lastActor !== client && (!seen || (s.lastActAt ?? 0) > seen.at);
    const out = foreign
      ? {
          lastActor: short(s.lastActor!),
          actedAgoMs: now - (s.lastActAt ?? now),
          ...(seen
            ? {
                changedSinceYourLastCall: {
                  ...(seen.navCount !== undefined && page.navCount !== undefined ? { navigations: page.navCount - seen.navCount } : {}),
                  ...(seen.docGen && page.docGen && seen.docGen !== page.docGen ? { documentGeneration: page.docGen } : {}),
                },
              }
            : {}),
        }
      : null;
    s.lastActor = client;
    s.lastActAt = now;
    s.usedAt = now;
    s.lastSeen.set(client, { at: now, ...page });
    return out;
  }

  /** Sessions owned by a client that has gone away. */
  release(client: string): Session[] {
    const gone = this.all().filter((s) => !s.shared && s.ownerClient === client);
    for (const s of gone) this.sessions.delete(s.key);
    for (const s of this.all()) this.releaseLease(s, client);
    return gone;
  }

  /** Private sessions unused for longer than `ms`: their windows stay open, unbound. */
  idle(ms: number, now = Date.now()): Session[] {
    return this.all().filter((s) => !s.legacy && !s.job && s.tabId !== undefined && now - s.usedAt > ms);
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => next);
    this.locks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }

  /** Count a call in flight for `client` while fn runs. */
  async track<T>(client: string, fn: () => Promise<T>): Promise<T> {
    this.running.set(client, (this.running.get(client) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = (this.running.get(client) ?? 1) - 1;
      if (n) this.running.set(client, n);
      else this.running.delete(client);
    }
  }

  /** Calls in flight from clients other than `client`. */
  othersRunning(client: string): number {
    let n = 0;
    for (const [c, k] of this.running) if (c !== client) n += k;
    return n;
  }
}

/** Client ids are UUIDs; eight characters are enough to tell them apart. */
export const short = (client: string) => client.slice(0, 8);
