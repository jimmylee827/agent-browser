// What the server does with recorded traffic once the extension hands it
// over: a one-line summary for visit/act results, bodies an agent can use
// (JSON parsed), and exports a person can open (HAR) or a script can stream
// (NDJSON). Pure: unit-tested from dist/.

export interface Header {
  name: string;
  value: string;
}

export interface NetEntry {
  id: number;
  ts: number;
  tabId?: number;
  frameUrl?: string;
  via?: string;
  type?: string;
  wireType?: string;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  requestHeaders?: Header[];
  responseHeaders?: Header[];
  requestBody?: string;
  requestBodyPreview?: string;
  body?: string;
  bodyPreview?: string;
  bodyChars?: number;
  bodyCut?: boolean;
  truncated?: boolean | string;
  skipped?: string;
  durationMs?: number;
  fromCache?: boolean;
  ip?: string;
  error?: string;
  socketId?: number;
  frames?: { ts: number; dir: string; data?: string; binary?: boolean; size?: number; truncated?: boolean }[];
  dropped?: number;
  closed?: { ts: number; code?: number; reason?: string };
}

const path = (u: string) => {
  try {
    const x = new URL(u);
    const p = x.pathname + (x.search.length > 1 ? x.search : "");
    return p.length > 60 ? `${p.slice(0, 57)}…` : p;
  } catch {
    return u.slice(0, 60);
  }
};

const kb = (n?: number) => (n === undefined ? "" : n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`);

const shortType = (mime?: string) => {
  const m = String(mime || "").toLowerCase();
  if (m.includes("json")) return "json";
  if (m.includes("html")) return "html";
  if (m.includes("xml")) return "xml";
  if (m.startsWith("text/")) return "text";
  return m.split(";")[0] || "";
};

export function describe(e: NetEntry): string {
  if (e.via === "ws" || e.via === "sse") {
    const n = e.frames?.length ?? 0;
    return `${e.via.toUpperCase()} ${path(e.url)} ${n} message${n === 1 ? "" : "s"}${e.dropped ? ` (+${e.dropped} dropped)` : ""}`;
  }
  const status = e.error ? `failed (${e.error})` : String(e.status ?? "?");
  const body = e.bodyChars !== undefined ? ` ${kb(e.bodyChars)}` : "";
  return `${e.method} ${path(e.url)} ${status}${shortType(e.mimeType) ? ` ${shortType(e.mimeType)}` : ""}${body}`;
}

/** For visit and act results: the API calls the page made during the call. */
export function summarize(entries: NetEntry[], max = 5): string | undefined {
  if (!entries.length) return undefined;
  const shown = entries.slice(0, max).map(describe).join("; ");
  const more = entries.length > max ? `; +${entries.length - max} more` : "";
  return `${entries.length} API call${entries.length === 1 ? "" : "s"}: ${shown}${more} — bodies: browser_network`;
}

/** A body ready to use: JSON parsed when it parses, and saying so when it was cut. */
export function bodyView(e: NetEntry, parse = true): NetEntry & { json?: unknown; parseError?: string } {
  if (!parse || typeof e.body !== "string") return e;
  const looksJson = shortType(e.mimeType) === "json" || /^\s*[[{]/.test(e.body);
  if (!looksJson) return e;
  try {
    const { body: _b, ...rest } = e;
    return { ...rest, json: JSON.parse(e.body) };
  } catch {
    return { ...e, parseError: e.truncated || e.bodyCut ? "truncated: raise bodyChars, or read it in the export" : "not valid JSON" };
  }
}

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie)$/i;

/** The extension redacts before storing; this catches an older extension, or anything it missed. */
export function secondPassRedact(e: NetEntry, headers: string[] = []): NetEntry {
  const names = new Set(headers.map((h) => h.toLowerCase()));
  const hdr = (list?: Header[]) =>
    list?.map((h) => (SECRET_HEADER.test(h.name) || names.has(h.name.toLowerCase()) ? { name: h.name, value: "[redacted]" } : h));
  const s = (v?: string) => (typeof v === "string" ? v.replace(JWT, "[redacted:jwt]") : v);
  return {
    ...e,
    requestHeaders: hdr(e.requestHeaders),
    responseHeaders: hdr(e.responseHeaders),
    body: s(e.body),
    requestBody: s(e.requestBody),
    url: s(e.url) as string,
  };
}

function queryOf(url: string): Header[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

/**
 * HAR 1.2, which browsers' devtools and most HTTP tools open. WebSocket
 * messages use Chrome's own `_webSocketMessages`; what HAR has no field for
 * (which hook saw it, whether the body was cut) goes in `_agentBrowser`.
 */
export function toHar(entries: NetEntry[], meta: { page?: string; title?: string; version?: string } = {}) {
  const started = entries.length ? new Date(Math.min(...entries.map((e) => e.ts))).toISOString() : new Date().toISOString();
  return {
    log: {
      version: "1.2",
      creator: { name: "agent-browser", version: meta.version ?? "0" },
      pages: [{ startedDateTime: started, id: "page_1", title: meta.title ?? meta.page ?? "", pageTimings: {} }],
      entries: entries.map((e) => {
        const reqBody = e.requestBody ?? e.requestBodyPreview;
        const resBody = e.body ?? e.bodyPreview;
        const reqType = e.requestHeaders?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
        return {
          pageref: "page_1",
          startedDateTime: new Date(e.ts).toISOString(),
          time: e.durationMs ?? 0,
          request: {
            method: e.method,
            url: e.url,
            httpVersion: "",
            cookies: [],
            headers: e.requestHeaders ?? [],
            queryString: queryOf(e.url),
            ...(reqBody !== undefined ? { postData: { mimeType: reqType, text: reqBody } } : {}),
            headersSize: -1,
            bodySize: reqBody?.length ?? -1,
          },
          response: {
            status: e.status ?? 0,
            statusText: e.statusText ?? e.error ?? "",
            httpVersion: "",
            cookies: [],
            headers: e.responseHeaders ?? [],
            content: { size: e.bodyChars ?? resBody?.length ?? -1, mimeType: e.mimeType ?? "", ...(resBody !== undefined ? { text: resBody } : {}) },
            redirectURL: "",
            headersSize: -1,
            bodySize: e.bodyChars ?? -1,
          },
          cache: {},
          timings: { send: 0, wait: e.durationMs ?? 0, receive: 0 },
          ...(e.ip ? { serverIPAddress: e.ip } : {}),
          ...(e.frames
            ? {
                _webSocketMessages: e.frames.map((f) => ({
                  type: f.dir === "out" ? "send" : "receive",
                  time: f.ts / 1000,
                  opcode: f.binary ? 2 : 1,
                  data: f.data ?? `[binary ${f.size ?? 0} bytes]`,
                })),
              }
            : {}),
          _agentBrowser: {
            via: e.via,
            ...(e.truncated || e.bodyCut ? { truncated: e.truncated || e.bodyCut } : {}),
            ...(e.skipped ? { skipped: e.skipped } : {}),
            ...(e.frameUrl ? { frameUrl: e.frameUrl } : {}),
            ...(e.error ? { error: e.error } : {}),
            ...(e.dropped ? { dropped: e.dropped } : {}),
          },
        };
      }),
    },
  };
}

export const toNdjson = (entries: NetEntry[]) => entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
