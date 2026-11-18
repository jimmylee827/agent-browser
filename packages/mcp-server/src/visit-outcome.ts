export type VisitKind = "content" | "login_required" | "challenge" | "access_blocked" | "notice" | "http_error" | "transport_failure" | "unknown";

export function classifyVisit(wall: string | undefined, httpStatus: number | undefined, observed: boolean) {
  let kind: VisitKind;
  let nextStep: string | undefined;
  if (wall === "captcha") {
    kind = "challenge";
    nextStep = "Ask the user to handle the challenge in this tab. Do not retry or bypass it.";
  } else if (wall === "login") {
    kind = "login_required";
    nextStep = "Ask the user to sign in in this tab, then observe it again.";
  } else if (wall === "access_block" || wall === "rate_limit" || httpStatus === 403 || httpStatus === 429) {
    kind = "access_blocked";
    nextStep = "Report the block; do not retry or bypass it.";
  } else if (httpStatus === 401) {
    kind = "login_required";
    nextStep = "Ask the user to check authentication in this tab; do not resubmit automatically.";
  } else if (httpStatus !== undefined && httpStatus >= 400) {
    kind = "http_error";
    nextStep = "Report the document's HTTP error; inspect before trying again.";
  } else if (wall === "consent") {
    kind = "notice";
  } else {
    kind = observed ? "content" : "unknown";
    if (!observed) nextStep = "The document committed but could not be inspected. Observe the tab before relying on it.";
  }
  return { kind, ...(httpStatus !== undefined ? { httpStatus } : {}), ...(nextStep ? { nextStep } : {}) };
}
