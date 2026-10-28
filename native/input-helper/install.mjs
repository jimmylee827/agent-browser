// Build and install Agent Browser Input — real mouse and keyboard input for the
// agent browser through macOS Accessibility — as a launchd agent.
//
//   node native/input-helper/install.mjs              # build if changed, install, load at login
//   node native/input-helper/install.mjs --build      # build if changed, nothing else
//   node native/input-helper/install.mjs --run        # build if changed, start it now (not at login)
//   node native/input-helper/install.mjs --status     # is it running, is it allowed?
//   node native/input-helper/install.mjs --uninstall
//
// It is an app bundle with its own LaunchAgent so that the Accessibility grant
// belongs to it alone: started by the browser server, macOS would ask to trust
// `node` itself. It is signed locally, and macOS ties the grant to that
// signature, so it is rebuilt only when its source changes — a rebuild means
// switching it on again in System Settings.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const state = resolve(homedir(), ".agent-chrome");
const APP = resolve(state, "AgentBrowserInput.app");
const BIN = resolve(APP, "Contents/MacOS/AgentBrowserInput");
const LABEL = "com.agent-browser.input";
const PLIST = resolve(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const SECRET = resolve(state, "input-helper-secret");
const PORT = 8790;
const domain = `gui/${process.getuid()}`;

const launchctl = (...args) => {
  try {
    execFileSync("launchctl", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

async function status() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`, {
      method: "POST",
      body: JSON.stringify({ secret: readFileSync(SECRET, "utf8").trim(), cmd: "status" }),
      signal: AbortSignal.timeout(1500),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: `not reachable: ${e.message}` };
  }
}

if (process.argv.includes("--status")) {
  const s = await status();
  console.log(JSON.stringify(s));
  if (s.ok && !s.trusted)
    console.log("Not allowed yet: System Settings → Privacy & Security → Accessibility → switch on “Agent Browser Input”.");
  process.exit(s.ok && s.trusted ? 0 : 1);
}

if (process.argv.includes("--uninstall")) {
  launchctl("bootout", `${domain}/${LABEL}`);
  rmSync(PLIST, { force: true });
  rmSync(APP, { recursive: true, force: true });
  console.log("Agent Browser Input uninstalled. Remove it from System Settings → Privacy & Security → Accessibility too.");
  process.exit(0);
}

if (process.platform !== "darwin") {
  console.error("Agent Browser Input is macOS only.");
  process.exit(1);
}
mkdirSync(state, { recursive: true });

// Build only when the source changed: a new build needs a new grant.
const source = readFileSync(resolve(here, "main.swift"));
const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
const stamp = resolve(APP, "Contents/Resources/source-hash");
const built = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : "";
if (built !== hash || process.argv.includes("--rebuild")) {
  console.log(built ? "Source changed: rebuilding (you will need to switch it on again in Accessibility)." : "Building Agent Browser Input…");
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(dirname(BIN), { recursive: true });
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(
    resolve(APP, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${LABEL}</string>
  <key>CFBundleName</key><string>Agent Browser Input</string>
  <key>CFBundleDisplayName</key><string>Agent Browser Input</string>
  <key>CFBundleExecutable</key><string>AgentBrowserInput</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>${hash}</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`,
  );
  execFileSync("swiftc", ["-O", "-o", BIN, resolve(here, "main.swift")], { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--sign", "-", "--identifier", LABEL, APP], { stdio: "inherit" });
  writeFileSync(stamp, hash + "\n");
} else {
  console.log("Agent Browser Input is up to date (no rebuild, so its Accessibility permission stays).");
}

if (!existsSync(SECRET)) {
  writeFileSync(SECRET, randomBytes(32).toString("hex"), { mode: 0o600 });
  chmodSync(SECRET, 0o600);
}
if (process.argv.includes("--build")) process.exit(0);

// Started through LaunchServices, it is its own process for macOS — so the
// Accessibility grant is still its own — but nothing starts it at login.
if (process.argv.includes("--run")) {
  if ((await status()).ok) console.log("Already running.");
  else execFileSync("open", ["-g", "-a", APP, "--args", "serve"]);
  await new Promise((r) => setTimeout(r, 1500));
  const s = await status();
  console.log(JSON.stringify(s));
  if (s.ok && !s.trusted)
    console.log("One step for a person: System Settings → Privacy & Security → Accessibility → switch on “Agent Browser Input”.");
  process.exit(s.ok ? 0 : 1);
}

writeFileSync(
  PLIST,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${BIN}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>${resolve(state, "input-helper.log")}</string>
  <key>EnvironmentVariables</key>
  <dict><key>AB_INPUT_PORT</key><string>${PORT}</string></dict>
</dict>
</plist>
`,
);
launchctl("bootout", `${domain}/${LABEL}`);
if (!launchctl("bootstrap", domain, PLIST)) {
  console.error(`launchctl bootstrap failed; see ${resolve(state, "input-helper.log")}`);
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 1200));
const s = await status();
console.log(JSON.stringify(s));
if (s.ok && s.trusted) console.log("Agent Browser Input is running and allowed.");
else
  console.log(`
One step for a person (macOS allows no other way):
  System Settings → Privacy & Security → Accessibility → switch on “Agent Browser Input”.
(macOS may already have shown a dialog for it.) Then check: npm run input-helper:status
`);
