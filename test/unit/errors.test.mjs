import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOGUE, codeOf, AbError } from "../../packages/mcp-server/dist/errors.js";

test("a tagged error keeps its code", () => {
  assert.equal(codeOf(Object.assign(new Error("whatever"), { code: "NEEDS_HUMAN" })), "NEEDS_HUMAN");
  assert.equal(codeOf(new AbError("TAB_GONE", "x")), "TAB_GONE");
});

test("captcha, stale ref, closed tab and missing element are told apart by code alone", () => {
  const codes = [
    codeOf(Object.assign(new Error("NEEDS_HUMAN: covered"), { code: "NEEDS_HUMAN" })),
    codeOf(new Error("STALE_SNAPSHOT: re-observe before acting")),
    codeOf(new Error("TAB_GONE: tab 5 was closed")),
    codeOf(new AbError("NO_MATCH", "no element")),
  ];
  assert.deepEqual(codes, ["NEEDS_HUMAN", "STALE_SNAPSHOT", "TAB_GONE", "NO_MATCH"]);
});

test("untagged errors are classified by their text", () => {
  assert.equal(codeOf(new Error("HALTED: kill switch active")), "HALTED");
  assert.equal(codeOf(new Error("bridge not connected: …")), "BRIDGE_DOWN");
  assert.equal(codeOf(new Error("NO_SUCH_TAB: no tab 3")), "TAB_GONE");
  assert.equal(codeOf(new Error("unknown method: engine.openSessionWindow")), "EXTENSION_STALE");
  assert.equal(codeOf(new Error("something odd")), "ENGINE_ERROR");
});

test("an unknown code from elsewhere is not trusted as a code", () => {
  assert.equal(codeOf(Object.assign(new Error("x"), { code: "PORT_CLOSED_AFTER_ACTION" })), "ENGINE_ERROR");
});

test("every code says whether the agent can fix it and how", () => {
  for (const [code, e] of Object.entries(CATALOGUE)) {
    assert.equal(typeof e.agentCanFix, "boolean", code);
    assert.ok(e.fixSteps.length > 0, code);
  }
  assert.equal(CATALOGUE.NEEDS_HUMAN.agentCanFix, false);
  assert.ok(CATALOGUE.NEEDS_HUMAN.humanAction);
});
