import { test } from "node:test";
import assert from "node:assert/strict";
import { rejectBrowserOrigin } from "../../packages/mcp-server/dist/http-guard.js";

test("scripts, curl and the launcher get through", () => {
  assert.equal(rejectBrowserOrigin({ host: "127.0.0.1:8788" }), undefined);
  assert.equal(rejectBrowserOrigin({ host: "localhost:8788", "user-agent": "curl/8" }), undefined);
  assert.equal(rejectBrowserOrigin({ host: "[::1]:8788" }), undefined);
  assert.equal(rejectBrowserOrigin({}), undefined);
  // A person typing the URL into a browser's address bar.
  assert.equal(rejectBrowserOrigin({ host: "127.0.0.1:8788", "sec-fetch-site": "none" }), undefined);
});

test("a web page cannot drive the agent browser", () => {
  // fetch() or a form POST from any site
  assert.match(rejectBrowserOrigin({ host: "127.0.0.1:8788", origin: "https://evil.example" }), /Origin/);
  // even a page served from localhost
  assert.match(rejectBrowserOrigin({ host: "127.0.0.1:8788", origin: "http://localhost:3000" }), /Origin/);
  // <img src="http://127.0.0.1:8788/visit?url=…"> sends no Origin, but does send this
  assert.match(rejectBrowserOrigin({ host: "127.0.0.1:8788", "sec-fetch-site": "cross-site" }), /Sec-Fetch-Site/);
  assert.match(rejectBrowserOrigin({ host: "127.0.0.1:8788", "sec-fetch-site": "same-site" }), /Sec-Fetch-Site/);
});

test("DNS rebinding is refused by its Host", () => {
  assert.match(rejectBrowserOrigin({ host: "rebind.evil.example:8788" }), /Host/);
  assert.match(rejectBrowserOrigin({ host: "127.0.0.1.evil.example" }), /Host/);
});
