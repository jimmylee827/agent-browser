import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Which build is running, and which is on disk. Written by
 * scripts/write-build-info.mjs after every `npm run build`.
 */
export interface BuildInfo {
  commit: string;
  dirty: boolean;
  srcHash: string;
  builtAt: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const INFO = resolve(here, "build-info.json");
const SRC = resolve(here, "../src");

export function readBuildInfo(file = INFO): BuildInfo | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as BuildInfo;
  } catch {
    return null;
  }
}

/** Read once, when this process loaded its code. */
export const RUNNING = readBuildInfo();

export const buildId = (b: BuildInfo | null) => (b ? `${b.commit}${b.dirty ? "+dirty" : ""}:${b.srcHash}` : "unknown");

export const RESTART = "npm run mcp:restart";

function newestSourceMtime(dir = SRC): number {
  let t = 0;
  try {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      t = Math.max(t, d.isDirectory() ? newestSourceMtime(p) : d.name.endsWith(".ts") ? statSync(p).mtimeMs : 0);
    }
  } catch {}
  return t;
}

export interface BuildStatus {
  running: string;
  onDisk: string;
  builtAt?: string;
  staleBuild: boolean;
  sourceNewerThanBuild: boolean;
  warning?: string;
  restart?: string;
}

/**
 * Compare the code this process runs with the build on disk now. `running`
 * and `onDisk` are passed in so the comparison can be tested without files.
 */
export function compareBuilds(running: BuildInfo | null, onDisk: BuildInfo | null, srcMtime = newestSourceMtime()): BuildStatus {
  const staleBuild = !!running && !!onDisk && buildId(running) !== buildId(onDisk);
  const sourceNewerThanBuild = !!onDisk && srcMtime > Date.parse(onDisk.builtAt) + 1000;
  const warnings = [
    staleBuild ? `the browser server is running an older build (${buildId(running)}) than the one on disk (${buildId(onDisk)}); restart it` : "",
    sourceNewerThanBuild ? "the source has changed since the last build: run `npm run build` in the agent-browser repo" : "",
  ].filter(Boolean);
  return {
    running: buildId(running),
    onDisk: buildId(onDisk),
    ...(running ? { builtAt: running.builtAt } : {}),
    staleBuild,
    sourceNewerThanBuild,
    ...(warnings.length ? { warning: warnings.join("; ") } : {}),
    ...(staleBuild ? { restart: RESTART } : {}),
  };
}

export const buildStatus = () => compareBuilds(RUNNING, readBuildInfo());
