// Stamp the build: which commit and which source produced dist/. The server
// reads this at startup and again on every status call, so a daemon still
// running code that has since been rebuilt can say so instead of serving it
// silently (an old daemon once answered with an error string deleted eleven
// days earlier). Run as the mcp-server package's postbuild.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "packages/mcp-server/src");
const out = resolve(root, "packages/mcp-server/dist/build-info.json");

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith(".ts") ? [join(dir, d.name)] : [],
  );

const h = createHash("sha256");
for (const f of files(src).sort()) h.update(f.slice(src.length)).update(readFileSync(f));

const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

const info = {
  commit: git("rev-parse", "--short", "HEAD") || "unknown",
  dirty: git("status", "--porcelain", "--", "packages/mcp-server/src") !== "",
  srcHash: h.digest("hex").slice(0, 12),
  builtAt: new Date().toISOString(),
};
writeFileSync(out, JSON.stringify(info, null, 2) + "\n");
console.log(`build-info: ${info.commit}${info.dirty ? "+dirty" : ""} src ${info.srcHash}`);
