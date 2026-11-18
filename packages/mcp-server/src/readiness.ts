import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Registration = "enabled" | "disabled" | "missing" | "unknown";

export function extensionRegistration(profileDir: string, extensionDir: string): Registration {
  let readable = 0;
  let uncertain = false;
  for (const file of ["Secure Preferences", "Preferences"]) {
    try {
      const prefs = JSON.parse(readFileSync(resolve(profileDir, "Default", file), "utf8"));
      if (!prefs || Array.isArray(prefs) || typeof prefs !== "object") { uncertain = true; continue; }
      const settings = prefs.extensions?.settings;
      if (settings != null && (typeof settings !== "object" || Array.isArray(settings))) { uncertain = true; continue; }
      readable++;
      const entries = Object.values(settings ?? {}) as { path?: string; state?: number; disable_reasons?: number | number[] }[];
      const entry = entries.find((e) => typeof e?.path === "string" && resolve(e.path) === resolve(extensionDir));
      if (entry) {
        const reasons = entry.disable_reasons;
        return entry.state === 0 || (Array.isArray(reasons) ? reasons.some(Boolean) : !!reasons) ? "disabled" : "enabled";
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") uncertain = true;
    }
  }
  return readable && !uncertain ? "missing" : "unknown";
}

export type Readiness = { chromePid: number | null; registration: Registration; halted: boolean };

export function recoveryAdvice(s: Readiness, suppressed = false) {
  if (s.halted) return "Agent Browser is paused by the user. Do not try to start it.";
  if (s.registration === "disabled") return "In Agent Chrome, open chrome://extensions and switch Agent Bridge on." +
    (!s.chromePid ? " If Agent Chrome is closed, open it once with npm run launch." : "");
  if (s.chromePid && s.registration === "missing") return "In Agent Chrome, open chrome://extensions, enable Developer mode and Load unpacked → packages/extension.";
  if (suppressed) return "A browser wake did not reconnect the bridge. Check Agent Bridge in chrome://extensions and reload it once if enabled; do not keep opening windows.";
  return "Call agent_browser_ensure_running for one browser wake.";
}

type Wake = { via: "launch" | "window"; wakeId: number };
type Result = { state: "connected" | "failed" | "human" | "suppressed" | "halted"; wake?: Wake; attempted?: boolean; advice?: string };
type Bridge = { connected(): boolean; waitForConnection(ms: number): Promise<boolean>; connectionEpoch?: number };

/** One wake through connection settlement; at most one wake per Chrome/profile state and outage. */
export class BrowserRecovery {
  private inFlight?: Promise<Result>;
  private attempted?: string;
  private coldWake?: { epoch?: number; at: number };
  constructor(private bridge: Bridge, private read: () => Readiness, private wake: (s: Readiness) => Promise<Wake>) {}

  private key(s: Readiness) {
    return JSON.stringify([this.bridge.connectionEpoch, s.chromePid, s.registration]);
  }

  private suppressed(s: Readiness) {
    return this.attempted === this.key(s) || (!!this.coldWake && this.coldWake.epoch === this.bridge.connectionEpoch &&
      Date.now() - this.coldWake.at < 60_000);
  }

  status() {
    const s = this.read();
    const connected = this.bridge.connected();
    return { chromeRunning: s.chromePid !== null, extensionRegistration: s.registration,
      ...(!connected || s.halted ? { nextStep: recoveryAdvice(s, this.suppressed(s)) } : {}) };
  }

  ensure(timeoutMs: number): Promise<Result> {
    if (this.bridge.connected()) {
      this.attempted = undefined;
      this.coldWake = undefined;
      return Promise.resolve({ state: "connected" });
    }
    if (this.inFlight) return this.inFlight.then(({ attempted: _, ...result }) => result);
    this.inFlight = this.run(timeoutMs).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async run(timeoutMs: number): Promise<Result> {
    const started = Date.now();
    const stop = (s: Readiness): Result | undefined => {
      if (s.halted) return { state: "halted", advice: recoveryAdvice(s) };
      if (s.registration === "disabled" || (s.chromePid !== null && s.registration === "missing"))
        return { state: "human", advice: recoveryAdvice(s) };
    };
    let s = this.read();
    const blocked = stop(s);
    if (blocked) return blocked;
    if (this.suppressed(s)) return { state: "suppressed", advice: recoveryAdvice(s, true) };
    if (s.chromePid !== null && await this.bridge.waitForConnection(Math.min(8000, timeoutMs))) return { state: "connected" };
    if (this.bridge.connected()) return { state: "connected" };
    s = this.read();
    const nowBlocked = stop(s);
    if (nowBlocked) return nowBlocked;
    if (this.suppressed(s)) return { state: "suppressed", advice: recoveryAdvice(s, true) };
    if (Date.now() - started >= timeoutMs) return { state: "failed", advice: "The bridge is still disconnected. Check Agent Browser status before trying again." };
    this.attempted = this.key(s);
    if (s.chromePid === null) this.coldWake = { epoch: this.bridge.connectionEpoch, at: Date.now() };
    let wake: Wake | undefined;
    try { wake = await this.wake(s); } catch { /* the launch may have happened before its reply failed */ }
    const connected = await this.bridge.waitForConnection(Math.max(0, timeoutMs - (Date.now() - started)));
    const final = this.read();
    if (connected) { this.attempted = undefined; this.coldWake = undefined; }
    // A cold launch changing the PID is part of this attempt, not permission to open a second window.
    else this.attempted = this.key(final);
    return { state: connected ? "connected" : "failed", wake, attempted: true,
      ...(!connected ? { advice: recoveryAdvice(final, true) } : {}) };
  }
}
