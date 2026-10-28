import { test } from "node:test";
import assert from "node:assert/strict";
import { compareBuilds } from "../../packages/mcp-server/dist/build.js";

const b = (commit, srcHash, builtAt = "2026-10-17T00:00:00Z") => ({ commit, dirty: false, srcHash, builtAt });

test("the same build is not stale", () => {
  const s = compareBuilds(b("abc", "111"), b("abc", "111"), Date.parse("2026-10-16T00:00:00Z"));
  assert.equal(s.staleBuild, false);
  assert.equal(s.restart, undefined);
});

test("a rebuilt disk is stale, with the restart command", () => {
  const s = compareBuilds(b("abc", "111"), b("def", "222"), 0);
  assert.equal(s.staleBuild, true);
  assert.equal(s.restart, "npm run mcp:restart");
  assert.match(s.warning, /older build/);
});

test("source edited since the last build is reported", () => {
  const s = compareBuilds(b("abc", "111"), b("abc", "111"), Date.parse("2026-10-18T00:00:00Z"));
  assert.equal(s.staleBuild, false);
  assert.equal(s.sourceNewerThanBuild, true);
  assert.match(s.warning, /npm run build/);
});

test("no build info at all is never called stale", () => {
  assert.equal(compareBuilds(null, null, 0).staleBuild, false);
});
