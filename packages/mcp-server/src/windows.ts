import { readFileSync, writeFileSync } from "node:fs";
import type { Session } from "./sessions.js";

/**
 * One window for every agent conversation.
 *
 * Sessions used to get a window each, and a person ended up with a stack of
 * them. Now every ordinary session's tab lives in one "home" window. Chrome
 * only runs a window's FRONT tab at full speed: a tab behind it is hidden, gets
 * no animation frames or IntersectionObserver callbacks, and its timers run
 * about once a second (measured on 2026-11-09: five 50 ms timers took 4.6 s).
 * So for the length of each call, the acting session's tab is brought to the
 * front of its window — without raising the window.
 *
 * Two sessions cannot both be in front of one window. When a call starts while
 * another session is acting in the same window, its tab moves out to a window of
 * its own for that call; once nobody is acting in home any more, such windows
 * are merged back. The number of windows is the number of agents acting at the
 * same instant, usually one.
 *
 * Kept out: sessions with a viewport (Chrome sizes a whole window, so each
 * needs its own) and background jobs (hours as a hidden tab would throttle
 * them to a crawl). Those keep their own windows, as before.
 */

type Req = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

/** The window one call stands in front of, for as long as the call runs. */
export interface Front {
  key: string;
  windowId?: number;
}

export const pooled = (s: Session): boolean => !s.legacy && !s.job && !s.viewport;

export class WindowPool {
  private homeId?: number;
  /** Windows opened only because home was busy; merged back when it is free. */
  private overflow = new Set<number>();
  private holds = new Map<number, { key: string; n: number }>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private req: Req,
    private stateFile: string,
    /** Whether a session holds this tab; a blank tab nobody holds can be reused. */
    private owned: (tabId: number) => boolean,
  ) {
    try {
      this.homeId = JSON.parse(readFileSync(stateFile, "utf8")).windowId;
    } catch {}
  }

  get home(): number | undefined {
    return this.homeId;
  }

  private setHome(id: number | undefined) {
    this.homeId = id;
    if (id !== undefined) this.overflow.delete(id);
    try {
      writeFileSync(this.stateFile, JSON.stringify({ windowId: id ?? null }));
    } catch {}
  }

  /** One decision at a time: two calls starting together must not both take the front. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private busy(windowId: number, key: string): boolean {
    const h = this.holds.get(windowId);
    return !!h && h.key !== key;
  }

  private hold(f: Front, windowId: number) {
    if (f.windowId === windowId) return;
    this.unhold(f);
    const h = this.holds.get(windowId);
    if (h && h.key === f.key) h.n++;
    else this.holds.set(windowId, { key: f.key, n: 1 });
    f.windowId = windowId;
  }

  private unhold(f: Front) {
    if (f.windowId === undefined) return;
    const h = this.holds.get(f.windowId);
    if (h && h.key === f.key && --h.n <= 0) this.holds.delete(f.windowId);
    f.windowId = undefined;
  }

  private async alive(windowId: number | undefined): Promise<boolean> {
    if (windowId === undefined) return false;
    const w = await this.req<{ state?: string }>("engine.windowState", { windowId }).catch(() => null);
    return !!w && w.state !== "gone";
  }

  /** Home, if it is still open; otherwise an overflow window takes its place. */
  private async liveHome(): Promise<number | undefined> {
    if (await this.alive(this.homeId)) return this.homeId;
    for (const o of [...this.overflow]) {
      if (await this.alive(o)) {
        this.setHome(o);
        return o;
      }
      this.overflow.delete(o);
    }
    if (this.homeId !== undefined) this.setHome(undefined);
    return undefined;
  }

  /**
   * Open a pooled session's first page: a tab in home, or a window of its own
   * when home is busy or there is none. `spare` is the blank tab a browser
   * wake opened, which is taken over rather than leaving it behind.
   */
  open(f: Front, url: string | undefined, sound: boolean | undefined, spare?: number): Promise<{ tabId: number; windowId: number; type: string }> {
    return this.serial(async () => {
      const home = await this.liveHome();
      let w: { tabId: number; windowId: number; type: string };
      if (spare !== undefined) {
        w = await this.req("engine.openSessionWindow", { url, sound, adoptTabId: spare });
      } else if (home !== undefined && !this.busy(home, f.key)) {
        const list = await this.req<{ tabs: { tabId: number; url: string; windowId: number }[] }>("engine.tabs", { action: "list" }).catch(() => null);
        const blank = list?.tabs.find((t) => t.windowId === home && /^(about:blank|chrome:\/\/newtab\/?|)$/.test(t.url ?? "") && !this.owned(t.tabId));
        w = await this.req("engine.openSessionWindow", { url, sound, windowId: home, reuseTabId: blank?.tabId });
      } else {
        w = await this.req("engine.openSessionWindow", { url, sound, likeWindowId: home });
      }
      if (w.windowId !== home) {
        if (home === undefined && w.type === "normal") this.setHome(w.windowId);
        else this.overflow.add(w.windowId);
      }
      this.hold(f, w.windowId);
      return w;
    });
  }

  /** Start of a call: put the session's tab in front of a window no other session is acting in. */
  enter(f: Front, s: Session): Promise<{ windowHidden?: boolean } | void> {
    if (!pooled(s) || s.tabId === undefined) return Promise.resolve();
    const tabId = s.tabId;
    return this.serial(async () => {
      const t = await this.req<{ windowId: number; active: boolean; windowType?: string }>("engine.tabPlace", { tabId }).catch(() => null);
      if (!t) return;
      let windowId = t.windowId;
      const home = this.homeId;
      if (this.busy(windowId, f.key)) {
        // Another agent is acting in this window: this call gets one of its own.
        const m = await this.req<{ windowId: number }>("engine.moveTab", { tabId, likeWindowId: home ?? windowId }).catch(() => null);
        if (!m) return;
        windowId = m.windowId;
        this.overflow.add(windowId);
      } else if (this.overflow.has(windowId) && home !== undefined && !this.busy(home, f.key) && t.windowType === "normal") {
        // Home is free again: come back to it.
        const m = await this.req<{ windowId: number }>("engine.moveTab", { tabId, toWindowId: home, activate: true }).catch(() => null);
        if (m) windowId = home;
      }
      this.hold(f, windowId);
      s.windowId = windowId;
      if (!t.active || windowId !== t.windowId)
        return (await this.req<{ windowHidden?: boolean }>("engine.tabPlace", { tabId, activate: true }).catch(() => null)) ?? undefined;
    });
  }

  /** End of a call: let go of the window, and fold windows nobody is acting in back into home. */
  leave(f: Front): Promise<void> {
    const had = f.windowId !== undefined;
    this.unhold(f);
    if (!had || !this.overflow.size) return Promise.resolve();
    return this.serial(async () => {
      const home = await this.liveHome();
      if (home === undefined || this.holds.has(home)) return;
      for (const o of [...this.overflow]) {
        if (this.holds.has(o)) continue;
        await this.req("engine.mergeWindow", { from: o, to: home }).catch(() => {});
        this.overflow.delete(o);
      }
    });
  }

  /** For status: the shared window and any windows open beside it. */
  describe(): { home?: number; overflow: number[]; acting: { windowId: number; session: string }[] } {
    return {
      home: this.homeId,
      overflow: [...this.overflow],
      acting: [...this.holds].map(([windowId, h]) => ({ windowId, session: h.key.slice(0, 12) })),
    };
  }
}
