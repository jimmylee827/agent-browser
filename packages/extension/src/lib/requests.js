// Packaged page-world code: no eval, no extension-origin fetch and no fallback
// transport. The selected tab supplies cookies and normal CSP/CORS semantics.
export async function postInPage(spec) {
  let dispatched = false;
  const url = new URL(spec.url, location.href);
  if (!/^https?:$/.test(url.protocol)) return { dispatch: "not_dispatched", error: "HTTP(S) required" };
  let form;
  try {
    if (spec.mode === "form") {
      form = document.createElement("form");
      form.method = "POST"; form.action = url.href;
      form.enctype = spec.encoding === "multipart" ? "multipart/form-data" : "application/x-www-form-urlencoded";
      form.style.display = "none";
      for (const [name, value] of spec.fields || []) {
        const input = document.createElement("input");
        input.type = "hidden"; input.name = name; input.value = value; form.append(input);
      }
      document.documentElement.append(form);
      dispatched = true;
      // Calling the native prototype avoids a field named 'submit' shadowing it.
      HTMLFormElement.prototype.submit.call(form);
      return { dispatch: "completed", actionOutcome: "unknown", navigationRequested: true };
    }
    const headers = { ...spec.headers };
    let body;
    if (spec.encoding === "json") { body = spec.body; headers["content-type"] ??= "application/json"; }
    else if (spec.encoding === "text") { body = spec.body; headers["content-type"] ??= "text/plain;charset=UTF-8"; }
    else if (spec.encoding === "multipart") {
      body = new FormData(); for (const [k, v] of spec.fields || []) body.append(k, v);
    } else { body = new URLSearchParams(spec.fields || []); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), spec.timeoutMs || 15000);
    try {
      dispatched = true;
      // Do not auto-follow redirects with caller-supplied credentials or custom
      // headers. A manual redirect is opaque when Chrome cannot expose it.
      const response = await fetch(url.href, { method: "POST", body, headers, credentials: "include", redirect: "manual", signal: controller.signal });
      const max = spec.maxBodyChars || 16000;
      let text = "", cut = false;
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) { text += decoder.decode(); break; }
          text += decoder.decode(value, { stream: true });
          if (text.length > max) { cut = true; await reader.cancel(); break; }
        }
      }
      return { dispatch: "completed", actionOutcome: "response_received", response: {
        status: response.status, url: response.url, type: response.type,
        headers: [...response.headers].map(([name, value]) => ({ name, value })),
        body: text.slice(0, max), ...(cut ? { truncated: true } : {}) } };
    } finally { clearTimeout(timer); }
  } catch (e) {
    return { dispatch: dispatched ? "unknown" : "not_dispatched", actionOutcome: "unknown", error: String(e.message || e),
      note: "CSP/CORS/network errors and timeouts do not establish non-submission; no retry was made" };
  } finally {
    // Removing a submitted form before its queued navigation runs can cancel
    // that navigation. Leave it for the document to unload, or expire it.
    if (form && dispatched) setTimeout(() => form.remove(), 30000);
    else form?.remove();
  }
}

export function headerRule(id, tabId, url, headers, method = "get") {
  const target = new URL(url); target.hash = "";
  if (!/^https?:$/.test(target.protocol)) throw new Error("HTTP(S) required");
  return { id, priority: 10, condition: { tabIds: [tabId], resourceTypes: ["main_frame"], requestMethods: [method.toLowerCase()],
    regexFilter: "^" + target.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$" },
    action: { type: "modifyHeaders", requestHeaders: Object.entries(headers).map(([header, value]) => ({ header, operation: "set", value })) } };
}
