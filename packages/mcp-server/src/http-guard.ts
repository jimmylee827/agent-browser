import type { IncomingHttpHeaders } from "node:http";

// The control plane drives the agent Chrome, which holds the person's logins.
// Loopback-only binding is not enough on its own: any web page in any browser
// on this machine can reach 127.0.0.1. `<img src="http://127.0.0.1:8788/visit?url=…">`
// needed no script at all, and a text/plain POST to /act skips the CORS
// preflight. Callers that belong here (the launcher, scripts, curl) are not
// browsers and send none of the headers a browser adds, so refusing those
// closes the hole without a token.
//
//   Origin          — browsers send it on every cross-origin POST, and on fetch
//   Sec-Fetch-Site  — browsers send it even on an <img> or <a> GET
//   Host            — DNS rebinding names the attacker's host here

// The port is not compared: in a container the published port differs from
// the one listened on, and rebinding changes the name, not the port.
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Why this request must be refused, or undefined when it may proceed. */
export function rejectBrowserOrigin(headers: IncomingHttpHeaders): string | undefined {
  const origin = first(headers.origin);
  if (origin) return `requests from web pages are refused (Origin: ${origin})`;
  const site = first(headers["sec-fetch-site"]);
  if (site && site !== "none" && site !== "same-origin") return `requests from web pages are refused (Sec-Fetch-Site: ${site})`;
  const host = first(headers.host);
  if (host !== undefined && !LOOPBACK_HOSTS.includes(host.replace(/:\d+$/, "").toLowerCase())) {
    return `unexpected Host: ${host}`;
  }
  return undefined;
}
