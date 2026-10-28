// When a background job's page stops answering, what to do about it.
//
// A pure function, so every rule is tested without a browser. The rules are
// testohelper's, which each cost an outage to learn:
//   - Two clocks: a GOOD response (2xx, matching the health pattern) and any
//     fault. Only a real recovery — good responses, no fault for a quiet
//     spell, the text check passing — clears the ladder. A cached 200 right
//     after our own reload once reset it every time, and the page looped.
//   - Never act inside the grace period after a load: the page is hydrating.
//   - A blank screen must be seen twice running before it counts.
//   - Climb one rung per remedy: reload, navigate again, reopen the window,
//     then stop and say so, once. A cooldown between remedies.
//   - A hard cap on page loads per rolling hour, scheduled refreshes included,
//     so a sick site is never hammered. Timestamps from the future (a clock
//     corrected, a copied state file) do not count.

import type { LadderSettings } from "./config.js";

export interface LadderState {
  rung: 0 | 1 | 2 | 3;
  /** Page loads we caused, newest last (scheduled and remedial). */
  loads: number[];
  startedAt: number;
  pageLoadedAt?: number;
  lastGoodAt?: number;
  lastAnyAt?: number;
  lastFaultAt?: number;
  /** Start of the current run of faults with nothing good since. */
  faultSince?: number;
  strikes: number;
  blankSince?: number;
  lastHealAt?: number;
  gaveUpAt?: number;
  cappedAt?: number;
  nextRefreshAt?: number;
}

export interface Observation {
  /** Timestamps of records seen since the last tick. */
  good: number[];
  any: number[];
  faults: number[];
  /** The text check: true passed, false failed, null not checked or unknown. */
  healthText: boolean | null;
  tabAlive: boolean;
}

export interface JobShape {
  refresh: "none" | "reload";
  intervalMs?: number;
  hasTextHealth: boolean;
  /** Does it record anything whose absence means trouble? */
  expectsResponses: boolean;
}

export type Action = "none" | "refresh" | "reload" | "renavigate" | "recreate" | "give-up" | "capped" | "cooldown";

export interface Decision {
  action: Action;
  state: LadderState;
  reason?: string;
  /** Worth a line in the job's log (each give-up and cap only once). */
  log: boolean;
}

const HOUR = 3_600_000;
const RUNG_ACTION: Action[] = ["reload", "renavigate", "recreate", "give-up"];

export const freshState = (now: number): LadderState => ({ rung: 0, loads: [], startedAt: now, strikes: 0 });

const latest = (ts: number[]) => (ts.length ? Math.max(...ts) : undefined);
const mins = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)}min` : `${Math.round(ms / 1000)}s`);

export function decide(
  prev: LadderState,
  obs: Observation,
  set: LadderSettings,
  job: JobShape,
  now: number,
  random: () => number = Math.random,
): Decision {
  const s: LadderState = { ...prev, loads: prev.loads.filter((t) => t <= now && t > now - HOUR) };

  // Clocks.
  const good = latest(obs.good.filter((t) => t <= now));
  const any = latest(obs.any.filter((t) => t <= now));
  const fault = latest(obs.faults.filter((t) => t <= now));
  if (good !== undefined) s.lastGoodAt = Math.max(s.lastGoodAt ?? 0, good);
  if (any !== undefined) s.lastAnyAt = Math.max(s.lastAnyAt ?? 0, any);
  if (fault !== undefined) {
    s.lastFaultAt = Math.max(s.lastFaultAt ?? 0, fault);
    s.faultSince ??= Math.min(...obs.faults);
  }
  if (s.faultSince !== undefined && (s.lastGoodAt ?? 0) > (s.lastFaultAt ?? 0)) s.faultSince = undefined;

  const inGrace = s.pageLoadedAt !== undefined && now - s.pageLoadedAt < set.pageGraceMs;

  // The text check, counted outside the grace period only.
  if (job.hasTextHealth && !inGrace) {
    if (obs.healthText === false) {
      s.strikes++;
      s.blankSince ??= now;
    } else if (obs.healthText === true) {
      s.strikes = 0;
      s.blankSince = undefined;
    }
  }

  const load = (action: Action, reason: string): Decision => {
    if (s.loads.length >= set.maxLoadsPerHour) {
      const first = s.cappedAt === undefined || now - s.cappedAt >= HOUR;
      if (first) s.cappedAt = now;
      return { action: "capped", state: s, reason: `${reason}, but ${set.maxLoadsPerHour} page loads in the last hour is the limit`, log: first };
    }
    s.loads.push(now);
    s.pageLoadedAt = now;
    s.strikes = 0;
    s.blankSince = undefined;
    return { action, state: s, reason, log: true };
  };

  if (!obs.tabAlive) {
    const d = load("recreate", "the job's tab is gone");
    if (d.action === "recreate") s.lastHealAt = now;
    return d;
  }

  // A real recovery clears the ladder.
  if (s.rung > 0 || s.gaveUpAt !== undefined) {
    const goodSinceHeal = (s.lastGoodAt ?? 0) > (s.lastHealAt ?? 0);
    const quiet = now - (s.lastFaultAt ?? 0) >= set.recoveryQuietMs;
    const textOk = !job.hasTextHealth || obs.healthText === true;
    const responsesOk = !job.expectsResponses || goodSinceHeal;
    if (quiet && textOk && responsesOk && (goodSinceHeal || job.hasTextHealth) && !inGrace) {
      s.rung = 0;
      s.gaveUpAt = undefined;
      s.faultSince = undefined;
      return { action: "none", state: s, reason: "recovered", log: true };
    }
  }

  // Is it sick?
  let sick: string | undefined;
  if (!inGrace) {
    const blank = job.hasTextHealth && s.strikes >= set.confirmStrikes;
    const recentFault = s.lastFaultAt !== undefined && now - s.lastFaultAt < 5 * 60_000;
    if (blank && recentFault) sick = "the page is blank and its requests are failing";
    else if (s.faultSince !== undefined && now - s.faultSince >= set.faultAfterMs) sick = `requests have failed for ${mins(now - s.faultSince)} with nothing succeeding`;
    else if (blank && s.blankSince !== undefined && now - s.blankSince >= set.staleAfterMs) sick = `the page has been blank for ${mins(now - s.blankSince)}`;
    else if (job.expectsResponses && now - (s.lastGoodAt ?? s.pageLoadedAt ?? s.startedAt) >= set.staleAfterMs)
      sick = `no good response for ${mins(now - (s.lastGoodAt ?? s.pageLoadedAt ?? s.startedAt))}`;
  }

  if (sick) {
    if (s.gaveUpAt !== undefined) return { action: "none", state: s, reason: sick, log: false };
    if (s.lastHealAt !== undefined && now - s.lastHealAt < set.cooldownMs) return { action: "cooldown", state: s, reason: sick, log: false };
    const action = RUNG_ACTION[s.rung];
    if (action === "give-up") {
      s.gaveUpAt = now;
      return { action, state: s, reason: `${sick}; reload, navigating again and reopening the window did not help`, log: true };
    }
    const d = load(action, sick);
    if (d.action === action) {
      s.lastHealAt = now;
      s.rung = (s.rung + 1) as LadderState["rung"];
    }
    return d;
  }

  // Healthy: a scheduled refresh, if one is due.
  if (job.refresh === "reload" && job.intervalMs) {
    if (s.nextRefreshAt === undefined) s.nextRefreshAt = (s.pageLoadedAt ?? now) + job.intervalMs;
    if (now >= s.nextRefreshAt) {
      const d = load("refresh", "scheduled refresh");
      // ±10%, so refreshes do not land on the same second every time.
      s.nextRefreshAt = now + Math.round(job.intervalMs * (0.9 + 0.2 * random()));
      return { ...d, log: d.action === "capped" ? d.log : false };
    }
  }
  return { action: "none", state: s, log: false };
}
