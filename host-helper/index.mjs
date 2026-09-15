// Tiny host-side daemon with exactly one job: launch the GUI Chrome on the
// host when an agent asks for it. That is the one thing the MCP server can't
// reliably do for itself — spawning a GUI app needs a logged-in Mac session.
//
// Listens on 127.0.0.1:8789. Per-request shared-secret auth. Append-only audit
// log at ~/.agent-chrome/host-helper.log. No remote access (loopback bind).
//
// It reads no credentials and touches no keychain.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = resolve(homedir(), ".agent-chrome");
const secretFile = resolve(stateDir, "host-helper-secret");
const logFile = resolve(stateDir, "host-helper.log");
const PORT = +(process.env.AB_HOST_HELPER_PORT || 8789);

mkdirSync(stateDir, { recursive: true });
if (!existsSync(secretFile)) {
  writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  chmodSync(secretFile, 0o600);
}
const SECRET = readFileSync(secretFile, "utf8").trim();

const log = (event, data = {}) => {
  appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n");
};

const checkSecret = (provided) => {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
};

const send = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/health" && req.method === "GET") {
    return send(res, 200, { ok: true });
  }

  let body = {};
  if (req.method === "POST") {
    try { body = JSON.parse(await readBody(req) || "{}"); } catch { return send(res, 400, { error: "bad json" }); }
  }
  if (!checkSecret(body.secret) && !checkSecret(req.headers["x-ab-secret"])) {
    log("auth_reject", { path: url.pathname, ip: req.socket.remoteAddress });
    return send(res, 401, { error: "auth" });
  }

  try {
    if (url.pathname === "/launch-chrome" && req.method === "POST") {
      const child = spawn(resolve(root, "bin/launch-chrome.sh"), [], {
        cwd: root,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      log("spawn.launch_chrome", { pid: child.pid });
      return send(res, 200, { ok: true, pid: child.pid });
    }
    return send(res, 404, { error: "not found", routes: ["GET /health", "POST /launch-chrome"] });
  } catch (e) {
    log("error", { path: url.pathname, msg: String(e.message || e) });
    return send(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, "127.0.0.1", () => {
  log("listening", { port: PORT });
  console.log(`[host-helper] listening on 127.0.0.1:${PORT}, secret at ${secretFile}`);
});
