import { mkdirSync, readdirSync, rmSync, rmdirSync, lstatSync, writeFileSync } from "node:fs";
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

/** A file an agent asked to keep (an export), beside the session's other evidence. */
export function writeEvidenceFile(cfg: AppConfig, session: string, tool: string, ext: string, content: string): string | undefined {
  try {
    const dir = resolve(cfg.stateDir, "sessions", safe(session));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const base = `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(++seq).padStart(4, "0")}-${tool}`;
    const file = resolve(dir, `${base}.${ext}`);
    // Recorded traffic is private: other users of this Mac may not read it.
    writeFileSync(file, content, { mode: 0o600 });
    return file;
  } catch {
    return undefined;
  }
}

/** Expire complete records by their own age, even in an active directory.
 * No JSON path is trusted and no symlink is traversed. A fresh member protects
 * its whole pair, including the interval between writing image and JSON. */
export function pruneEvidence(cfg: AppConfig, now = Date.now()): number {
  const root = resolve(cfg.stateDir, "sessions");
  const cutoff = now - cfg.evidence.retainDays * 86_400_000;
  let removed = 0;
  if (!Number.isFinite(cutoff) || cfg.evidence.retainDays < 0) return 0;
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue;
      const dir = resolve(root, d.name);
      const groups = new Map<string, { path: string; time: number }[]>();
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (!f.isFile() || !/\.(json|png|jpe?g|har|ndjson)$/i.test(f.name)) continue;
        const path = resolve(dir, f.name);
        const st = lstatSync(path);
        if (!st.isFile() || st.isSymbolicLink()) continue;
        const base = f.name.replace(/\.(json|png|jpe?g)$/i, "");
        const group = groups.get(base) ?? [];
        group.push({ path, time: st.mtimeMs });
        groups.set(base, group);
      }
      for (const files of groups.values()) {
        if (files.every((f) => f.time < cutoff)) {
          for (const f of files) { rmSync(f.path); removed++; }
        }
      }
      // Non-recursive removal fails safely if a writer adds a fresh record.
      if (!readdirSync(dir).length) rmdirSync(dir);
    }
  } catch { /* pruning never interrupts browser operations */ }
  return removed;
}
