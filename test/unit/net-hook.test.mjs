// net-hook.js runs here in Node, as it runs in a page: same globals (fetch,
// Response, WebSocket, EventTarget), a stub XMLHttpRequest, and a fake relay
// on a stand-in document. Real requests go to a local server. This process is
// the "page", so it is patched for good; node --test gives each file its own.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { runInThisContext } from "node:vm";
import { WebSocketServer } from "ws";

let server;
let base;
let wss;
const records = [];
let channel;

// ---- a page, before the hook arrives ---------------------------------------
const realFetch = globalThis.fetch;
let lastPromise;
const pageFetch = { fetch: (...a) => (lastPromise = realFetch(...a)) }.fetch; // named, no prototype, like the real one
globalThis.fetch = pageFetch;
const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
const nativeToString = Function.prototype.toString;
const before_ = {
  fetch: nativeToString.call(pageFetch),
  ws: nativeToString.call(globalThis.WebSocket),
  toString: nativeToString.call(nativeToString),
};

class XMLHttpRequest extends EventTarget {
  #s = { status: 0, url: "", text: "", type: "", headers: {} };
  get status() { return this.#s.status; }
  get statusText() { return this.#s.status === 200 ? "OK" : ""; }
  get responseURL() { return this.#s.url; }
  get responseType() { return this.#s.type; }
  set responseType(v) { this.#s.type = v; }
  get responseText() { return this.#s.text; }
  get response() { return this.#s.type === "json" ? JSON.parse(this.#s.text) : this.#s.text; }
  getResponseHeader(n) { return this.#s.headers[n.toLowerCase()] ?? null; }
  open(method, url) { this.#s.method = method; this.#s.url = new URL(url, base).href; }
  send(body) {
    realFetch(this.#s.url, { method: this.#s.method, body }).then(
      async (r) => {
        this.#s.status = r.status;
        this.#s.headers = { "content-type": r.headers.get("content-type") };
        this.#s.text = await r.text();
        this.dispatchEvent(new Event("loadend"));
      },
      () => {
        this.#s.status = 0;
        this.dispatchEvent(new Event("loadend"));
      },
    );
  }
}
globalThis.XMLHttpRequest = XMLHttpRequest;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url.startsWith("/json")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: [{ id: 1, name: "jacket" }], echo: body }));
      } else if (req.url.startsWith("/big")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(5000));
      } else if (req.url.startsWith("/img")) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.alloc(100));
      } else res.writeHead(404).end();
    });
  });
  wss = new WebSocketServer({ server });
  wss.on("connection", (s) => {
    s.on("message", (m) => s.send(`echo:${m}`));
    s.send("hello");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const doc = new EventTarget();
  globalThis.window = globalThis;
  globalThis.top = globalThis;
  globalThis.document = doc;
  globalThis.location = { href: `${base}/page`, origin: base };
  // The relay: answer the hook's hello with a channel, collect batches.
  channel = "abtest" + Math.random().toString(36).slice(2);
  doc.addEventListener("ab-net-hello", (e) => {
    if (e.detail === "hook") doc.dispatchEvent(new CustomEvent("ab-net-hello", { detail: JSON.stringify({ channel, config: null }) }));
  });
  doc.addEventListener(channel, (e) => records.push(...JSON.parse(e.detail)));

  // Under the name Chrome gives it, so the stack scrubbing has something to find.
  runInThisContext(readFileSync(new URL("../../packages/extension/src/main/net-hook.js", import.meta.url), "utf8"), {
    filename: "chrome-extension://abcdefghijklmnop/src/main/net-hook.js",
  });
});

after(() => {
  wss.close();
  server.close();
});

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const config = (c) => document.dispatchEvent(new CustomEvent(channel + ":cfg", { detail: JSON.stringify(c) }));

test("patched functions look like the originals", () => {
  assert.notEqual(globalThis.fetch, pageFetch);
  assert.equal(Function.prototype.toString.call(fetch), before_.fetch);
  assert.equal(fetch.toString(), before_.fetch);
  assert.equal(String(fetch), before_.fetch);
  assert.equal(Function.prototype.toString.toString(), before_.toString);
  assert.equal(Function.prototype.toString.call(WebSocket), before_.ws);
  assert.equal(fetch.name, "fetch");
  assert.equal("prototype" in fetch, false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, "fetch"), { ...fetchDescriptor, value: globalThis.fetch });
  assert.equal(Object.keys(globalThis).some((k) => k.startsWith("__ab")), false);
});

test("fetch returns the browser's own promise, and the page still reads its body", async () => {
  records.length = 0;
  const p = fetch(`${base}/json?q=1`, { method: "POST", body: JSON.stringify({ q: "jacket" }) });
  assert.equal(p, lastPromise);
  const data = await (await p).json();
  assert.equal(data.items[0].name, "jacket");
  await settle();
  const r = records.find((x) => x.via === "fetch");
  assert.equal(r.status, 200);
  assert.equal(r.method, "POST");
  assert.equal(JSON.parse(r.body).items[0].name, "jacket");
  assert.equal(r.requestBody, '{"q":"jacket"}');
});

test("a failed fetch rejects as before and is recorded as a fault", async () => {
  records.length = 0;
  await assert.rejects(fetch("http://127.0.0.1:1/"), TypeError);
  await settle();
  const f = records.find((x) => x.kind === "fault");
  assert.equal(f.via, "fetch");
  assert.match(f.error, /fetch failed|Failed to fetch/);
});

test("XHR: recorded on loadend, nothing left on the object", async () => {
  records.length = 0;
  const x = new XMLHttpRequest();
  x.open("GET", "/json");
  x.send();
  await new Promise((r) => x.addEventListener("loadend", r));
  await settle();
  assert.deepEqual(Object.keys(x), []);
  const r = records.find((y) => y.via === "xhr");
  assert.equal(r.url, `${base}/json`);
  assert.match(r.body, /jacket/);
});

test("bodies are capped, media skipped, blocked hosts kept bodiless", async () => {
  config({ maxBodyChars: 100 });
  records.length = 0;
  await (await fetch(`${base}/big`)).text();
  await (await fetch(`${base}/img`)).arrayBuffer();
  await settle();
  const big = records.find((r) => r.url.endsWith("/big"));
  assert.equal(big.body.length, 100);
  assert.equal(big.truncated, true);
  assert.equal(records.find((r) => r.url.endsWith("/img")).skipped, "type");

  config({ maxBodyChars: 65536, blockedDomains: ["127.0.0.1"] });
  records.length = 0;
  await (await fetch(`${base}/json`)).json();
  await settle();
  assert.equal(records[0].skipped, "blocked");
  assert.equal(records[0].body, undefined);
  config({ blockedDomains: [] });
});

test("WebSocket: same constructor to the page, frames both ways", async () => {
  records.length = 0;
  const ws = new WebSocket(base.replace("http", "ws"));
  assert.equal(ws.constructor, WebSocket);
  assert.ok(ws instanceof WebSocket);
  assert.equal(WebSocket.OPEN, 1);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.send("hi");
  await new Promise((r) => ws.addEventListener("message", (e) => e.data === "echo:hi" && r()));
  ws.close();
  await settle(300);
  assert.ok(records.find((r) => r.kind === "ws-open"));
  const frames = records.filter((r) => r.kind === "ws-frame").map((r) => `${r.dir}:${r.data}`);
  assert.ok(frames.includes("out:hi"));
  assert.ok(frames.includes("in:hello"));
  assert.ok(frames.includes("in:echo:hi"));
});

test("an exception from the original reaches the page unchanged, without our frames", () => {
  assert.throws(
    () => new WebSocket("not a url"),
    (e) => e.name === "SyntaxError" && !String(e.stack).includes("chrome-extension://"),
  );
});
