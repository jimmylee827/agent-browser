// Two streams describe the same traffic, and neither is whole:
//   page  — what the page's own fetch/XHR/WebSocket/EventSource saw: bodies,
//           frames, the URL after redirects. No headers, no timing.
//   wire  — what chrome.webRequest saw: headers, timing, cache, IP, every
//           request type including documents. No bodies (Chrome gives none).
// They share no id (the page never learns webRequest's requestId), so they are
// stored apart and joined when read: same tab, same document where both know
// it, same method and URL, nearest in time, each used once. Pure, for tests.

export function normUrl(url, base) {
  try {
    const u = new URL(url, base);
    u.hash = "";
    return u.toString();
  } catch {
    return String(url || "");
  }
}

const PAGE_KINDS = new Set(["page", "fault", "ws-open", "sse-open"]);
const FRAME_KINDS = new Set(["ws-frame", "sse-event", "ws-close"]);

function entryFromPage(r) {
  const e = {
    id: r.id,
    ts: r.ts,
    tabId: r.tabId,
    frameUrl: r.frameUrl,
    via: r.via,
    type: r.via,
    method: r.method || "GET",
    url: r.url,
  };
  if (r.kind === "fault") {
    e.error = r.error || "failed";
    e.status = 0;
  } else if (r.kind === "page") {
    Object.assign(e, {
      status: r.status,
      statusText: r.statusText,
      mimeType: r.contentType,
      durationMs: r.tsEnd && r.ts ? r.tsEnd - r.ts : undefined,
    });
  }
  for (const k of ["requestBody", "requestBodyChars", "body", "bodyChars", "truncated", "skipped", "redacted"]) {
    if (r[k] !== undefined) e[k] = r[k];
  }
  if (r.kind === "ws-open" || r.kind === "sse-open") {
    e.socketId = r.socketId;
    e.frames = [];
    e.dropped = 0;
  }
  return e;
}

function entryFromWire(w) {
  return {
    id: w.id,
    ts: w.ts,
    tabId: w.tabId,
    frameUrl: w.frameUrl,
    via: w.type === "main_frame" || w.type === "sub_frame" ? "document" : w.type,
    type: w.type,
    method: w.method,
    url: w.url,
    status: w.error ? 0 : w.status,
    statusText: w.statusLine,
    error: w.error,
    requestHeaders: w.requestHeaders,
    responseHeaders: w.responseHeaders,
    requestBody: w.requestBody,
    mimeType: header(w.responseHeaders, "content-type"),
    durationMs: w.tsEnd && w.ts ? w.tsEnd - w.ts : undefined,
    fromCache: w.fromCache,
    ip: w.ip,
  };
}

function header(list, name) {
  if (!Array.isArray(list)) return undefined;
  return list.find((h) => String(h.name).toLowerCase() === name)?.value;
}

function addWire(e, w) {
  e.requestHeaders = w.requestHeaders;
  e.responseHeaders = w.responseHeaders;
  e.fromCache = w.fromCache;
  e.ip = w.ip;
  e.wireType = w.type;
  if (e.mimeType === undefined) e.mimeType = header(w.responseHeaders, "content-type");
  if (e.status === undefined || (e.status === 0 && !e.error)) e.status = w.status;
  if (!e.statusText) e.statusText = w.statusLine;
  if (w.error && !e.error) e.error = w.error;
  if (e.durationMs === undefined && w.tsEnd && w.ts) e.durationMs = w.tsEnd - w.ts;
}

/**
 * Join stored records into entries, oldest first. `windowMs` bounds how far
 * apart in time a page record and a wire record may be and still be one
 * request (the page stamps after the body is read; webRequest at completion).
 */
export function mergeStreams(records, { windowMs = 3000, orphanFrames = false } = {}) {
  const pages = [];
  const wires = [];
  const frames = [];
  for (const r of records) {
    if (PAGE_KINDS.has(r.kind)) pages.push(r);
    else if (r.kind === "wire") wires.push(r);
    else if (FRAME_KINDS.has(r.kind)) frames.push(r);
  }

  // Index wire records by tab + method + URL; each list is short.
  const byKey = new Map();
  for (const w of wires) {
    const k = `${w.tabId}|${(w.method || "GET").toUpperCase()}|${normUrl(w.url)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(w);
  }
  const used = new Set();
  const entries = [];
  const sockets = new Map();

  for (const p of pages) {
    const e = entryFromPage(p);
    const k = `${p.tabId}|${(p.method || "GET").toUpperCase()}|${normUrl(p.url)}`;
    let best;
    let bestGap = Infinity;
    for (const w of byKey.get(k) || []) {
      if (used.has(w.id)) continue;
      if (p.documentId && w.documentId && p.documentId !== w.documentId) continue;
      const gap = Math.abs((w.tsEnd ?? w.ts) - (p.tsEnd ?? p.ts));
      if (gap <= windowMs && gap < bestGap) {
        best = w;
        bestGap = gap;
      }
    }
    if (best) {
      used.add(best.id);
      addWire(e, best);
    }
    if (e.socketId) sockets.set(`${p.tabId}|${p.socketId}`, e);
    entries.push(e);
  }
  for (const w of wires) if (!used.has(w.id)) entries.push(entryFromWire(w));

  for (const f of frames) {
    const e = sockets.get(`${f.tabId}|${f.socketId}`);
    if (!e) {
      // Its socket was recorded in an earlier batch (a job drains as it goes).
      if (orphanFrames) {
        const { kind, queue: _q, jobId: _j, ...rest } = f;
        entries.push({ ...rest, via: kind === "sse-event" ? "sse" : "ws", type: kind, method: "GET", url: f.url ?? "" });
      }
      continue;
    }
    if (f.kind === "ws-close") {
      e.closed = { ts: f.ts, code: f.code, reason: f.reason };
      // The hook stops sending frames past its cap and reports the count here.
      if (f.dropped) e.dropped = Math.max(e.dropped, f.dropped);
      continue;
    }
    if (f.dropped) e.dropped += f.dropped;
    if (f.kind === "sse-event" || f.dir) {
      e.frames.push({ ts: f.ts, dir: f.dir || "in", ...(f.data !== undefined ? { data: f.data } : {}), ...(f.binary ? { binary: true, size: f.size } : {}), ...(f.truncated ? { truncated: true } : {}) });
    }
  }
  return entries.sort((a, b) => a.ts - b.ts || a.id - b.id);
}

const API_VIA = new Set(["fetch", "xhr", "ws", "sse"]);

export const isFailed = (e) => !!e.error || e.status === 0 || (typeof e.status === "number" && e.status >= 400);

/** "2xx", "4xx", "failed", "ok", or an exact number. */
export function statusMatches(e, status) {
  if (status === undefined || status === null || status === "") return true;
  if (typeof status === "number" || /^\d+$/.test(String(status))) return e.status === Number(status);
  const s = String(status).toLowerCase();
  if (s === "failed") return isFailed(e);
  if (s === "ok") return !isFailed(e);
  const m = /^([1-5])xx$/.exec(s);
  return m ? typeof e.status === "number" && Math.floor(e.status / 100) === Number(m[1]) : true;
}

export function typeMatches(e, type) {
  switch (type || "api") {
    case "all":
      return true;
    case "api":
      return API_VIA.has(e.via) || e.type === "xmlhttprequest";
    case "failed":
      return isFailed(e);
    case "document":
      return e.via === "document";
    default:
      return e.via === type;
  }
}

/** A pattern is a regular expression, or a plain substring when it isn't one. */
export function urlMatcher(pattern) {
  if (!pattern) return () => true;
  try {
    const re = new RegExp(pattern, "i");
    return (u) => re.test(u || "");
  } catch {
    const p = String(pattern).toLowerCase();
    return (u) => String(u || "").toLowerCase().includes(p);
  }
}

/** Newest first, at most `limit`. */
export function filterEntries(entries, q = {}) {
  const url = urlMatcher(q.urlPattern);
  const method = q.method ? String(q.method).toUpperCase() : null;
  const out = entries.filter(
    (e) =>
      (q.since === undefined || e.ts >= q.since) &&
      (q.until === undefined || e.ts <= q.until) &&
      (!method || e.method === method) &&
      typeMatches(e, q.type) &&
      statusMatches(e, q.status) &&
      url(e.url),
  );
  out.sort((a, b) => b.ts - a.ts || b.id - a.id);
  return q.limit ? out.slice(0, q.limit) : out;
}
