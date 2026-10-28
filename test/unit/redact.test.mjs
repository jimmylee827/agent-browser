import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keyMatcher, redactHeaders, redactUrl, redactBody, redactJwt, redactValues, REDACTED } from "../../packages/extension/src/lib/redact.js";

// The shipped pattern, so the test checks what a person actually runs.
const cfg = JSON.parse(readFileSync(new URL("../../config/default.json", import.meta.url), "utf8"));
const isSecret = keyMatcher(cfg.network.redactKeys);

test("secret field names match however they are spelled; ordinary data does not", () => {
  for (const k of ["password", "Password", "new_password", "access_token", "accessToken", "Access-Token", "refresh_token",
    "client_secret", "apiKey", "api_key", "csrfToken", "code", "otp", "pin", "cvv", "session", "sessionId", "sid", "passcode", "jwt"]) {
    assert.equal(isSecret(k), true, k);
  }
  for (const k of ["countryCode", "statusCode", "zipcode", "postcode", "pinned", "spinner", "q", "email", "price",
    "productId", "size", "description", "title"]) {
    assert.equal(isSecret(k), false, k);
  }
});

test("headers: listed names lose their values, in either shape", () => {
  const list = redactHeaders(
    [{ name: "Authorization", value: "Bearer abc" }, { name: "Accept", value: "application/json" }],
    cfg.network.redactHeaders,
  );
  assert.deepEqual(list, [{ name: "Authorization", value: REDACTED }, { name: "Accept", value: "application/json" }]);
  assert.deepEqual(redactHeaders({ Cookie: "sid=1", "X-Trace": "t" }, ["cookie"]), { Cookie: REDACTED, "X-Trace": "t" });
});

test("URLs: query and OAuth fragment secrets go, the rest stays readable", () => {
  assert.equal(
    redactUrl("https://shop.example/api/items?q=jacket&token=abc123&page=2", isSecret),
    `https://shop.example/api/items?q=jacket&token=${REDACTED}&page=2`,
  );
  assert.equal(
    redactUrl("https://app.example/cb#access_token=xyz&state=s1", isSecret),
    `https://app.example/cb#access_token=${REDACTED}&state=s1`,
  );
  assert.equal(redactUrl("https://shop.example/men/outer/jacket", isSecret), "https://shop.example/men/outer/jacket");
  assert.equal(redactUrl("not a url", isSecret), "not a url");
});

test("JSON bodies are redacted by structure, nested and in arrays", () => {
  const body = JSON.stringify({ q: "x", password: "hunter2", user: { name: "a", links: [{ access_token: "t" }] }, tokens: ["a", "b"], countryCode: "HK" });
  const out = JSON.parse(redactBody(body, "application/json", isSecret));
  assert.equal(out.password, REDACTED);
  assert.equal(out.user.links[0].access_token, REDACTED);
  assert.equal(out.tokens, REDACTED); // a secret-named container goes whole
  assert.equal(out.q, "x");
  assert.equal(out.countryCode, "HK");
});

test("a truncated JSON body is still redacted pair by pair", () => {
  const cut = '{"items":[{"id":1}],"token":"abcdef","next":{"cursor":"c1","password":"hun';
  const out = redactBody(cut, "application/json", isSecret);
  assert.equal(out.includes("abcdef"), false);
  assert.equal(out.includes("hun"), false);
  assert.match(out, /"cursor":"c1"/);
});

test("form bodies and text with pairs", () => {
  assert.equal(redactBody("user=a&password=hunter2&remember=1", "application/x-www-form-urlencoded", isSecret), `user=a&password=${REDACTED}&remember=1`);
  assert.equal(redactBody("grant_type=refresh&refresh_token=r1", "text/plain", isSecret), `grant_type=refresh&refresh_token=${REDACTED}`);
});

test("JWTs are removed wherever they appear", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  assert.equal(redactJwt(`note: ${jwt} end`), "note: [redacted:jwt] end");
  assert.equal(redactBody(JSON.stringify({ greeting: jwt }), "application/json", isSecret), '{"greeting":"[redacted:jwt]"}');
});

test("a value the agent typed into a password field is found under any name", () => {
  const body = JSON.stringify({ pw_field_7: "S3cret!pass", q: "x" });
  assert.equal(redactValues(body, ["S3cret!pass"]).includes("S3cret"), false);
  assert.equal(redactValues("p=S3cret%21pass", ["S3cret!pass"]), `p=${REDACTED}`);
  assert.equal(redactValues("short abc", ["abc"]), "short abc"); // too short to be sure
});
