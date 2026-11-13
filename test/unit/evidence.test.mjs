import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneEvidence } from "../../packages/mcp-server/dist/evidence.js";

test("individual records expire inside an active session; fresh pairs and symlinks are protected", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-evidence-"));
  const session = join(root, "sessions", "active");
  mkdirSync(session, { recursive: true });
  const now = Date.now(), old = new Date(now - 15 * 86_400_000);
  const put = (name, age) => { const f = join(session, name); writeFileSync(f, "{}"); if (age) utimesSync(f, old, old); return f; };
  try {
    const json = put("old.json", true), image = put("old.png", true);
    put("fresh.json", false);
    const protectedImage = put("writing.png", true); put("writing.json", false);
    const exp = put("export.har", true);
    const outside = join(root, "outside.png"); writeFileSync(outside, "keep");
    symlinkSync(outside, join(session, "linked.png"));
    assert.equal(pruneEvidence({ stateDir: root, evidence: { retainDays: 14 } }, now), 3);
    for (const f of [json, image, exp]) assert.equal(existsSync(f), false);
    for (const f of [protectedImage, outside, join(session, "fresh.json"), join(session, "linked.png")]) assert.equal(existsSync(f), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
