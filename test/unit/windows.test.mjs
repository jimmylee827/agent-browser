import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WindowPool } from "../../packages/mcp-server/dist/windows.js";

/** A stand-in Chrome: windows hold tabs; a window with no tab closes. */
function fakeChrome() {
  let next = 100;
  const tabs = new Map(); // tabId -> { windowId, url, active }
  const windows = new Set();
  const inWin = (w) => [...tabs].filter(([, t]) => t.windowId === w);
  const activate = (id) => {
    const t = tabs.get(id);
    for (const [, o] of inWin(t.windowId)) o.active = false;
    t.active = true;
  };
  const drop = (w) => {
    if (!inWin(w).length) windows.delete(w);
  };
  const newWindow = (tabId, url) => {
    const w = next++;
    windows.add(w);
    const id = tabId ?? next++;
    const from = tabs.get(id)?.windowId;
    tabs.set(id, { windowId: w, url: url ?? tabs.get(id)?.url ?? "about:blank", active: false });
    activate(id);
    if (from !== undefined) drop(from);
    return { w, id };
  };
  const calls = [];
  const req = async (method, p = {}) => {
    calls.push(method);
    await new Promise((r) => setTimeout(r, 1));
    switch (method) {
      case "engine.windowState":
        return { state: windows.has(p.windowId) ? "normal" : "gone" };
      case "engine.tabs":
        return { tabs: [...tabs].map(([tabId, t]) => ({ tabId, ...t })) };
      case "engine.openSessionWindow": {
        if (p.adoptTabId != null) {
          tabs.get(p.adoptTabId).url = p.url;
          return { tabId: p.adoptTabId, windowId: tabs.get(p.adoptTabId).windowId, type: "normal" };
        }
        if (p.windowId != null && windows.has(p.windowId)) {
          const id = p.reuseTabId ?? next++;
          tabs.set(id, { windowId: p.windowId, url: p.url, active: false });
          activate(id);
          return { tabId: id, windowId: p.windowId, type: "normal", ...(p.reuseTabId ? { reused: true } : {}) };
        }
        const { w, id } = newWindow(undefined, p.url);
        return { tabId: id, windowId: w, type: "normal" };
      }
      case "engine.tabPlace": {
        const t = tabs.get(p.tabId);
        if (p.activate) activate(p.tabId);
        return { windowId: t.windowId, active: t.active, windowType: "normal" };
      }
      case "engine.moveTab": {
        const t = tabs.get(p.tabId);
        if (p.toWindowId != null) {
          const from = t.windowId;
          t.windowId = p.toWindowId;
          if (p.activate) activate(p.tabId);
          drop(from);
          return { windowId: p.toWindowId };
        }
        return { windowId: newWindow(p.tabId).w };
      }
      case "engine.mergeWindow":
        for (const [, t] of inWin(p.from)) t.windowId = p.to;
        drop(p.from);
        return {};
    }
    throw new Error(`unexpected ${method}`);
  };
  return { req, tabs, windows, calls, newWindow };
}

const session = (key, extra = {}) => ({ key, label: key, shared: false, legacy: false, lastSeen: new Map(), ...extra });
const stateFile = () => join(mkdtempSync(join(tmpdir(), "abwin-")), "agent-window.json");

test("two sessions opening pages share one window", async () => {
  const c = fakeChrome();
  const pool = new WindowPool(c.req, stateFile(), () => false);
  const fa = { key: "a" };
  const a = await pool.open(fa, "https://a.test/", false);
  await pool.leave(fa);
  const fb = { key: "b" };
  const b = await pool.open(fb, "https://b.test/", false);
  await pool.leave(fb);
  assert.equal(a.windowId, b.windowId);
  assert.equal(c.windows.size, 1);
  assert.equal(pool.home, a.windowId);
});

test("a session's call brings its tab to the front of the shared window", async () => {
  const c = fakeChrome();
  const pool = new WindowPool(c.req, stateFile(), () => false);
  const sa = session("a");
  const sb = session("b");
  for (const s of [sa, sb]) {
    const f = { key: s.key };
    s.tabId = (await pool.open(f, `https://${s.key}.test/`, false)).tabId;
    await pool.leave(f);
  }
  assert.equal(c.tabs.get(sa.tabId).active, false, "b opened last, so a is behind it");
  const f = { key: "a" };
  await pool.enter(f, sa);
  assert.equal(c.tabs.get(sa.tabId).active, true);
  await pool.leave(f);
});

test("two agents acting at once: the second steps out to a window, then comes back", async () => {
  const c = fakeChrome();
  const pool = new WindowPool(c.req, stateFile(), () => false);
  const sa = session("a");
  const sb = session("b");
  for (const s of [sa, sb]) {
    const f = { key: s.key };
    s.tabId = (await pool.open(f, `https://${s.key}.test/`, false)).tabId;
    await pool.leave(f);
  }
  const home = pool.home;
  const fa = { key: "a" };
  const fb = { key: "b" };
  await Promise.all([pool.enter(fa, sa), pool.enter(fb, sb)]);
  assert.equal(c.windows.size, 2, "both tabs in front at the same time takes two windows");
  assert.equal(c.tabs.get(sa.tabId).active, true);
  assert.equal(c.tabs.get(sb.tabId).active, true);
  assert.notEqual(c.tabs.get(sa.tabId).windowId, c.tabs.get(sb.tabId).windowId);
  // b finishes first: home is still in use by a, so b's window waits.
  await pool.leave(fb);
  assert.equal(c.windows.size, 2);
  await pool.leave(fa);
  assert.equal(c.windows.size, 1, "once nobody acts, everything folds back into one window");
  assert.equal(c.tabs.get(sb.tabId).windowId, home);
  assert.equal(c.tabs.get(sa.tabId).windowId, home);
});

test("a session's own consecutive calls never move it", async () => {
  const c = fakeChrome();
  const pool = new WindowPool(c.req, stateFile(), () => false);
  const sa = session("a");
  const f0 = { key: "a" };
  sa.tabId = (await pool.open(f0, "https://a.test/", false)).tabId;
  await pool.leave(f0);
  for (let i = 0; i < 3; i++) {
    const f = { key: "a" };
    await pool.enter(f, sa);
    await pool.leave(f);
  }
  assert.equal(c.windows.size, 1);
  assert.ok(!c.calls.includes("engine.moveTab"));
});

test("opening while another agent acts in the shared window uses a window beside it, merged later", async () => {
  const c = fakeChrome();
  const pool = new WindowPool(c.req, stateFile(), () => false);
  const sa = session("a");
  const fa = { key: "a" };
  sa.tabId = (await pool.open(fa, "https://a.test/", false)).tabId; // a still acting
  const fb = { key: "b" };
  const b = await pool.open(fb, "https://b.test/", false);
  assert.notEqual(b.windowId, pool.home);
  assert.equal(c.windows.size, 2);
  await pool.leave(fb);
  await pool.leave(fa);
  assert.equal(c.windows.size, 1);
  assert.equal(c.tabs.get(b.tabId).windowId, pool.home);
});

test("a closed shared window is replaced, and the choice survives a restart", async () => {
  const c = fakeChrome();
  const file = stateFile();
  const pool = new WindowPool(c.req, file, () => false);
  const f = { key: "a" };
  const a = await pool.open(f, "https://a.test/", false);
  await pool.leave(f);
  const again = new WindowPool(c.req, file, () => false);
  assert.equal(again.home, a.windowId, "a daemon restart keeps using the same window");
  // The person closes it.
  c.tabs.delete(a.tabId);
  c.windows.delete(a.windowId);
  const f2 = { key: "b" };
  const b = await again.open(f2, "https://b.test/", false);
  await again.leave(f2);
  assert.notEqual(b.windowId, a.windowId);
  assert.equal(again.home, b.windowId);
});

test("a blank tab nobody holds is reused instead of adding a tab", async () => {
  const c = fakeChrome();
  const { w, id } = c.newWindow(undefined, "about:blank");
  const file = stateFile();
  const pool = new WindowPool(c.req, file, () => false);
  const f0 = { key: "z" };
  await pool.open(f0, undefined, false, id); // the wake's spare becomes home
  await pool.leave(f0);
  assert.equal(pool.home, w);
  const f = { key: "a" };
  const a = await pool.open(f, "https://a.test/", false);
  assert.equal(a.tabId, id, "the blank tab was taken over");
  assert.equal(c.tabs.size, 1);
});

test("sessions with a viewport and background jobs are left to their own windows", async () => {
  const c = fakeChrome();
  const pool = new WindowPool(c.req, stateFile(), () => false);
  for (const s of [session("v", { viewport: { width: 390, height: 844 }, tabId: 1 }), session("j", { job: "poll", tabId: 2 })]) {
    const f = { key: s.key };
    await pool.enter(f, s);
    await pool.leave(f);
  }
  assert.deepEqual(c.calls, []);
});
