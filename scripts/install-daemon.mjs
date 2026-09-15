// Install the MCP server as a launchd agent, so the bridge is always up.
//
// Why this and not stdio: the browser extension holds a persistent WebSocket to
// the bridge on :8787. A stdio MCP server only lives as long as the client that
// spawned it, so between sessions the extension has nothing to connect to and
// retries forever. Worse, the server owns a fixed port and exits if it's taken,
// so two concurrent stdio clients fight and the second one dies.
//
// One long-lived server fixes both: the extension stays connected, and any
// number of clients attach over Streamable HTTP at 127.0.0.1:8788/mcp.
//
//   node scripts/install-daemon.mjs              # install + load
//   node scripts/install-daemon.mjs --uninstall
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = resolve(homedir(), "Library/LaunchAgents");
const logDir = resolve(homedir(), ".agent-chrome");
const plistPath = resolve(agentsDir, "com.agent-browser.mcp-server.plist");
const LABEL = "com.agent-browser.mcp-server";

const tryRun = (args) => {
  try {
    execFileSync("launchctl", args, { stdio: "ignore" });
  } catch {}
};

if (process.argv.includes("--uninstall")) {
  tryRun(["unload", plistPath]);
  try {
    execFileSync("rm", ["-f", plistPath]);
    console.log("removed", plistPath);
  } catch {}
  console.log("MCP server daemon uninstalled.");
  process.exit(0);
}

const entry = resolve(root, "packages/mcp-server/dist/index.js");
if (!existsSync(entry)) {
  console.error(`Build output missing: ${entry}\nRun \`npm run build\` first.`);
  process.exit(1);
}

// Resolve node now: launchd starts agents with a minimal PATH, so the
// interpreter has to be an absolute path in the plist.
const node = execFileSync("which", ["node"], { encoding: "utf8" }).trim();

mkdirSync(agentsDir, { recursive: true });
mkdirSync(logDir, { recursive: true });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${entry}</string>
  </array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${resolve(logDir, "mcp-server.out.log")}</string>
  <key>StandardErrorPath</key><string>${resolve(logDir, "mcp-server.err.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <!-- launchd attaches no stdin; the stdio transport would only log EOF noise. -->
    <key>AB_DISABLE_STDIO_MCP</key><string>1</string>
  </dict>
</dict>
</plist>
`;

writeFileSync(plistPath, plist);
console.log("Wrote", plistPath);

// A server already holding :8787 makes the daemon crash-loop on startup, and
// launchd would retry every ThrottleInterval forever. Take the port first.
tryRun(["unload", plistPath]);
execFileSync("launchctl", ["load", plistPath], { stdio: "inherit" });

console.log(`
MCP server installed + loaded.
  • Bridge        127.0.0.1:8787   (extension connects here)
  • HTTP MCP      127.0.0.1:8788/mcp
  • Logs          ${resolve(logDir, "mcp-server.out.log")}
                  ${resolve(logDir, "mcp-server.err.log")}

Point a client at it:
  claude mcp add --transport http agent-browser http://127.0.0.1:8788/mcp --scope user

Verify:  curl http://127.0.0.1:8788/status
Stop:    npm run mcp:uninstall

After rebuilding (\`npm run build\`), restart it so the new code is live:
  launchctl kickstart -k gui/$(id -u)/${LABEL}
`);
