import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, describe, bodyView, secondPassRedact, toHar, toNdjson } from "../../packages/mcp-server/dist/network.js";

const json = { id: 1, ts: 1000, via: "fetch", method: "GET", url: "https://shop.example/api/items?q=jacket", status: 200, mimeType: "application/json", body: '{"items":[1,2]}', bodyChars: 15 };
const ws = { id: 2, ts: 1001, via: "ws", method: "GET", url: "wss://shop.example/live", frames: [{ ts: 1002, dir: "in", data: "hi" }, { ts: 1003, dir: "out", binary: true, size: 4 }], dropped: 3 };
const failed = { id: 3, ts: 1002, via: "fetch", method: "POST", url: "https://shop.example/api/cart", status: 0, error: "Failed to fetch" };

test("a summary names the calls, and points to the tool for bodies", () => {
  const s = summarize([json, ws, failed]);
  assert.match(s, /^3 API calls: GET \/api\/items\?q=jacket 200 json 15B; WS \/live 2 messages \(\+3 dropped\); POST \/api\/cart failed \(Failed to fetch\)/);
  assert.match(s, /browser_network$/);
  assert.equal(summarize([]), undefined);
  assert.match(summarize(Array.from({ length: 8 }, () => json)), /\+3 more/);
  assert.match(describe({ ...json, url: "https://a.example/" + "x".repeat(100) }), /…/);
});

test("JSON bodies come back parsed; a cut one says why it does not parse", () => {
  const v = bodyView(json);
  assert.deepEqual(v.json, { items: [1, 2] });
  assert.equal("body" in v, false);
  const cut = bodyView({ ...json, body: '{"items":[1,', truncated: true });
  assert.match(cut.parseError, /truncated/);
  assert.equal(bodyView({ ...json, mimeType: "text/html", body: "<p>hi</p>" }).body, "<p>hi</p>");
  assert.equal(bodyView(json, false).body, json.body);
});

test("the second redaction pass catches secret headers and JWTs", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const e = secondPassRedact(
    { ...json, requestHeaders: [{ name: "Authorization", value: "Bearer x" }, { name: "X-Api-Key", value: "k" }, { name: "Accept", value: "*/*" }], body: `{"t":"${jwt}"}` },
    ["x-api-key"],
  );
  assert.deepEqual(e.requestHeaders.map((h) => h.value), ["[redacted]", "[redacted]", "*/*"]);
  assert.equal(e.body, '{"t":"[redacted:jwt]"}');
});

test("HAR: the shape devtools expects, WebSocket messages Chrome's way", () => {
  const har = toHar([json, ws, failed], { page: "https://shop.example/", version: "t" });
  assert.equal(har.log.version, "1.2");
  assert.equal(har.log.entries.length, 3);
  const [a, b, c] = har.log.entries;
  assert.deepEqual(a.request.queryString, [{ name: "q", value: "jacket" }]);
  assert.equal(a.response.content.text, '{"items":[1,2]}');
  assert.ok(Array.isArray(a.request.headers));
  assert.deepEqual(b._webSocketMessages.map((m) => [m.type, m.opcode, m.data]), [["receive", 1, "hi"], ["send", 2, "[binary 4 bytes]"]]);
  assert.equal(c.response.status, 0);
  assert.equal(c._agentBrowser.error, "Failed to fetch");
});

test("NDJSON: one entry per line", () => {
  const lines = toNdjson([json, failed]).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).url, failed.url);
  assert.equal(toNdjson([]), "");
});
