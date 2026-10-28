import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./config.js";

/**
 * A citable trail: one record per visit or screenshot under
 * <stateDir>/sessions/<session>/, with the image beside it. Inline data URLs
 * vanish with the conversation; a file path can go in a report.
 */

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 60) || "session";

let seq = 0;

export function recordEvidence(
  cfg: AppConfig,
  session: string,
  entry: { tool: string; url?: string; title?: string; [k: string]: unknown },
  image?: string,
): { file: string; screenshot?: string } | undefined {
  if (!cfg.evidence.enabled) return undefined;
  try {
    const dir = resolve(cfg.stateDir, "sessions", safe(session));
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const base = `${ts.replace(/[:.]/g, "-")}-${String(++seq).padStart(4, "0")}-${entry.tool}`;
    let screenshot: string | undefined;
    const m = image?.match(/^data:image\/(png|jpeg);base64,(.+)$/);
    if (m) {
      screenshot = resolve(dir, `${base}.${m[1] === "jpeg" ? "jpg" : "png"}`);
      writeFileSync(screenshot, Buffer.from(m[2], "base64"));
    }
    const file = resolve(dir, `${base}.json`);
    writeFileSync(file, JSON.stringify({ ts, session, ...entry, ...(screenshot ? { screenshot } : {}) }, null, 2) + "\n");
    return { file, ...(screenshot ? { screenshot } : {}) };
  } catch {
    return undefined; // evidence is a record, never a reason for a call to fail
  }
}

/** Remove session directories untouched for longer than retainDays. */
export function pruneEvidence(cfg: AppConfig, now = Date.now()): number {
  const root = resolve(cfg.stateDir, "sessions");
  let removed = 0;
  try {
    for (const d of readdirSync(root)) {
      const p = resolve(root, d);
      if (now - statSync(p).mtimeMs > cfg.evidence.retainDays * 86_400_000) {
        rmSync(p, { recursive: true, force: true });
        removed++;
      }
    }
  } catch {}
  return removed;
}
