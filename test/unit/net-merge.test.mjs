import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeStreams, filterEntries, normUrl, statusMatches } from "../../packages/extension/src/lib/net-merge.js";

const page = (o) => ({ kind: "page", via: "fetch", tabId: 1, method: "GET", status: 200, ...o });
const wire = (o) => ({ kind: "wire", type: "xmlhttprequest", tabId: 1, method: "GET", status: 200, ...o });

test("a page record and its wire record become one entry with body and headers", () => {
  const [e, ...rest] = mergeStreams([
    page({ id: 1, ts: 1000, tsEnd: 1100, url: "https://a.example/api/items", body: '{"n":1}', contentType: "application/json" }),
    wire({ id: 2, ts: 990, tsEnd: 1080, url: "https://a.example/api/items", responseHeaders: [{ name: "content-type", value: "application/json" }], ip: "1.2.3.4" }),
  ]);
  assert.equal(rest.length, 0);
  assert.equal(e.body, '{"n":1}');
  assert.equal(e.ip, "1.2.3.4");
  assert.equal(e.via, "fetch");
  assert.equal(e.durationMs, 100);
});

test("two identical requests pair with the nearest wire record, each used once", () => {
  const out = mergeStreams([
    page({ id: 1, ts: 1000, tsEnd: 1000, url: "https://a.example/p", body: "first" }),
    page({ id: 2, ts: 5000, tsEnd: 5000, url: "https://a.example/p", body: "second" }),
    wire({ id: 3, ts: 4990, tsEnd: 4995, url: "https://a.example/p", ip: "B" }),
    wire({ id: 4, ts: 990, tsEnd: 995, url: "https://a.example/p", ip: "A" }),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out.find((e) => e.body === "first").ip, "A");
  assert.equal(out.find((e) => e.body === "second").ip, "B");
});

test("records too far apart, on another tab or document, or another method stay separate", () => {
  const out = mergeStreams([
    page({ id: 1, ts: 1000, url: "https://a.example/p", documentId: "d1" }),
    wire({ id: 2, ts: 9000, url: "https://a.example/p" }),
    wire({ id: 3, ts: 1000, url: "https://a.example/p", tabId: 2 }),
    wire({ id: 4, ts: 1000, url: "https://a.example/p", documentId: "d2" }),
    wire({ id: 5, ts: 1000, url: "https://a.example/p", method: "POST" }),
  ]);
  assert.equal(out.length, 5);
});

test("unmatched wire records (a document, a failed script) are entries too", () => {
  const out = mergeStreams([
    wire({ id: 1, ts: 1, type: "main_frame", url: "https://a.example/" }),
    wire({ id: 2, ts: 2, type: "script", url: "https://a.example/x.js", status: 404 }),
  ]);
  assert.deepEqual(out.map((e) => e.via), ["document", "script"]);
  assert.equal(filterEntries(out, { type: "failed" }).length, 1);
});

test("a fault keeps its error and counts as failed; a wire success does not overwrite it", () => {
  const [e] = mergeStreams([
    { kind: "fault", via: "fetch", id: 1, ts: 1000, tabId: 1, method: "GET", url: "http://127.0.0.1:1/", error: "TypeError: Failed to fetch" },
    wire({ id: 2, ts: 1000, url: "http://127.0.0.1:1/", status: 0, error: "net::ERR_CONNECTION_REFUSED" }),
  ]);
  assert.equal(e.error, "TypeError: Failed to fetch");
  assert.equal(statusMatches(e, "failed"), true);
});

test("WebSocket frames gather under their socket, with close and drops", () => {
  const [e] = mergeStreams([
    { kind: "ws-open", via: "ws", id: 1, ts: 1, tabId: 1, url: "ws://a.example/ws", socketId: 7 },
    { kind: "ws-frame", id: 2, ts: 2, tabId: 1, socketId: 7, dir: "out", data: "hi" },
    { kind: "ws-frame", id: 3, ts: 3, tabId: 1, socketId: 7, dir: "in", binary: true, size: 12 },
    { kind: "ws-frame", id: 4, ts: 4, tabId: 1, socketId: 7, dir: "in", data: "x", dropped: 5 },
    { kind: "ws-close", id: 5, ts: 5, tabId: 1, socketId: 7, code: 1000 },
  ]);
  assert.equal(e.frames.length, 3);
  assert.deepEqual(e.frames[1], { ts: 3, dir: "in", binary: true, size: 12 });
  assert.equal(e.dropped, 5);
  assert.equal(e.closed.code, 1000);
});

test("filters: url pattern (regex or plain text), method, status classes, type, since; newest first", () => {
  const entries = mergeStreams([
    page({ id: 1, ts: 10, url: "https://a.example/api/search?q=1" }),
    page({ id: 2, ts: 20, url: "https://a.example/api/cart", method: "POST", status: 500 }),
    page({ id: 3, ts: 30, url: "https://a.example/api/search?q=2", via: "xhr", status: 404 }),
    wire({ id: 4, ts: 40, type: "image", url: "https://a.example/logo.png" }),
  ]);
  assert.deepEqual(filterEntries(entries, { urlPattern: "/api/search" }).map((e) => e.id), [3, 1]);
  assert.deepEqual(filterEntries(entries, { urlPattern: "search?q=(" }).map((e) => e.id), []); // bad regex → substring
  assert.deepEqual(filterEntries(entries, { method: "post" }).map((e) => e.id), [2]);
  assert.deepEqual(filterEntries(entries, { status: "4xx" }).map((e) => e.id), [3]);
  assert.deepEqual(filterEntries(entries, { type: "xhr" }).map((e) => e.id), [3]);
  assert.deepEqual(filterEntries(entries, { type: "all", since: 25 }).map((e) => e.id), [4, 3]);
  assert.equal(filterEntries(entries, {}).length, 3); // "api" by default: no images
  assert.deepEqual(filterEntries(entries, { limit: 1 }).map((e) => e.id), [3]);
});

test("URLs compare without their fragment", () => {
  assert.equal(normUrl("https://a.example/p#x"), "https://a.example/p");
  assert.equal(normUrl("/api", "https://a.example/page"), "https://a.example/api");
});
