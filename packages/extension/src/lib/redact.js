// Secrets are removed before a request is stored, so the browser's own store
// never holds an Authorization header or a typed password, and nothing an
// agent reads or exports can leak one. Pure: no chrome.* here, so the unit
// tests run it in Node.

export const REDACTED = "[redacted]";

/**
 * Field names are compared lower-case with separators removed: `access_token`,
 * `accessToken` and `Access-Token` are all `accesstoken`. The pattern then
 * decides; anchored alternatives (`^(code|pin)$`) catch short names without
 * catching `countryCode` or `pinned`.
 */
export const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

export function keyMatcher(source) {
  let re;
  try {
    re = new RegExp(source || "$^", "i");
  } catch {
    re = /password|secret|token/i;
  }
  return (k) => re.test(normKey(k));
}

/** webRequest's [{name, value}] list, or a plain object of headers. */
export function redactHeaders(headers, names) {
  if (!headers) return headers;
  const secret = new Set((names || []).map((n) => n.toLowerCase()));
  if (Array.isArray(headers)) {
    return headers.map((h) => (secret.has(String(h.name).toLowerCase()) ? { name: h.name, value: REDACTED } : h));
  }
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k] = secret.has(k.toLowerCase()) ? REDACTED : v;
  return out;
}

function redactParams(qs, isSecret) {
  const p = new URLSearchParams(qs);
  let changed = false;
  for (const k of [...new Set(p.keys())]) {
    if (!isSecret(k)) continue;
    p.set(k, REDACTED);
    changed = true;
  }
  // One spelling of the marker, not %5Bredacted%5D: agents grep for it.
  return changed ? p.toString().replace(/%5Bredacted%5D/gi, REDACTED) : null;
}

/** Query values, and fragment values (`#access_token=…` from an OAuth redirect). */
export function redactUrl(url, isSecret) {
  if (!url || typeof url !== "string") return url;
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const q = u.search.length > 1 ? redactParams(u.search.slice(1), isSecret) : null;
  if (q !== null) u.search = q;
  const h = u.hash.includes("=") ? redactParams(u.hash.slice(1), isSecret) : null;
  if (h !== null) u.hash = h;
  return q === null && h === null ? redactJwt(url) : redactJwt(u.toString());
}

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
export const redactJwt = (text) => (typeof text === "string" ? text.replace(JWT, "[redacted:jwt]") : text);

function redactJson(value, isSecret) {
  if (Array.isArray(value)) return value.map((v) => redactJson(v, isSecret));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecret(k) && v !== null && v !== "" ? REDACTED : redactJson(v, isSecret);
    }
    return out;
  }
  return value;
}

// A body cut at maxBodyChars no longer parses. Fall back to the pairs we can
// still see: "key": "value" and "key": 123.
const JSON_PAIR = /"((?:[^"\\]|\\.){1,80})"(\s*:\s*)("(?:[^"\\]|\\.)*"?|-?[\d.eE+]+|true|false)/g;
const FORM_PAIR = /(^|[&?\s])([A-Za-z0-9_.\-\[\]]{1,80})=([^&\s]*)/g;

/**
 * A request or response body. JSON is rewritten structurally, form bodies
 * key by key; anything else (text that merely contains pairs) by pattern.
 */
export function redactBody(text, contentType, isSecret) {
  if (typeof text !== "string" || !text) return text;
  const ct = String(contentType || "").toLowerCase();
  const trimmed = text.trimStart();
  if (ct.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return redactJwt(JSON.stringify(redactJson(JSON.parse(text), isSecret)));
    } catch {
      return redactJwt(text.replace(JSON_PAIR, (m, k, sep, v) => (isSecret(k) ? `"${k}"${sep}"${REDACTED}"` : m)));
    }
  }
  if (ct.includes("x-www-form-urlencoded")) {
    const r = redactParams(text, isSecret);
    return redactJwt(r === null ? text : r);
  }
  return redactJwt(
    text
      .replace(JSON_PAIR, (m, k, sep, v) => (isSecret(k) ? `"${k}"${sep}"${REDACTED}"` : m))
      .replace(FORM_PAIR, (m, pre, k, v) => (isSecret(k) && v ? `${pre}${k}=${REDACTED}` : m)),
  );
}

/**
 * Values the agent itself typed into password fields: they are known exactly,
 * so they are found under any field name, plain or URL-encoded.
 */
export function redactValues(text, secrets) {
  if (typeof text !== "string" || !secrets?.length) return text;
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    const formEncoded = new URLSearchParams({ v: s }).toString().slice(2);
    for (const form of new Set([s, encodeURIComponent(s), formEncoded, JSON.stringify(s).slice(1, -1)])) {
      out = out.split(form).join(REDACTED);
    }
  }
  return out;
}
