// One-time setup of the host helper as a launchd agent. Writes a plist that
// runs host-helper/index.mjs at user login and keeps it alive.
//
//   node host-helper/install.mjs              # install + load
//   node host-helper/install.mjs --uninstall
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
const agentsDir = resolve(homedir(), "Library/LaunchAgents");
const logDir = resolve(homedir(), ".agent-chrome");
mkdirSync(agentsDir, { recursive: true });
mkdirSync(logDir, { recursive: true });

const plistPath = resolve(agentsDir, "com.agent-browser.host-helper.plist");

const tryRun = (args) => {
  try { execFileSync("launchctl", args, { stdio: "ignore" }); } catch {}
};

if (process.argv.includes("--uninstall")) {
  tryRun(["unload", plistPath]);
  try { execFileSync("rm", ["-f", plistPath]); console.log("removed", plistPath); } catch {}
  console.log("Host helper uninstalled.");
  process.exit(0);
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agent-browser.host-helper</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${resolve(root, "host-helper/index.mjs")}</string>
  </array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${resolve(logDir, "host-helper.out.log")}</string>
  <key>StandardErrorPath</key><string>${resolve(logDir, "host-helper.err.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;

writeFileSync(plistPath, plist);
console.log("Wrote", plistPath);

tryRun(["unload", plistPath]);
execFileSync("launchctl", ["load", plistPath], { stdio: "inherit" });

console.log(`
Host helper installed + loaded.
  • Listens on 127.0.0.1:8789 (loopback only)
  • Shared secret: ${resolve(logDir, "host-helper-secret")}  (chmod 0600)
  • Log: ${resolve(logDir, "host-helper.log")}

Single job: spawn the GUI agent Chrome on request, so agent_browser_visit
works even when the browser isn't already open. Holds no credentials.

To verify:  curl http://127.0.0.1:8789/health
To stop:    launchctl unload ${plistPath}
`);
