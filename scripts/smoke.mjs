// End-to-end smoke against the PERSISTENT server's control plane.
// Prereq: `npm run mcp` running in another terminal + stealth Chrome launched
// with the extension loaded + any ordinary tab (e.g. https://example.com) active.
const BASE = "http://127.0.0.1:8788";

const get = async (p) => {
  const r = await fetch(BASE + p);
  return { code: r.status, body: await r.json().catch(() => ({})) };
};

let up = false;
try {
  await fetch(BASE + "/status");
  up = true;
} catch {
  console.log(
    "Control plane unreachable on :8788.\n" +
      "Start the persistent server first:  npm run mcp   (leave it running)",
  );
  process.exit(1);
}

console.log("control plane reachable ✓ — waiting for stealth Chrome / extension…");
let connected = false;
for (let i = 0; i < 25; i++) {
  const s = await get("/status");
  if (s.body.bridgeConnected) {
    connected = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!connected) {
  console.log(
    "\nBridge NOT connected. Check the extension service-worker console for\n" +
      "`[agent-bridge] connected`. Ensure `npm run launch` is running.",
  );
  process.exit(0);
}
console.log("bridge connected ✓\n");

const ping = await get("/ping");
console.log(`=== GET /ping (${ping.code}) ===`);
console.log(JSON.stringify(ping.body, null, 2), "\n");

const tabUrl = ping.body?.tab?.url ?? "";
if (/^(chrome|chrome-extension|edge|about):/.test(tabUrl)) {
  console.log(
    `ACTIVE TAB IS '${tabUrl}'.\n` +
      "Chrome blocks content scripts on internal pages. Focus a normal allowlisted\n" +
      "tab (e.g. https://example.com) in the agent window, then re-run `npm run smoke`.",
  );
  process.exit(1);
}

let okCount = 0;
for (const path of ["/observe?mode=semantic", "/locate?role=button"]) {
  const r = await get(path);
  console.log(`=== GET ${path} (${r.code}) ===`);
  console.log(JSON.stringify(r.body, null, 2).slice(0, 1800), "\n");
  if (r.code === 200 && !r.body.error) okCount++;
}

if (okCount === 2 && !ping.body.engine?.error) {
  console.log("Smoke PASSED ✓ — perception engine validated against a real page.");
  process.exit(0);
}
console.log("Smoke INCOMPLETE — engine calls errored above (see messages).");
process.exit(1);
