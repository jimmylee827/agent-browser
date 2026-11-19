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
  if (s.registration === "missing") return "In Agent Chrome, open chrome://extensions, enable Developer mode and Load unpacked → packages/extension." +
    (!s.chromePid ? " If Agent Chrome is closed, open it once with npm run launch." : "");
  if (suppressed) return "A browser wake did not reconnect the bridge. Check Agent Bridge in chrome://extensions and reload it once if enabled; do not keep opening windows.";
  return "Call agent_browser_ensure_running for one browser wake.";
}

type Wake = { via: "launch" | "window"; wakeId: number; marker?: string };
type Result = { state: "connected" | "failed" | "human" | "suppressed" | "halted" | "waiting"; wake?: Wake; attempted?: boolean; advice?: string };
type Bridge = { connected(): boolean; waitForConnection(ms: number): Promise<boolean>; healthyEpoch?: number };

/** One shared, bounded wake. A caller deadline never cancels another caller's recovery. */
export class BrowserRecovery {
  private inFlight?: Promise<Result>;
  private attempted?: string;
  private coldWake?: { epoch?: number; at: number };
  private stage = "idle";
  private lastResult?: Result["state"];
  constructor(private bridge: Bridge, private read: () => Readiness, private wake: (s: Readiness) => Promise<Wake>,
    private timing = { graceMs: 8000, wakeMs: 35_000 }) {}

  private key(s: Readiness) {
    return JSON.stringify([this.bridge.healthyEpoch, s.chromePid, s.registration]);
  }

  private suppressed(s: Readiness) {
    return this.attempted === this.key(s) || (!!this.coldWake && this.coldWake.epoch === this.bridge.healthyEpoch &&
      Date.now() - this.coldWake.at < 60_000);
  }

  status() {
    const s = this.read();
    const connected = this.bridge.connected();
    return { chromeRunning: s.chromePid !== null, extensionRegistration: s.registration,
      recoveryStage: this.inFlight ? this.stage : "idle", ...(this.lastResult ? { lastRecovery: this.lastResult } : {}),
      ...(!connected || s.halted ? { nextStep: this.inFlight && !s.halted ? "Wait for the in-progress browser recovery." : recoveryAdvice(s, this.suppressed(s)) } : {}) };
  }

  async ensure(timeoutMs: number): Promise<Result> {
    if (this.inFlight) return this.wait(this.inFlight, timeoutMs, false);
    if (this.bridge.connected() && !this.read().halted) return { state: "connected" };
    const task = this.run().then((result) => { this.lastResult = result.state; return result; }).finally(() => {
      this.inFlight = undefined;
      this.stage = "idle";
    });
    this.inFlight = task;
    return this.wait(task, timeoutMs, true);
  }

  private async wait(task: Promise<Result>, timeoutMs: number, owner: boolean): Promise<Result> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([task, new Promise<Result>((done) => {
        timer = setTimeout(() => done({ state: "waiting", advice: "Browser recovery is still in progress; check status before requesting another action." }), timeoutMs);
      })]);
      return owner ? result : { ...result, attempted: undefined };
    } finally { clearTimeout(timer); }
  }

  private stop(s: Readiness): Result | undefined {
    if (s.halted) return { state: "halted", advice: recoveryAdvice(s) };
    if (s.registration === "disabled" || s.registration === "missing") return { state: "human", advice: recoveryAdvice(s) };
  }

  private async run(): Promise<Result> {
    let s = this.read();
    const blocked = this.stop(s);
    if (blocked) return blocked;
    this.stage = "waiting_for_reconnect";
    if (s.chromePid !== null && await this.bridge.waitForConnection(this.timing.graceMs)) return { state: "connected" };
    if (this.bridge.connected()) return { state: "connected" };
    s = this.read();
    const nowBlocked = this.stop(s);
    if (nowBlocked) return nowBlocked;
    if (this.suppressed(s)) return { state: "suppressed", advice: recoveryAdvice(s, true) };
    this.attempted = this.key(s);
    if (s.chromePid === null) this.coldWake = { epoch: this.bridge.healthyEpoch, at: Date.now() };
    this.stage = s.chromePid === null ? "starting_agent_chrome" : "opening_agent_window";
    let wake: Wake | undefined;
    try { wake = await this.wake(s); } catch { /* a lost launch reply is not proof that no window opened */ }
    this.stage = "waiting_for_worker";
    const connected = await this.bridge.waitForConnection(this.timing.wakeMs);
    const final = this.read();
    // A PID created by the same launch is not a new outage. Do not clear
    // suppression on a hello or one successful probe; use a healthy interval.
    this.attempted = this.key(final);
    return { state: final.halted ? "halted" : connected ? "connected" : "failed", wake, attempted: true,
      ...(final.halted || !connected ? { advice: recoveryAdvice(final, true) } : {}) };
  }
}
