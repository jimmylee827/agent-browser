// SAFE action-engine validation against the live page. Non-destructive only:
// toggles the sidebar, types into the composer then CLEARS it. Never submits,
// never presses Enter. Prereq: npm run mcp + agent Chrome on any page.
const BASE = "http://127.0.0.1:8788";
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, body) =>
  (await fetch(BASE + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })).json();
const pass = [];
const fail = [];
const check = (name, ok, detail) => (ok ? pass : fail).push(`${name}${detail ? " — " + detail : ""}`);

const s = await get("/status");
if (!s.bridgeConnected) {
  console.log("bridge not connected — start npm run mcp + agent Chrome on any page");
  process.exit(1);
}

// --- Test 1: toggle sidebar (safe UI toggle) + effect verification ---
let snap = await get("/observe?mode=semantic");
const sidebar = snap.tree.find(
  (n) => n.role === "button" && /sidebar/i.test(n.name),
);
if (!sidebar) {
  check("locate sidebar button", false, "not found in snapshot");
} else {
  const r = await post("/act", {
    ref: sidebar.ref,
    gen: snap.snapshotGeneration,
    action: "click",
  });
  check("sidebar click acted", r.acted === true, JSON.stringify(r.signals || r.error));
  check("sidebar click had effect", r.changed === true, `changed=${r.changed}`);
}

// --- Test 2: type into composer textbox, then CLEAR (never submit) ---
const loc = await get("/locate?role=textbox");
const tb = loc.matches?.[0];
if (!tb) {
  check("locate composer textbox", false, "no role=textbox match");
} else {
  const typed = await post("/act", {
    ref: tb.ref,
    gen: loc.snapshotGeneration,
    action: "type",
    value: "agent-browser self-test (NOT sent)",
  });
  check("composer type acted", typed.acted === true, JSON.stringify(typed.signals || typed.error));
  // restore: clear what we typed so nothing is left in the box
  const loc2 = await get("/locate?role=textbox");
  const tb2 = loc2.matches?.[0];
  const cleared = await post("/act", {
    ref: tb2?.ref ?? tb.ref,
    gen: loc2.snapshotGeneration,
    action: "clear",
  });
  check("composer cleared (restored)", cleared.acted === true, JSON.stringify(cleared.error || "ok"));
}

// --- Test 3: stale-ref handling (reliability contract) ---
const old = await get("/observe?mode=semantic");
const oldRef = old.tree.find((n) => n.interactive)?.ref ?? 1;
await get("/observe?mode=semantic"); // new generation invalidates old gen
const stale = await post("/act", {
  ref: oldRef,
  gen: old.snapshotGeneration,
  action: "hover",
});
check(
  "stale ref rejected with typed error",
  /STALE_SNAPSHOT|REF_NOT_FOUND/.test(JSON.stringify(stale)),
  JSON.stringify(stale.error || stale),
);

console.log("\nPASS:");
pass.forEach((p) => console.log("  ✓ " + p));
if (fail.length) {
  console.log("FAIL:");
  fail.forEach((f) => console.log("  ✗ " + f));
}
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
