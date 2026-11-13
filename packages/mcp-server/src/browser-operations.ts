import { AbError } from "./errors.js";

export type Dispatch = "not_dispatched" | "completed" | "unknown";

/** Observations are not delivery guarantees or a business-success verdict. */
export function actionOutcome(opts: { dispatch: Dispatch; changed?: boolean; response?: unknown; request?: boolean; loading?: boolean }) {
  return {
    dispatch: opts.dispatch,
    actionOutcome: opts.response !== undefined ? "response_received" : opts.request ? "request_observed" : opts.changed ? "effect_observed" : "unknown",
    ...(opts.loading ? { pending: true } : {}),
    businessSuccess: "not_verified",
    automaticRetryAllowed: false,
  };
}

const FORBIDDEN = /^(cookie|cookie2|host|connection|accept-charset|date|dnt|permissions-policy|keep-alive|set-cookie|content-length|transfer-encoding|origin|referer|accept-encoding|proxy-.*|sec-.*|access-control-request-.*|upgrade|trailer|te|expect|via)$/i;
export function requestHeaders(input: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value) || FORBIDDEN.test(name))
      throw new AbError("BAD_REQUEST", `unsupported or invalid request header: ${name}`);
    const lower = name.toLowerCase();
    if (lower in out) throw new AbError("BAD_REQUEST", `duplicate request header: ${name}`);
    out[lower] = value;
  }
  return out;
}

export function httpUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AbError("BAD_REQUEST", "target must be an HTTP(S) URL"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new AbError("BAD_REQUEST", "target must be HTTP(S), without URL credentials");
  return url;
}
