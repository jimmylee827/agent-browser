// End-to-end checks against real Google Chrome, one per complaint in the
// field reports. Needs the one-time `npm run test:e2e:setup`; skips otherwise.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { startHarness, chromeAvailable, extensionInstalled } from "./harness.mjs";
import { decodePng } from "./png.mjs";

const ready = chromeAvailable() && extensionInstalled();
const skip = ready ? false : "the test browser is not set up: run `npm run test:e2e:setup` once";
let h;
const clients = {};
/** A tool caller for a named client (one MCP connection each). */
const as = async (id) => (clients[id] ??= await h.client(`${id}-${Date.now()}`));

before(async () => {
  if (!ready) return;
  h = await startHarness({ log: !!process.env.AB_TEST_LOG });
  assert.ok(h.connected, "the extension in the test browser did not connect; run `npm run test:e2e:setup`");
});
after(async () => h?.stop());

const tree = (snap) => snap.tree ?? snap.snapshotAfter?.tree ?? [];
const node = (snap, name) => tree(snap).find((n) => n.name?.includes(name));

test("two clients on one page never see each other's typing; each has its own tab", { skip }, async () => {
  const A = await as("iso-a");
  const B = await as("iso-b");
  const va = await A("agent_browser_visit", { url: h.url("form.html") });
  const vb = await B("agent_browser_visit", { url: h.url("form.html") });
  assert.ok(!va.isError && !vb.isError);
  assert.notEqual(va.data.tabId, vb.data.tabId);
  await A("agent_browser_act", { name: "Username", action: "fill", value: "alice", snapshot: "none" });
  await B("agent_browser_act", { name: "Username", action: "fill", value: "bob", snapshot: "none" });
  const oa = await A("browser_observe", {});
  const ob = await B("browser_observe", {});
  assert.equal(node(oa.data, "Username").state.value, "alice");
  assert.equal(node(ob.data, "Username").state.value, "bob");
  const shot = await A("browser_screenshot", {});
  assert.ok(!shot.isError && shot.images.length === 1);
  // B cannot reach into A's tab.
  const steal = await B("browser_observe", { tabId: va.data.tabId });
  assert.equal(steal.isError, true);
  assert.equal(steal.data.code, "TAB_OWNED_BY_OTHER");
});

test("a session with no page yet has nothing to screenshot (no foreign tab)", { skip }, async () => {
  const C = await as("fresh");
  const r = await C("browser_screenshot", {});
  assert.equal(r.isError, true);
  assert.equal(r.data.code, "NO_SESSION_TAB");
  assert.ok(r.data.degraded.length > 0);
});

test("a shared session warns when another client acted in between", { skip }, async () => {
  const A = await as("share-a");
  const B = await as("share-b");
  await A("agent_browser_visit", { url: h.url("form.html"), session: "shared:qa" });
  const b1 = await B("agent_browser_act", { name: "Username", action: "fill", value: "from b", session: "shared:qa", snapshot: "none" });
  assert.match(b1.data.warning, /another client/);
  const a2 = await A("browser_observe", { session: "shared:qa" });
  assert.match(a2.data.warning, /another client/);
  assert.equal(a2.data.sharedSession.session, "shared:qa");
  // A lease keeps the other one out.
  await A("browser_observe", { session: "shared:qa", lock: true, leaseMs: 5000 }).catch(() => {});
  const leased = await A("agent_browser_visit", { url: h.url("form.html"), session: "shared:qa", lock: true, leaseMs: 5000 });
  assert.ok(!leased.isError);
  const blocked = await B("browser_observe", { session: "shared:qa" });
  assert.equal(blocked.data.code, "SESSION_LOCKED");
  await A("agent_browser_visit", { url: h.url("form.html"), session: "shared:qa", lock: false });
});

test("the legacy \"default\" session still works, with a warning", { skip }, async () => {
  const A = await as("legacy");
  const r = await A("browser_tabs", { session: "default" });
  assert.ok(!r.isError);
  assert.match(r.data.warning, /session "default"/);
});

test("an animated page settles: consecutive captures are identical", { skip }, async () => {
  const A = await as("settle");
  await A("agent_browser_visit", { url: h.url("animated.html"), snapshot: "none" });
  const s1 = await A("browser_screenshot", {});
  const s2 = await A("browser_screenshot", {});
  assert.equal(s1.data.settled, true);
  assert.equal(s2.data.settled, true);
  assert.equal(s1.data.layoutHash, s2.data.layoutHash);
  assert.equal(s1.data.documentGeneration, s2.data.documentGeneration);
  assert.equal(s1.images[0].data, s2.images[0].data);
});

test("a capture after another client changed the page reports a new generation", { skip }, async () => {
  const A = await as("gen-a");
  const B = await as("gen-b");
  await A("agent_browser_visit", { url: h.url("animated.html"), session: "shared:gen", snapshot: "none" });
  const s1 = await A("browser_screenshot", { session: "shared:gen" });
  await B("agent_browser_visit", { url: h.url("form.html"), session: "shared:gen", snapshot: "none" });
  const s2 = await A("browser_screenshot", { session: "shared:gen" });
  assert.notEqual(s1.data.documentGeneration, s2.data.documentGeneration);
  assert.match(s2.data.warning, /another client/);
});

test("an element under a sticky header is captured with its own heading, at any scroll", { skip }, async () => {
  const A = await as("sticky");
  await A("agent_browser_visit", { url: h.url("sticky.html"), snapshot: "none" });
  for (const y of [0, 600]) {
    await A("browser_scroll", { y });
    const r = await A("browser_screenshot", { name: "Size finder", role: "region", scale: 1 });
    assert.ok(!r.isError, JSON.stringify(r.data));
    const img = decodePng(r.images[0].data);
    const [red, green, blue] = img.at(img.width / 2, 12); // inside the green heading bar
    assert.ok(green > 90 && red < 60 && blue < 60, `top of the capture at scroll ${y} is not the section's heading: ${[red, green, blue]}`);
  }
  const covered = await A("browser_screenshot", { name: "Covered button", role: "button" });
  assert.equal(covered.isError, true);
  assert.equal(covered.data.code, "OCCLUDED");
  assert.match(covered.data.occludedBy, /blocker/);
});

test("a captcha wall is reported as needing a human, with the frame and an image", { skip }, async () => {
  const A = await as("captcha");
  const v = await A("agent_browser_visit", { url: h.url("captcha.html") });
  assert.equal(v.data.outcome, "needs_human");
  assert.equal(v.data.needsHuman.reason, "captcha");
  assert.equal(v.data.needsHuman.agentCanFix, false);
  assert.equal(typeof v.data.needsHuman.node.ref, "number");
  assert.ok(v.images.length >= 1, "a screenshot of the wall comes with it");
  assert.ok(v.data.degraded.some((d) => /captcha/.test(d)));
  const act = await A("agent_browser_act", { name: "Trade Mark Text", action: "fill", value: "apple" });
  assert.equal(act.isError, true);
  assert.equal(act.data.code, "NEEDS_HUMAN");
  assert.ok(act.data.humanAction);
  // Asking for no tree must not hide the wall.
  const small = await A("agent_browser_visit", { url: h.url("captcha.html"), snapshot: "none" });
  assert.equal(small.data.outcome, "needs_human");
  assert.equal(small.data.needsHuman.reason, "captcha");
  assert.ok(small.images.length >= 1);
});

test("a cookie banner is a consent wall the agent can dismiss", { skip }, async () => {
  const A = await as("cookie");
  const v = await A("agent_browser_visit", { url: h.url("cookie.html") });
  assert.equal(v.data.needsHuman?.reason, "consent");
  assert.equal(v.data.needsHuman.agentCanFix, true);
  assert.match(v.data.needsHuman.dismiss.name, /Accept all/);
  const d = await A("agent_browser_act", { ref: v.data.needsHuman.dismiss.ref, action: "click" });
  assert.ok(!d.isError);
  assert.equal(d.data.snapshotAfter.needsHuman, undefined);
});

test("hover applies the page's :hover styles, or fails loudly", { skip }, async () => {
  const A = await as("hover");
  await A("agent_browser_visit", { url: h.url("hover.html"), snapshot: "none" });
  const r = await A("agent_browser_act", { name: "Pilot jacket", action: "hover", snapshot: "none" });
  assert.ok(!r.isError, JSON.stringify(r.data));
  assert.equal(r.data.signals.hoverStyleChanged, true);
  const shot = await A("browser_screenshot", { name: "Pilot jacket", scale: 1 });
  const img = decodePng(shot.images[0].data);
  const [red, , blue] = img.at(img.width / 2, img.height / 2);
  assert.ok(red > 200 && blue < 60, `the hover image is not showing: ${img.at(img.width / 2, img.height / 2)}`);
  const plain = await A("agent_browser_act", { name: "Plain link", action: "hover", snapshot: "none" });
  assert.equal(plain.isError, true);
  assert.equal(plain.data.code, "HOVER_NOT_EFFECTIVE");
  assert.equal(plain.data.acted, false);
  assert.ok(plain.data.degraded.some((d) => /HOVER_NOT_EFFECTIVE/.test(d)));
});

test("an <a> with a click handler and no href is found and clicked by its text", { skip }, async () => {
  const A = await as("onclick");
  await A("agent_browser_visit", { url: h.url("onclick-anchor.html"), snapshot: "none" });
  const loc = await A("browser_locate", { name: "Search for Trade Marks" });
  assert.equal(loc.data.matches[0]?.role, "button");
  await A("agent_browser_act", { name: "Search for Trade Marks", snapshot: "none" });
  const text = await A("browser_observe", { mode: "read" });
  assert.match(text.data.text, /opened trade marks/);
});

test("pressed state, image src and attributes can be read", { skip }, async () => {
  const A = await as("toggles");
  await A("agent_browser_visit", { url: h.url("toggles.html"), snapshot: "none" });
  const r = await A("agent_browser_act", { name: "White", role: "button" });
  assert.equal(node(r.data, "White").state.pressed, true);
  assert.equal(node(r.data, "Black").state.pressed, false);
  const src = await A("browser_eval", { expression: "document.querySelector('main img').src" });
  assert.match(src.data.value, /colour=white/);
  const pressed = await A("browser_eval", { expression: "document.querySelector('[data-c=white]').getAttribute('aria-pressed')" });
  assert.equal(pressed.data.value, "true");
  const ins = await A("browser_inspect", { name: "White", role: "button" });
  assert.equal(ins.data.attributes["aria-pressed"], "true");
  assert.equal(ins.data.topmostAtCentre, true);
});

test("drag works on a range input, a custom slider, a pointer-capture scrubber and a DnD list", { skip }, async () => {
  const A = await as("drag");
  await A("agent_browser_visit", { url: h.url("drag.html"), snapshot: "none" });
  const vol = await A("agent_browser_act", { name: "Volume", action: "drag", to: { name: "Volume" }, toAt: { x: "75%" }, snapshot: "none" });
  assert.ok(!vol.isError, JSON.stringify(vol.data));
  assert.ok(Math.abs(+vol.data.value.after - 75) <= 5, `range value ${vol.data.value?.after}`);

  const thumb = await A("browser_inspect", { name: "Custom slider" });
  const custom = await A("agent_browser_act", {
    name: "Custom slider",
    action: "drag",
    to: { x: thumb.data.box.x + 200, y: thumb.data.box.y + 12 },
    snapshot: "none",
  });
  assert.ok(!custom.isError, JSON.stringify(custom.data));
  assert.ok(+custom.data.valuenow?.after > 40, `custom slider at ${custom.data.valuenow?.after}`);

  const scrub = await A("agent_browser_act", { name: "Timeline", action: "drag", at: { x: "0%" }, to: { name: "Timeline" }, toAt: { x: "50%" }, snapshot: "none" });
  assert.ok(!scrub.isError, JSON.stringify(scrub.data));
  const playhead = await A("browser_eval", { expression: "window.playhead" });
  assert.ok(Math.abs(playhead.data.value - 50) <= 3, `playhead ${playhead.data.value}`);

  const dnd = await A("agent_browser_act", { name: "First", role: "listitem", action: "drag", to: { name: "Third", role: "listitem" }, snapshot: "none" });
  assert.ok(!dnd.isError, JSON.stringify(dnd.data));
  const order = await A("browser_eval", { expression: "[...document.querySelectorAll('#list li')].map((li) => li.textContent).join(',')" });
  assert.equal(order.data.value, "Second,Third,First");
});

test("failed requests and page errors reach the act summary and browser_diagnostics", { skip }, async () => {
  const A = await as("fail");
  const v = await A("agent_browser_visit", { url: h.url("failures.html"), snapshot: "none" });
  assert.match(v.data.diagnostics ?? "", /404/);
  assert.match(v.data.diagnostics ?? "", /console error/);
  const play = await A("agent_browser_act", { name: "Play", snapshot: "none" });
  assert.match(play.data.diagnostics ?? "", /401/);
  const thrown = await A("agent_browser_act", { name: "Throw", snapshot: "none" });
  assert.match(thrown.data.diagnostics ?? "", /console error/);
  const d = await A("browser_diagnostics", {});
  const statuses = d.data.network.map((n) => n.status);
  assert.ok(statuses.includes(401) && statuses.includes(404), JSON.stringify(d.data.network));
  assert.ok(d.data.console.some((c) => /boom from the page/.test(c.text)));
});

test("a page cannot store a credential silently; a first password on a host is flagged", { skip }, async () => {
  const A = await as("cred");
  await A("agent_browser_visit", { url: h.url("credentials.html"), snapshot: "none" });
  await A("agent_browser_act", { name: "User", action: "fill", value: "tester", snapshot: "none" });
  const pw = await A("agent_browser_act", { name: "Password", action: "fill", value: "not-a-real-password", snapshot: "none" });
  assert.match(pw.data.warning ?? "", /first password typed/);
  const sub = await A("agent_browser_act", { name: "Sign in", snapshot: "none" });
  assert.ok(sub.data.credentialStoreBlocked?.length, JSON.stringify(sub.data));
});

test("a link that opens a new tab moves the session with it", { skip }, async () => {
  const A = await as("popup");
  const v = await A("agent_browser_visit", { url: h.url("popup.html"), snapshot: "none" });
  const r = await A("agent_browser_act", { name: "Open form in new tab" });
  assert.ok(r.data.switchedTab, JSON.stringify(r.data));
  assert.equal(r.data.switchedTab.from, v.data.tabId);
  const o = await A("browser_observe", {});
  assert.ok(node(o.data, "Username"));
});

test("stale ref, closed tab and missing element are told apart by code", { skip }, async () => {
  const A = await as("codes");
  await A("agent_browser_visit", { url: h.url("form.html"), snapshot: "none" });
  assert.equal((await A("browser_act", { ref: 1, gen: 1, action: "click" })).data.code, "STALE_SNAPSHOT");
  assert.equal((await A("browser_act", { ref: 9999, action: "click" })).data.code, "REF_NOT_FOUND");
  assert.equal((await A("agent_browser_act", { name: "No such thing anywhere" })).data.code, "NO_MATCH");
  const Z = await as("codes-gone");
  assert.equal((await Z("browser_observe", { tabId: 2147480000 })).data.code, "TAB_GONE");
});

test("status reports the build, and staleBuild once the disk has a newer one", { skip }, async () => {
  const A = await as("status");
  const s1 = await A("agent_browser_status", {});
  assert.equal(s1.data.staleBuild, false);
  assert.ok(s1.data.build.running);
  assert.ok(s1.data.extension.running);
  const original = readFileSync(h.buildInfoFile, "utf8");
  try {
    writeFileSync(h.buildInfoFile, JSON.stringify({ ...JSON.parse(original), srcHash: "rebuilt12345" }));
    const s2 = await A("agent_browser_status", {});
    assert.equal(s2.data.staleBuild, true);
    assert.equal(s2.data.build.restart, "npm run mcp:restart");
    // The first other call of a session carries the notice too.
    const B = await as("status-b");
    const t = await B("browser_tabs", {});
    assert.equal(t.data.staleBuild, true);
  } finally {
    writeFileSync(h.buildInfoFile, original);
  }
  const s3 = await A("agent_browser_status", {});
  assert.equal(s3.data.staleBuild, false);
});

test("a connection that does not identify itself is told it shares a window", { skip }, async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const c = new Client({ name: "anon", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${h.base}/mcp`)));
  try {
    const r = await c.callTool({ name: "agent_browser_visit", arguments: { url: h.url("form.html"), snapshot: "none" } });
    assert.match(JSON.parse(r.content[0].text).warning, /does not identify itself/);
  } finally {
    await c.close();
  }
});

test("a viewport is real: 375px at 3x, media queries included, and kept across navigation", { skip }, async () => {
  const A = await as("viewport");
  const v = await A("agent_browser_visit", { url: h.url("viewport.html"), viewport: { width: 375, height: 700, deviceScaleFactor: 3 }, snapshot: "none" });
  assert.ok(!v.isError, JSON.stringify(v.data));
  assert.equal(v.data.viewport.width, 375, JSON.stringify(v.data.viewport));
  assert.equal(v.data.viewport.deviceScaleFactor, 3);
  const page = await A("browser_eval", { expression: "({ w: innerWidth, dpr: devicePixelRatio, narrow: matchMedia('(max-width: 480px)').matches, wideShown: getComputedStyle(document.querySelector('.wide')).display })" });
  assert.deepEqual(page.data.value, { w: 375, dpr: 3, narrow: true, wideShown: "none" });
  await A("agent_browser_visit", { url: h.url("form.html"), snapshot: "none" });
  const again = await A("browser_eval", { expression: "({ w: innerWidth, dpr: devicePixelRatio })" });
  assert.deepEqual(again.data.value, { w: 375, dpr: 3 });
});

test("mobile mode tells the server and the page it is a phone", { skip }, async () => {
  const A = await as("mobile");
  await A("agent_browser_visit", { url: h.url("ua"), mobile: true, viewport: { width: 390, height: 760, deviceScaleFactor: 3 }, snapshot: "none" });
  const seen = await A("browser_observe", { mode: "read" });
  assert.match(seen.data.text, /Mobile Safari/);
  assert.match(seen.data.text, /mobile=\?1/);
  await A("agent_browser_visit", { url: h.url("viewport.html"), snapshot: "none" });
  const page = await A("browser_eval", { expression: "({ ua: navigator.userAgent.includes('Mobile'), touch: 'ontouchstart' in window, points: navigator.maxTouchPoints, noHover: matchMedia('(hover: none)').matches, coarse: matchMedia('(pointer: coarse)').matches })" });
  assert.deepEqual(page.data.value, { ua: true, touch: true, points: 5, noHover: true, coarse: true });
});

test("a popup opened late is blocked, unless the site is allowed", { skip }, async () => {
  const A = await as("popups");
  // The test profile keeps site settings between runs: start from "block".
  const v = await A("agent_browser_visit", { url: h.url("media.html"), allowPopups: false, snapshot: "none" });
  const parent = v.data.tabId;
  await A("agent_browser_act", { name: "Open later", snapshot: "none" });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal((await A("browser_eval", { expression: "window.results.popup" })).data.value, "blocked");
  const r = await A("agent_browser_act", { name: "Open later", allowPopups: true, snapshot: "none" });
  assert.equal(r.data.popups.setting, "allow");
  await new Promise((r2) => setTimeout(r2, 900));
  const tabs = await A("browser_tabs", {});
  assert.ok(tabs.data.tabs.some((t) => /form\.html/.test(t.url)), JSON.stringify(tabs.data.tabs.map((t) => t.url)));
  // Back on the page that opened it, the page knows it worked.
  await A("browser_tabs", { action: "switch", tabId: parent });
  assert.equal((await A("browser_eval", { expression: "window.results.popup" })).data.value, "opened");
  await A("agent_browser_visit", { url: h.url("media.html"), allowPopups: false, snapshot: "none" });
});

test("sound plays from an agent's click, in a window that is muted", { skip }, async () => {
  const A = await as("sound");
  const v = await A("agent_browser_visit", { url: h.url("media.html"), snapshot: "none" });
  await A("agent_browser_act", { name: "Play sound", snapshot: "none" });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await A("browser_eval", { expression: "window.results.play" })).data.value, "playing");
  const tabs = await A("browser_tabs", {});
  assert.equal(tabs.data.tabs.find((t) => t.tabId === v.data.tabId).muted, true);
  await A("agent_browser_visit", { url: h.url("media.html"), sound: true, snapshot: "none" });
  const after = await A("browser_tabs", {});
  assert.equal(after.data.tabs.find((t) => t.tabId === v.data.tabId).muted, undefined);
});

test("trusted input: the page sees a real gesture, which synthetic clicks cannot give", { skip }, async () => {
  const A = await as("trusted");
  await A("agent_browser_visit", { url: h.url("trusted.html"), snapshot: "none" });
  // The ordinary synthetic click the tool has always made.
  await A("agent_browser_act", { name: "Record gesture", snapshot: "none" });
  assert.deepEqual((await A("browser_eval", { expression: "window.seen" })).data.value, { trusted: false, active: false });
  // The same click, posted by the operating system.
  const r = await A("agent_browser_act", { name: "Record gesture", trusted: true, snapshot: "none" });
  if (r.data.code === "TRUSTED_UNAVAILABLE") return; // helper not granted here: covered by npm run input-helper:status
  assert.ok(!r.isError, JSON.stringify(r.data));
  assert.equal(r.data.trustedInput.from, "macOS Accessibility");
  assert.deepEqual((await A("browser_eval", { expression: "window.seen" })).data.value, { trusted: true, active: true });
  // Fullscreen is gated on a real gesture; only the trusted path gets it.
  await A("agent_browser_act", { name: "Fullscreen", trusted: true, snapshot: "none" });
  await new Promise((res) => setTimeout(res, 600));
  const fs = (await A("browser_eval", { expression: "window.seen" })).data.value;
  assert.equal(fs.trusted, true, JSON.stringify(fs));
  assert.equal(fs.fullscreen, true, JSON.stringify(fs));
});
