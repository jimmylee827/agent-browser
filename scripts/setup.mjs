#!/usr/bin/env node
// One-command setup, and a doctor that says what is wrong.
//
//   npm run setup              install, build, start everything, verify
//   npm run setup -- --check   check only, change nothing (exit 1 if not ready)
//   npm run setup -- --with-input    also set up real OS input (macOS)
//   npm run setup -- --no-daemon     do not install the login item
//   npm run setup -- --fresh         reinstall dependencies first
//
// Every step is safe to repeat: what is already running and current is left
// alone. The only step a person must do by hand is loading the extension once
// into Chrome — no Chrome release allows a script to do it — and this script
// opens the right page and waits for it.
import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");
const WITH_INPUT = args.has("--with-input");
const NO_DAEMON = args.has("--no-daemon");
const FRESH = args.has("--fresh");

const cfg = JSON.parse(readFileSync(resolve(root, "config/default.json"), "utf8"));
const home = (p) => (p.startsWith("~") ? p.replace(/^~/, homedir()) : p);
const STATE = home(cfg.stateDir);
const PROFILE = home(cfg.profileDir);
const EXTENSION = resolve(root, "packages/extension");
const BASE = `http://${cfg.bridge.host}:${cfg.bridge.controlPort}`;
const LABEL = "com.agent-browser.mcp-server";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, status, detail = "") => {
  results.push({ name, status, detail });
  const mark = status === "ok" ? "\x1b[32m✓\x1b[0m" : status === "warn" ? "\x1b[33m!\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ""}`);
};
const step = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
/** Is this an executable on PATH? */
const has = (cmd) =>
  (process.env.PATH || "").split(":").some((dir) => {
    try {
      accessSync(resolve(dir || ".", cmd), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: root, stdio: "inherit", ...opts });
const quiet = (cmd, argv) => {
  try {
    return execFileSync(cmd, argv, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

async function status() {
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(1500) });
    return await r.json();
  } catch {
    return null;
  }
}

/** The agent profile's Chrome, running now? */
const chromeRunning = () => {
  try {
    execFileSync("pgrep", ["-f", `user-data-dir=${PROFILE}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

function chromeBinary() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((p) => existsSync(p));
}

// ---------------------------------------------------------------- preflight

step("Checking this machine");
const mac = process.platform === "darwin";
const nodeMajor = Number(process.versions.node.split(".")[0]);
nodeMajor >= 20
  ? record("Node", "ok", process.version)
  : record("Node", "fail", `${process.version} is too old: install Node 20 or newer (https://nodejs.org)`);
const chrome = chromeBinary();
chrome
  ? record("Chrome", "ok", chrome)
  : record("Chrome", "fail", "Google Chrome or Chromium not found: install it, or set the path in bin/launch-chrome.sh");
if (!mac)
  record("Platform", "warn", `${process.platform}: the login-item and real-input features are macOS-only; the server and browser work`);
else if (WITH_INPUT && !has("swiftc")) record("Swift", "warn", "swiftc not found: install Xcode Command Line Tools for real input");
else if (WITH_INPUT) record("Swift", "ok");

if (results.some((r) => r.status === "fail")) {
  if (!CHECK) {
    console.error("\nFix the items marked ✗ above, then run `npm run setup` again.");
    process.exit(1);
  }
}

// -------------------------------------------------------------- dependencies

if (!CHECK) {
  step("Dependencies");
  if (FRESH || !existsSync(resolve(root, "node_modules"))) {
    run("npm", ["install", "--no-audit", "--no-fund"]);
    record("npm install", "ok");
  } else record("npm install", "ok", "already installed (use --fresh to reinstall)");

  step("Build");
  run("npm", ["run", "build", "--silent"]);
  const info = JSON.parse(readFileSync(resolve(root, "packages/mcp-server/dist/build-info.json"), "utf8"));
  record("Build", "ok", `${info.commit}${info.dirty ? "+dirty" : ""}`);
} else if (!existsSync(resolve(root, "packages/mcp-server/dist/index.js"))) record("Build", "fail", "run npm run setup");

// ------------------------------------------------------- extension secret

if (!CHECK) {
  step("Extension secret");
  run("node", [resolve(root, "scripts/sync-ext-secret.mjs")]);
  record("Bridge secret", "ok", `${STATE}/bridge-secret (written into the extension)`);
}

// ------------------------------------------------------------------ daemon

if (!CHECK && mac) {
  step("Server");
  const plist = resolve(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
  if (!NO_DAEMON && !existsSync(plist)) {
    run("node", [resolve(root, "scripts/install-daemon.mjs")], { stdio: "ignore" });
    record("Login item", "ok", `${LABEL} (starts at login, restarts on crash)`);
  } else record("Login item", existsSync(plist) ? "ok" : "warn", existsSync(plist) ? LABEL : "skipped (--no-daemon)");
  const up = await status();
  if (up) record("Server", "ok", BASE);
  else {
    // The launcher starts the daemon on demand; nudge it once here.
    spawn(process.execPath, [resolve(root, "packages/mcp-server/dist/index.js")], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AB_DISABLE_STDIO_MCP: "1" },
    }).unref();
    for (let i = 0; i < 40 && !(await status()); i++) await sleep(250);
    (await status()) ? record("Server", "ok", BASE) : record("Server", "fail", `did not answer on ${BASE}; see ${STATE}/mcp-server.err.log`);
  }
}

// ----------------------------------------------------------------- browser

let connected = false;
if (!CHECK) {
  step("Browser");
  if (!chromeRunning()) {
    spawn("bash", [resolve(root, "bin/launch-chrome.sh")], { detached: true, stdio: "ignore", cwd: root }).unref();
    record("Chrome", "ok", "launched on the agent profile");
  } else record("Chrome", "ok", "already running on the agent profile");
  // The extension connecting is what proves the whole chain works.
  for (let i = 0; i < 60 && !connected; i++) {
    await sleep(500);
    connected = !!(await status())?.bridgeConnected;
  }
}

// ------------------------------------------------------------- verification

const final = await status();
connected = connected || !!final?.bridgeConnected;
const ext = final?.extension;
const versionOnDisk = JSON.parse(readFileSync(resolve(EXTENSION, "manifest.json"), "utf8")).version;

if (!CHECK) step("Result");
if (final?.build) {
  final.build.staleBuild
    ? record("Server build", "warn", `running ${final.build.running} but ${final.build.onDisk} is on disk: ${final.build.restart}`)
    : record("Server build", "ok", final.build.running);
}
if (connected) {
  const v = ext?.running && ext.running !== "unknown (older than 0.0.5)" ? ext.running : null;
  if (v === versionOnDisk) record("Extension", "ok", `v${v} connected`);
  else if (v) record("Extension", "warn", `v${v} running, v${versionOnDisk} installed: Reload it once at chrome://extensions`);
  else record("Extension", "warn", `connected but its version is unknown: Reload it at chrome://extensions`);
} else {
  record("Extension", CHECK ? "fail" : "warn", "not connected");
}

// ------------------------------------------------------------------ input

if (WITH_INPUT && mac) {
  step("Real input (macOS Accessibility)");
  const st = await fetch("http://127.0.0.1:8790/", {
    method: "POST",
    body: JSON.stringify({ secret: readFileSync(resolve(STATE, "input-helper-secret"), "utf8").trim(), cmd: "status" }),
    signal: AbortSignal.timeout(1500),
  })
    .then((r) => r.json())
    .catch(() => null);
  if (st?.trusted) record("Input helper", "ok", "running and allowed");
  else {
    if (!CHECK) run("node", [resolve(root, "native/input-helper/install.mjs")]);
    record("Input helper", "warn", "switch it on once: System Settings → Privacy & Security → Accessibility → Agent Browser Input");
  }
}

// --------------------------------------------------------- MCP registration

if (!CHECK && has("claude")) {
  step("MCP client");
  const launcher = resolve(root, "packages/mcp-server/dist/launcher.js");
  const listed = quiet("claude", ["mcp", "get", "agent-browser"]);
  if (listed) record("Claude Code", "ok", "agent-browser already registered");
  else {
    try {
      run("claude", ["mcp", "add", "agent-browser", "--scope", "user", "--", process.execPath, launcher], { stdio: "ignore" });
      record("Claude Code", "ok", "registered the launcher (starts the server on demand)");
    } catch {
      record("Claude Code", "warn", `register it yourself: claude mcp add agent-browser --scope user -- ${process.execPath} ${launcher}`);
    }
  }
}

// ------------------------------------------------------------------ summary

if (!connected) {
  console.log(`
\x1b[1mOne step is a person's:\x1b[0m Chrome allows no script to load an extension.

  1. In the Chrome window just opened: chrome://extensions
  2. Switch on Developer mode (top right)
  3. Load unpacked → ${EXTENSION}

Then run \`npm run setup\` again (it will say Extension: connected), or
\`npm run doctor\` to check without changing anything.
`);
  if (!CHECK) {
    // Open the page for them, as a tab in the agent Chrome.
    if (chrome && mac) spawn(chrome, [`--user-data-dir=${PROFILE}`, "chrome://extensions"], { detached: true, stdio: "ignore" }).unref();
  }
}

const failures = results.filter((r) => r.status === "fail");
const ready = connected && !final?.build?.staleBuild && failures.length === 0;
console.log(
  `\n${ready ? "\x1b[32mReady.\x1b[0m" : "\x1b[33mNot ready yet.\x1b[0m"} ` +
    `${ready ? "Start a new Claude Code session, or run /mcp to reconnect, and the agent-browser tools are there." : "See above."}\n`,
);
if (!ready && failures.length) console.log(`\nNot ready: ${failures.map((f) => f.name).join(", ")}. See above.`);
process.exit(ready ? 0 : 1);
