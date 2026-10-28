/**
 * Every failure a tool returns carries a `code` from this catalogue, so a
 * caller can branch on what went wrong instead of parsing prose. The engine
 * and the extension tag their own errors; the bridge carries the tag through.
 * Errors that arrive untagged are classified once here, by their text.
 */
export type Code =
  | "NEEDS_HUMAN"
  | "STALE_SNAPSHOT"
  | "REF_NOT_FOUND"
  | "NO_MATCH"
  | "NOT_ACTIONABLE"
  | "OCCLUDED"
  | "HOVER_NOT_EFFECTIVE"
  | "TAB_GONE"
  | "NO_SESSION_TAB"
  | "TAB_OWNED_BY_OTHER"
  | "SESSION_LOCKED"
  | "BRIDGE_DOWN"
  | "NAV_TIMEOUT"
  | "HALTED"
  | "POLICY_BLOCKED"
  | "INVALID_VALUE"
  | "NO_SUCH_OPTION"
  | "EVAL_BLOCKED"
  | "EVAL_BLOCKED_BY_CSP"
  | "EVAL_FAILED"
  | "STALE_BUILD"
  | "EXTENSION_STALE"
  | "TRUSTED_UNAVAILABLE"
  | "BAD_REQUEST"
  | "CAPTURE_FAILED"
  | "ENGINE_ERROR";

interface Entry {
  agentCanFix: boolean;
  fixSteps: string[];
  humanAction: string | null;
}

// The kill switch and the policy gate belong to the user. Telling an agent
// how to remove either — as the old "rm ~/.agent-chrome/HALT to resume" did —
// invites it to.
export const HALT_ADVICE = "the user has switched on the kill switch: stop and tell them; do not try to turn it off";
export const POLICY_ADVICE =
  "this needs the user's approval: stop and ask them. Do not retry it, relabel it, or change the policy yourself";

export const CATALOGUE: Record<Code, Entry> = {
  NEEDS_HUMAN: {
    agentCanFix: false,
    fixSteps: ["stop, and tell the user what blocks the page (see needsHuman)", "after they say it is done, call agent_browser_visit or browser_observe and continue"],
    humanAction: "solve the check or dismiss the notice in the agent browser window, then tell the agent",
  },
  STALE_SNAPSHOT: { agentCanFix: true, fixSteps: ["take a fresh snapshot (agent_browser_visit / browser_observe)", "retry with the new ref"], humanAction: null },
  REF_NOT_FOUND: { agentCanFix: true, fixSteps: ["take a fresh snapshot (browser_observe)", "retry with the new ref, or act by name with agent_browser_act"], humanAction: null },
  NO_MATCH: { agentCanFix: true, fixSteps: ["retry with one of the similar elements listed, a shorter name, or no role", "or call browser_observe to see what is there"], humanAction: null },
  NOT_ACTIONABLE: { agentCanFix: true, fixSteps: ["wait (browser_wait) or scroll, then retry", "if it is disabled, do what enables it first"], humanAction: null },
  OCCLUDED: { agentCanFix: true, fixSteps: ["close or dismiss the element named in occludedBy", "then retry"], humanAction: null },
  HOVER_NOT_EFFECTIVE: {
    agentCanFix: false,
    fixSteps: ["do not report the hover state as seen", "click the element instead if the hover only reveals a link or menu"],
    humanAction: null,
  },
  TAB_GONE: { agentCanFix: true, fixSteps: ["the session's tab was closed: open the page again with agent_browser_visit({url})"], humanAction: null },
  NO_SESSION_TAB: {
    agentCanFix: true,
    fixSteps: ["call agent_browser_visit({url}) first — it opens this session's own window", "or pass tabId (from browser_tabs) to adopt an existing tab on purpose"],
    humanAction: null,
  },
  TAB_OWNED_BY_OTHER: {
    agentCanFix: true,
    fixSteps: ["use your own tab (agent_browser_visit opens one)", "to work together on one tab, both callers pass the same session \"shared:<name>\""],
    humanAction: null,
  },
  SESSION_LOCKED: { agentCanFix: true, fixSteps: ["wait until the lease ends (see lockedFor), or use your own session"], humanAction: null },
  BRIDGE_DOWN: {
    agentCanFix: true,
    fixSteps: ["call agent_browser_ensure_running", "if it still fails, tell the user in one sentence and record the step as not done"],
    humanAction: "if Chrome is open but never connects: load the extension once via chrome://extensions → Load unpacked → packages/extension",
  },
  NAV_TIMEOUT: { agentCanFix: true, fixSteps: ["retry once", "if it repeats, check agent_browser_status"], humanAction: null },
  HALTED: { agentCanFix: false, fixSteps: [HALT_ADVICE], humanAction: "turn the kill switch off (npm run resume) when you want the agent to continue" },
  POLICY_BLOCKED: {
    agentCanFix: false,
    fixSteps: [
      POLICY_ADVICE,
      "if the user says yes, propose an edit adding the domain to policy.trustedDomains in config/local.json — they approve the change in chat, and it takes effect on the next action",
    ],
    humanAction: "approve the action, or approve the agent's edit that adds the domain to trustedDomains in config/local.json",
  },
  INVALID_VALUE: { agentCanFix: true, fixSteps: ["the field is unchanged; retry with a value in the format the error gives"], humanAction: null },
  NO_SUCH_OPTION: { agentCanFix: true, fixSteps: ["nothing was selected; retry with one of the options listed in the error"], humanAction: null },
  EVAL_BLOCKED: {
    agentCanFix: false,
    fixSteps: ["use browser_inspect to read the element's attributes and state instead"],
    humanAction: "remove the domain from eval.blockedDomains in config/default.json if eval should run there",
  },
  EVAL_BLOCKED_BY_CSP: { agentCanFix: false, fixSteps: ["the page's Content-Security-Policy forbids eval; use browser_inspect instead"], humanAction: null },
  EVAL_FAILED: { agentCanFix: true, fixSteps: ["fix the expression (the error is the page's own)", "it must return JSON-serialisable data"], humanAction: null },
  STALE_BUILD: {
    agentCanFix: true,
    fixSteps: ["call agent_browser_ensure_running({restartIfStale:true})", "or run `npm run mcp:restart` in the agent-browser repo"],
    humanAction: null,
  },
  EXTENSION_STALE: {
    agentCanFix: false,
    fixSteps: ["stop and ask the user to reload the browser extension (one click); then retry"],
    humanAction: "press Reload on the Agent Bridge card at chrome://extensions in the agent browser",
  },
  TRUSTED_UNAVAILABLE: {
    agentCanFix: false,
    fixSteps: ["use the ordinary synthetic action (drop trusted:true)", "tell the user real input is not available"],
    humanAction: "grant Accessibility to Agent Browser Input once: npm run input-helper:install, then switch it on in System Settings → Privacy & Security → Accessibility",
  },
  BAD_REQUEST: { agentCanFix: true, fixSteps: ["fix the arguments as the error says"], humanAction: null },
  CAPTURE_FAILED: { agentCanFix: true, fixSteps: ["retry once", "if it repeats, call agent_browser_status"], humanAction: null },
  ENGINE_ERROR: { agentCanFix: true, fixSteps: ["retry once", "if it repeats, call agent_browser_status"], humanAction: null },
};

/** An error with a catalogue code and optional structured detail. */
export class AbError extends Error {
  constructor(
    public code: Code,
    message: string,
    public detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// Untagged errors, classified by the text the extension or Chrome produced.
const BY_TEXT: [RegExp, Code][] = [
  [/^HALTED/, "HALTED"],
  [/STALE_SNAPSHOT/, "STALE_SNAPSHOT"],
  [/REF_NOT_FOUND/, "REF_NOT_FOUND"],
  [/NO_SUCH_OPTION/, "NO_SUCH_OPTION"],
  [/INVALID_VALUE/, "INVALID_VALUE"],
  [/NO_SUCH_TAB|TAB_GONE|No tab with id/, "TAB_GONE"],
  [/NEEDS_HUMAN/, "NEEDS_HUMAN"],
  [/OCCLUDED/, "OCCLUDED"],
  [/NOT_ACTIONABLE/, "NOT_ACTIONABLE"],
  [/bridge not connected|BRIDGE_DROPPED|bridge request timeout/, "BRIDGE_DOWN"],
  [/EMPTY_REGION|readback|captureVisibleTab/i, "CAPTURE_FAILED"],
  // The server asked for something the extension does not know: it is older.
  [/unknown (engine )?method/, "EXTENSION_STALE"],
];

export function codeOf(e: unknown): Code {
  const c = (e as { code?: string })?.code;
  if (c && c in CATALOGUE) return c as Code;
  const msg = String((e as Error)?.message ?? e);
  for (const [re, code] of BY_TEXT) if (re.test(msg)) return code;
  return "ENGINE_ERROR";
}
