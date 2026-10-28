// main/page.js runs here as in a page: stand-in dialogs and a credentials
// container, a fake relay on a stand-in document. Then net-hook.js loads on
// top, as Chrome may load it, to check the two disguises layer.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";

const records = [];
let channel;
const nativeToString = Function.prototype.toString;

// A page, before the kit arrives.
globalThis.alert = { alert: () => undefined }.alert;
globalThis.confirm = { confirm: () => false }.confirm;
globalThis.prompt = { prompt: () => null }.prompt;
class CredentialsContainer {
  store() {
    return Promise.resolve("stored for real");
  }
}
globalThis.CredentialsContainer = CredentialsContainer;
const creds = new CredentialsContainer();
const shown = { alert: nativeToString.call(alert), confirm: nativeToString.call(confirm), store: nativeToString.call(CredentialsContainer.prototype.store), fetch: nativeToString.call(fetch) };

const load = (file) =>
  runInThisContext(readFileSync(new URL(`../../packages/extension/src/${file}`, import.meta.url), "utf8"), {
    filename: `chrome-extension://abcdefghijklmnop/src/${file}`,
  });

before(() => {
  const doc = new EventTarget();
  globalThis.window = globalThis;
  globalThis.top = globalThis;
  globalThis.document = doc;
  globalThis.location = { href: "http://127.0.0.1/page", origin: "http://127.0.0.1" };
  channel = "abtest" + Math.random().toString(36).slice(2);
  doc.addEventListener("ab-net-hello", (e) => {
    if (e.detail === "hook") doc.dispatchEvent(new CustomEvent("ab-net-hello", { detail: JSON.stringify({ channel, config: null }) }));
  });
  doc.addEventListener(channel, (e) => records.push(...JSON.parse(e.detail)));
  load("main/page.js");
  load("main/net-hook.js");
});

const cfg = (m) => document.dispatchEvent(new CustomEvent(channel + ":cfg", { detail: JSON.stringify(m) }));

test("dialogs answer as the agent chose, and say what they asked", () => {
  records.length = 0;
  assert.equal(confirm("Delete it?"), true, "accept by default");
  cfg({ dialog: "dismiss" });
  assert.equal(confirm("Really?"), false);
  assert.equal(prompt("Name?", "x"), null);
  cfg({ dialog: "accept", dialogText: "Alice" });
  assert.equal(prompt("Name?", "x"), "Alice");
  cfg({ dialogText: null });
  assert.equal(prompt("Name?", "default"), "default");
  assert.equal(alert("hi"), undefined);
  const d = records.filter((r) => r.kind === "dialog");
  assert.deepEqual(
    d.map((r) => [r.dialog, r.message, r.answer]),
    [["confirm", "Delete it?", "ok"], ["confirm", "Really?", "cancel"], ["prompt", "Name?", null], ["prompt", "Name?", "Alice"], ["prompt", "Name?", "default"], ["alert", "hi", "ok"]],
  );
});

test("a page cannot store a credential, and it is reported", async () => {
  records.length = 0;
  assert.equal(await creds.store({ type: "password", id: "alice" }), undefined);
  assert.deepEqual(records.map((r) => [r.kind, r.type, r.id]), [["credential", "password", "alice"]]);
  assert.equal(Object.getOwnPropertyNames(creds).length, 0, "patched on the prototype, not the object");
});

test("every patched function reads as the original, with both scripts loaded", () => {
  assert.equal(String(alert), shown.alert);
  assert.equal(Function.prototype.toString.call(confirm), shown.confirm);
  assert.equal(String(CredentialsContainer.prototype.store), shown.store);
  assert.equal(String(fetch), shown.fetch);
  assert.equal(Function.prototype.toString.toString(), nativeToString.call(nativeToString));
  assert.equal(alert.name, "alert");
});

test("nothing is left on window, and no fixed-name event is sent", () => {
  assert.deepEqual(Object.getOwnPropertyNames(globalThis).filter((k) => /^__ab|^ab[0-9a-f]{32}/.test(k)), []);
  let heard = 0;
  for (const name of ["ab-dialog", "ab-credential", "ab-diag", "ab-diag-flush"]) {
    document.addEventListener(name, () => heard++);
  }
  confirm("again");
  assert.equal(heard, 0);
});
