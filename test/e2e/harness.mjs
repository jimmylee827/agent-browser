// End-to-end harness: a second, isolated agent-browser — its own server on
// free ports, the real Google Chrome on a profile of its own, its own copy of
// the extension, and two local fixture origins. Nothing touches the user's
// agent browser, its profile, server or ports, and nothing goes to the network.
//
// Real Chrome, as in production: the tests speak MCP to the server and the
// server reaches Chrome only through the extension — never CDP.
//
// Google Chrome no longer loads an extension from the command line (it
// ignores --load-extension since version 137), so the test profile is set up
// the way the agent profile is: a person loads the unpacked extension once
// (`npm run test:e2e:setup`). It lives at a fixed path, refreshed before each
// run with that run's secret and port, so the one load keeps working.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = resolve(root, "test/fixtures");
const CHROME = process.env.AB_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const TEST_HOME = process.env.AB_TEST_HOME || join(homedir(), ".agent-chrome-test");
const PROFILE = join(TEST_HOME, "profile");
export const EXTENSION = join(TEST_HOME, "extension");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const chromeAvailable = () => existsSync(CHROME) && existsSync(resolve(root, "packages/mcp-server/dist/index.js"));

/** Has a person loaded the test extension into the test profile yet? */
export function extensionInstalled() {
  for (const f of ["Secure Preferences", "Preferences"]) {
    try {
      if (readFileSync(join(PROFILE, "Default", f), "utf8").includes(JSON.stringify(EXTENSION).slice(1, -1))) return true;
    } catch {}
  }
  return false;
}

export const SETUP_STEPS = [
  "One-time setup of the test browser (a person has to do this; Chrome allows no other way):",
  "  1. In the Chrome window that opened on chrome://extensions, switch on Developer mode (top right).",
  "  2. Click Load unpacked and choose:",
  `       ${EXTENSION}`,
  "  (Press Cmd+Shift+. in the file picker to show the hidden folder.)",
  "This is a separate profile, not your agent browser. It is kept for later runs.",
].join("\n");

const freePort = () =>
  new Promise((ok, fail) => {
    const s = netServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
    s.on("error", fail);
  });

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

// Fixture server. /status/<code>[.ext] answers with that status (a broken
// video, a missing script); everything else is a file from test/fixtures,
// with {{OTHER}} replaced by the other origin, so a page can embed a
// cross-origin frame.
// A short, quiet tone for the sound tests.
const TONE = (() => {
  const rate = 22050, n = 4000, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * 1500), 44 + i * 2);
  return b;
})();
const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function fixtureServer(port, other) {
  const srv = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/tone.wav") {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      return res.end(TONE);
    }
    // What the browser said it is, as the server saw it.
    if (url.pathname === "/ua") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><title>UA</title><pre id="ua">${escapeHtml(req.headers["user-agent"])} | mobile=${escapeHtml(req.headers["sec-ch-ua-mobile"] ?? "")}</pre>`);
    }
    const st = url.pathname.match(/^\/status\/(\d{3})/);
    if (st) {
      res.writeHead(+st[1], { "Content-Type": "text/plain" });
      return res.end(`status ${st[1]}`);
    }
    const file = resolve(fixtures, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(fixtures) || !existsSync(file)) {
      res.writeHead(404);
      return res.end("not found");
    }
    let body = readFileSync(file);
    if (extname(file) === ".html") body = Buffer.from(body.toString("utf8").replaceAll("{{OTHER}}", `http://127.0.0.1:${other}`));
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  });
  return new Promise((ok) => srv.listen(port, "127.0.0.1", () => ok(srv)));
}

/**
 * Start the isolated instance. `waitMs` is how long to wait for the
 * extension to connect — long in setup, while a person loads it.
 */
export async function startHarness({ log = false, waitMs = 45_000, setup = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "ab-e2e-"));
  const state = join(tmp, "state");
  const profile = PROFILE;
  const ext = EXTENSION;
  mkdirSync(state, { recursive: true });
  mkdirSync(profile, { recursive: true });
  const [bridgePort, controlPort, webA, webB] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);

  // The extension copy carries this instance's secret and port.
  const secret = randomBytes(32).toString("hex");
  writeFileSync(join(state, "bridge-secret"), secret, { mode: 0o600 });
  // Same path every run, fresh files: the one manual load stays valid, and
  // Chrome reads an unpacked extension from disk when it starts.
  rmSync(ext, { recursive: true, force: true });
  cpSync(resolve(root, "packages/extension"), ext, { recursive: true });
  writeFileSync(join(ext, "src/generated-secret.js"), `export const BRIDGE_SECRET = ${JSON.stringify(secret)};\nexport const BRIDGE_PORT = ${bridgePort};\n`);

  const servers = [await fixtureServer(webA, webB), await fixtureServer(webB, webA)];
  // The server runs from a copy of the build, so a test can change what is
  // "on disk" (the build stamp) without touching the real one.
  const server = join(tmp, "server");
  cpSync(resolve(root, "packages/mcp-server/dist"), join(server, "dist"), { recursive: true });
  symlinkSync(resolve(root, "node_modules"), join(server, "node_modules"));
  const env = {
    ...process.env,
    AB_STATE_DIR: state,
    AB_PROFILE_DIR: profile,
    AB_BRIDGE_PORT: String(bridgePort),
    AB_CONTROL_PORT: String(controlPort),
    AB_EXTENSION_DIR: ext,
    AB_CONFIG: resolve(root, "config/default.json"),
    // The person's own override, kept out of the tests.
    AB_LOCAL_CONFIG: join(tmp, "local.json"),
    AB_DISABLE_STDIO_MCP: "1",
  };
  const out = log ? "inherit" : "ignore";
  const daemon = spawn(process.execPath, [join(server, "dist/index.js")], { env, stdio: ["ignore", out, out] });
  // The flags bin/launch-chrome.sh uses for the agent browser; no automation
  // switches. A Chrome already open on the test profile (a run that did not
  // clean up) is closed first, or it would keep the old extension secret.
  spawn("pkill", ["-f", `user-data-dir=${profile}`]).on("exit", () => {});
  await sleep(1000);
  const chrome = spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      "--disable-features=Translate",
      "--disable-backgrounding-occluded-windows",
      "--autoplay-policy=no-user-gesture-required",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      setup || !extensionInstalled() ? "chrome://extensions" : "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  if (!setup && !extensionInstalled()) process.stderr.write(`\n${SETUP_STEPS}\n\nOr run \`npm run test:e2e:setup\` first.\n\n`);

  const base = `http://127.0.0.1:${controlPort}`;
  const t0 = Date.now();
  let connected = false;
  while (Date.now() - t0 < waitMs) {
    try {
      const s = await (await fetch(`${base}/status`)).json();
      if (s.bridgeConnected) {
        connected = true;
        break;
      }
    } catch {}
    await sleep(300);
  }

  const clients = [];
  async function client(id) {
    const c = new Client({ name: `e2e-${id}`, version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { "x-ab-client": id } } }));
    clients.push(c);
    /** Call a tool; returns { data, images, isError }. */
    return async (name, args = {}) => {
      const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
      const text = r.content.find((x) => x.type === "text")?.text ?? "{}";
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      return { data, images: r.content.filter((x) => x.type === "image"), isError: !!r.isError };
    };
  }

  async function stop() {
    for (const c of clients) await c.close().catch(() => {});
    chrome.kill("SIGTERM");
    daemon.kill("SIGTERM");
    for (const s of servers) s.close();
    await sleep(800);
    rmSync(tmp, { recursive: true, force: true });
  }

  return {
    connected,
    client,
    stop,
    url: (path, which = "A") => `http://127.0.0.1:${which === "A" ? webA : webB}/${path}`,
    state,
    base,
    /** The build stamp the server would find on disk. */
    buildInfoFile: join(server, "dist/build-info.json"),
  };
}
