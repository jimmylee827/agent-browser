import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "../bridge/server.js";
import { evalBlockedBy, type Policy } from "../policy.js";
import { resolveKey, short, type Session, type SessionManager } from "../sessions.js";
import type { Audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import type { ClientInfo } from "../control.js";
import { hostHelper, launchBrowser } from "../host-helper-client.js";
import { AbError, CATALOGUE, codeOf, HALT_ADVICE, POLICY_ADVICE } from "../errors.js";
import { buildId, buildStatus, RUNNING } from "../build.js";
import { recordEvidence } from "../evidence.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export { HALT_ADVICE };

const DRY_RUN = process.env.AB_DRY_RUN === "1";

/**
 * Signature of "the document went away while our call was in flight".
 *
 * Chrome surfaces this when an action navigates: the click lands, the page is
 * torn down or pushed into the back/forward cache, and the async sendResponse
 * has nowhere to return to. For a state-changing call this means SUCCESS — the
 * action ran — so it must never be retried, or the action fires twice.
 *
 * Matched on the raw text as well as our own tagged error, because the string
 * can reach us from either the extension or the bridge.
 */
const PORT_DIED = /PORT_CLOSED_AFTER_ACTION|back\/forward cache|message channel (is )?closed|Receiving end does not exist/i;

interface Ctx {
  bridge: Bridge;
  policy: Policy;
  sessions: SessionManager;
  audit: Audit;
  cfg: AppConfig;
  client: ClientInfo;
  /** Clients already told that the build is stale (told once each). */
  warnedStale: Set<string>;
}

type Text = { type: "text"; text: string };
type Image = { type: "image"; data: string; mimeType: string };
type ToolResult = { content: (Text | Image)[]; isError?: true };

/** Split a data URL into MCP image content; null if not a data URL. */
function imageContent(dataUrl: unknown): Image | null {
  if (typeof dataUrl !== "string") return null;
  const m = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!m) return null;
  return { type: "image", data: m[2], mimeType: m[1] };
}

/**
 * What one tool call accumulates on its way to a result: things it could not
 * do (`degraded`, which a caller can carry into its final report), warnings,
 * images, and which session and tab it acted on.
 */
class Call {
  degraded: string[] = [];
  warnings: string[] = [];
  images: Image[] = [];
  extra: Record<string, unknown> = {};
  session?: Session;
  tabId?: number;
  constructor(public tool: string) {}
}

// The rules an agent must know to not damage anything. They go in each tool's
// own description: agents often load tools by name and never read the skill.
const SESSION_RULES =
  " Sessions: without `session`, your calls use your own browser window, private to this connection; " +
  "a subagent sharing your connection should pass its own `session` name. To work on one tab with another agent, " +
  "both pass session \"shared:<name>\" — then a reload or visit affects the other agent too. " +
  "Cookies and logins are shared by every session (one browser profile): a login in one is a login in all.";
const SESSION_ARG = z
  .string()
  .optional()
  .describe("Omit for your own private window. A name for a separate private one; \"shared:<name>\" to share a tab with other agents; \"default\" = old behaviour (whatever tab is focused).");
const TAB_ARG = z
  .number()
  .int()
  .optional()
  .describe("Adopt this existing tab (an id from browser_tabs) for your session. Only when you mean to act on a tab you did not open.");

/**
 * MCP tool surface, split into two tiers:
 *
 *   1. HIGH-LEVEL intent tools (preferred): `agent_browser_visit` reads a page,
 *      `agent_browser_act` does something on it. Each handles locate → act →
 *      settle → re-observe end-to-end, so agents never track refs themselves.
 *
 *   2. [ADVANCED] primitive tools (`browser_*`) for fine-grained control.
 *      Most agents shouldn't need these.
 *
 * Registration touches nothing on ctx: the launcher lists the tools with a stub.
 */
export function registerTools(server: McpServer, ctx: Ctx): void {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ============================================================
  // Results
  // ============================================================

  /** Tell a client, once, that it is talking to stale code. */
  const staleNotice = (): Record<string, unknown> => {
    if (ctx.warnedStale.has(ctx.client.id)) return {};
    const b = buildStatus();
    const launcher = ctx.client.launcherBuild;
    const launcherStale = !!launcher && launcher !== "unknown" && launcher !== buildId(RUNNING);
    if (!b.staleBuild && !b.sourceNewerThanBuild && !launcherStale) return {};
    ctx.warnedStale.add(ctx.client.id);
    return {
      staleBuild: b.staleBuild,
      build: {
        ...b,
        ...(launcherStale
          ? { launcher, launcherWarning: "this client's tool list comes from an older build: reconnect the agent-browser MCP server (/mcp) to get the current tools" }
          : {}),
      },
    };
  };

  const ok = (call: Call, data: Record<string, unknown>): ToolResult => {
    const { warning, ...rest } = data as { warning?: string };
    const warnings = [...(warning ? [warning] : []), ...call.warnings];
    const body = {
      ...rest,
      ...call.extra,
      ...(warnings.length ? { warning: warnings.join(" | ") } : {}),
      degraded: call.degraded,
      ...staleNotice(),
    };
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }, ...call.images] };
  };

  const logTail = (): string | null => {
    try {
      return readFileSync(resolve(ctx.cfg.stateDir, "mcp-server.err.log"), "utf8").trim().split("\n").slice(-20).join("\n");
    } catch {
      return null;
    }
  };

  /** Every failure: a code to branch on, steps, and who has to act. */
  const failure = async (call: Call, e: unknown): Promise<ToolResult> => {
    const code = codeOf(e);
    const entry = CATALOGUE[code];
    const message = String((e as Error)?.message ?? e);
    const { recovery, ...detail } = ((e as { detail?: Record<string, unknown> }).detail ?? {}) as { recovery?: string };
    // The session's tab is gone for good; forget it, so the next visit opens a new one.
    if (code === "TAB_GONE" && call.session && !call.session.legacy) ctx.sessions.unbind(call.session);
    // A human has to see what blocks the page: show them, and the agent.
    if (code === "NEEDS_HUMAN" && !call.images.length) {
      const shot = (await ctx.bridge.request("engine.captureViewport", call.tabId !== undefined ? { tabId: call.tabId } : {}).catch(() => null)) as { screenshot?: string } | null;
      const img = imageContent(shot?.screenshot);
      if (img) call.images.push(img);
    }
    const body = {
      code,
      reason: code.toLowerCase(),
      error: message,
      recovery: recovery ?? entry.fixSteps.join("; then "),
      agentCanFix: entry.agentCanFix,
      fixSteps: entry.fixSteps,
      humanAction: entry.humanAction,
      logTail: code === "BRIDGE_DOWN" ? logTail() : null,
      ...(code === "HOVER_NOT_EFFECTIVE" ? { acted: false } : {}),
      ...detail,
      ...call.extra,
      ...(call.warnings.length ? { warning: call.warnings.join(" | ") } : {}),
      degraded: [...call.degraded, `${call.tool} not done: ${code}${(detail as { needsHuman?: { reason?: string } }).needsHuman?.reason ? ` (${(detail as { needsHuman: { reason: string } }).needsHuman.reason})` : ""}`],
      ...staleNotice(),
    };
    return { isError: true, content: [{ type: "text", text: JSON.stringify(body, null, 2) }, ...call.images] };
  };

  /** Register a tool whose handler returns data or throws; the envelope is added here. */
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: S,
    handler: (args: z.objectOutputType<S, z.ZodTypeAny>, call: Call) => Promise<Record<string, unknown> | ToolResult>,
  ) {
    server.tool(name, description, schema, (async (args: z.objectOutputType<S, z.ZodTypeAny>) => {
      const call = new Call(name);
      try {
        const data = await ctx.sessions.track(ctx.client.id, () => handler(args, call));
        return "content" in data && Array.isArray(data.content) ? data : ok(call, data as Record<string, unknown>);
      } catch (e) {
        return failure(call, e);
      }
    }) as never);
  }

  // ============================================================
  // Sessions and tabs
  // ============================================================

  interface Scope {
    s: Session;
    req: <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  }

  /**
   * The session a call belongs to and the tab it may act on. `need`:
   *   tab  — the session must already have a tab (or be the legacy session);
   *   open — a navigation, which opens the session's window when it has none.
   */
  function scope(call: Call, args: { session?: string; tabId?: number; lock?: boolean; leaseMs?: number }, need: "tab" | "open"): Scope {
    const r = resolveKey(ctx.client.id, args.session);
    const s = ctx.sessions.get(r, ctx.client.id);
    call.session = s;
    if (args.lock === false) ctx.sessions.releaseLease(s, ctx.client.id);
    if (args.lock) ctx.sessions.takeLease(s, ctx.client.id, args.leaseMs ?? 120_000);
    else ctx.sessions.checkLease(s, ctx.client.id);
    if (s.legacy)
      call.warnings.push(
        "session \"default\" acts on whichever tab is focused — which other agents and the user also use. Omit `session` to get a window of your own",
      );
    // A client that does not name itself (a launcher from before sessions,
    // or a bare HTTP client) cannot be told apart from any other such one:
    // they all share one window. Say so on every call, with the fix.
    else if (ctx.client.id === "anonymous")
      call.warnings.push(
        "this connection does not identify itself (an agent-browser launcher older than this server, or a plain HTTP client), so it shares one window with every other such connection. Reconnect the agent-browser MCP server (/mcp) to get a window of your own",
      );
    if (args.tabId !== undefined && args.tabId !== s.tabId) {
      const owner = ctx.sessions.ownerOfTab(args.tabId);
      if (owner && owner !== s)
        throw new AbError("TAB_OWNED_BY_OTHER", `tab ${args.tabId} belongs to another session (${owner.shared ? owner.label : "a private session"})`);
      if (s.legacy) call.tabId = args.tabId;
      else ctx.sessions.bind(s, args.tabId);
    }
    if (!s.legacy) call.tabId = s.tabId;
    if (need === "tab" && !s.legacy && s.tabId === undefined)
      throw new AbError("NO_SESSION_TAB", "this session has no page yet — nothing to act on", {
        recovery: "call agent_browser_visit({url}) first (it opens this session's own window), or pass tabId to adopt an existing tab",
      });
    const req = <T,>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number) =>
      ctx.bridge.request<T>(method, call.tabId !== undefined ? { ...params, tabId: call.tabId } : params, timeoutMs);
    return { s, req };
  }

  type Ping = {
    tab?: { id?: number; url?: string; title?: string; status?: string; windowId?: number; navCount?: number };
    engine?: { error?: string; title?: string; documentGeneration?: string };
  };

  /**
   * Shared sessions: say who else acted since this caller's last call, before
   * it acts on a page that may no longer be what it saw.
   */
  async function shareCheck(call: Call, sc: Scope): Promise<void> {
    const s = sc.s;
    if (!s.shared) {
      ctx.sessions.touch(s, ctx.client.id);
      return;
    }
    const p = (await sc.req<Ping>("engine.ping").catch(() => ({}) as Ping));
    const page = { navCount: p.tab?.navCount, docGen: p.engine?.documentGeneration };
    const foreign = ctx.sessions.touch(s, ctx.client.id, page);
    call.extra.sharedSession = { session: s.label, ...(foreign ?? { lastActor: "you" }) };
    if (foreign)
      call.warnings.push(
        `another client (${foreign.lastActor}) acted on this shared tab ${Math.round(foreign.actedAgoMs / 1000)}s ago` +
          (foreign.changedSinceYourLastCall?.navigations ? `, and the page navigated ${foreign.changedSinceYourLastCall.navigations} time(s)` : "") +
          ": what you saw before may be gone. Look again (browser_observe) before acting, or use your own session",
      );
  }

  /** After the call: remember what this client saw, so its next call can be told what changed. */
  async function seen(sc: Scope): Promise<void> {
    if (!sc.s.shared) return;
    const p = (await sc.req<Ping>("engine.ping").catch(() => ({}) as Ping));
    const at = sc.s.lastSeen.get(ctx.client.id);
    sc.s.lastSeen.set(ctx.client.id, { at: Date.now(), navCount: p.tab?.navCount ?? at?.navCount, docGen: p.engine?.documentGeneration ?? at?.docGen });
  }

  /** Run fn under the session's lock, with the shared-tab check before and the record after. */
  async function inSession<T>(call: Call, sc: Scope, fn: () => Promise<T>): Promise<T> {
    return ctx.sessions.withLock(sc.s.key, async () => {
      await shareCheck(call, sc);
      try {
        return await fn();
      } finally {
        await seen(sc);
      }
    });
  }

  const evidenceDir = (s: Session) => (s.shared ? s.key : `${short(ctx.client.id)}${s.label === "(private)" ? "" : `-${s.label}`}`);

  // ============================================================
  // Browser up
  // ============================================================

  /** Is a Chrome running on the agent profile? (Unknown counts as yes.) */
  const agentChromeRunning = () => {
    try {
      // No leading "--" in the pattern: pgrep would read it as an option.
      execFileSync("pgrep", ["-f", `user-data-dir=${ctx.cfg.profileDir}`], { stdio: "ignore" });
      return true;
    } catch (e) {
      return (e as { status?: number }).status !== 1; // 1 = no match
    }
  };

  /**
   * Bring the browser up if the bridge isn't connected. Shared by every tool
   * that needs a live browser so the launch path and its advice exist once.
   */
  async function ensureBrowser(timeoutMs: number): Promise<{ already: boolean; launchedVia?: string; waitedMs?: number }> {
    if (ctx.bridge.connected()) return { already: true };
    // The worker may just be reconnecting (browser starting, extension
    // reloaded). Give it a moment before concluding nothing is there — but
    // only if the agent Chrome is running at all; otherwise there is nothing
    // to wait for, and the wait only delayed every cold start by 8s.
    if (agentChromeRunning() && (await ctx.bridge.waitForConnection(8_000))) return { already: true };
    if (existsSync(resolve(ctx.cfg.stateDir, "HALT"))) throw new AbError("HALTED", "HALTED: kill switch active");
    const launchedVia = await launchBrowser();
    ctx.audit.log("browser.launch", { via: launchedVia });
    const t0 = Date.now();
    if (await ctx.bridge.waitForConnection(timeoutMs)) return { already: false, launchedVia, waitedMs: Date.now() - t0 };
    throw new AbError("BRIDGE_DOWN", `agent browser did not connect within ${timeoutMs}ms (launched via ${launchedVia})`, {
      recovery:
        "if Chrome opened, the extension needs loading once (a human step: chrome://extensions → Load unpacked → packages/extension); " +
        "if it did not, run `npm run launch` in the agent-browser repo and read its output",
    });
  }

  // ============================================================
  // Page helpers
  // ============================================================

  /**
   * Recovery advice for a lookup that found nothing: say what IS there. Pages
   * change an element's role under you (Wikipedia's search box turns from
   * searchbox into combobox once its suggestions open), and a bare "no
   * element" hides that.
   */
  const suggest = async (sc: Scope, name: string, role?: string): Promise<string> => {
    const near = async (q: { role?: string; name?: string }) =>
      ((await sc.req("engine.locate", q).catch(() => ({}))) as { matches?: { role: string; name: string }[] }).matches ?? [];
    let similar = role && name ? await near({ name }) : [];
    // Listing every element of the role only helps when no name was given;
    // with one, it was just the first five buttons on the page.
    if (!similar.length && role && !name) similar = await near({ role });
    if (!similar.length && name) {
      const word = name.split(/\s+/).sort((a, b) => b.length - a.length)[0];
      if (word && word.length >= 3 && word !== name) similar = await near({ name: word });
    }
    if (similar.length)
      return `similar elements: ${similar.slice(0, 5).map((m) => `${m.role} "${m.name}"`).join(", ")} — retry with one of those`;
    return role
      ? `nothing with role ${role} on this page matches; drop role, use a shorter name, or call browser_observe to see what is there`
      : "call agent_browser_visit to refresh the page snapshot, OR widen the name to a less specific substring";
  };

  type Match = { ref: number; role: string; name: string };
  type Located = { snapshotGeneration?: number; matches?: Match[] };

  /** Find one element by role/name, or fail with what is there instead. */
  async function locateOne(sc: Scope, name: string | undefined, role: string | undefined): Promise<Match & { gen?: number }> {
    const loc = await sc.req<Located>("engine.locate", { role, name });
    const m = loc.matches?.[0];
    if (!m) {
      const url = ((await sc.req<Ping>("engine.ping").catch(() => ({}) as Ping)).tab?.url) ?? "";
      throw new AbError("NO_MATCH", `no element matching role=${role ?? "any"} name="${name ?? ""}"${url ? ` on ${url}` : ""}`, {
        recovery: await suggest(sc, name ?? "", role),
      });
    }
    return { ...m, gen: loc.snapshotGeneration };
  }

  type Snap = Record<string, unknown> & {
    url?: string;
    tree?: unknown[];
    screenshot?: string;
    needsHuman?: { reason: string; agentCanFix: boolean; node?: { name?: string; ref?: number }; dismiss?: { ref: number; name: string; disabled?: boolean } };
  };
  type SnapshotSize = "full" | "viewport" | "none";

  const ping = (sc: Scope) => sc.req<Ping>("engine.ping");

  /** The page's own title: Chrome shows the URL as the tab title when a page
   *  has none, which disagreed with what observe reported. */
  const brief = async (sc: Scope): Promise<Snap> => {
    const p = await ping(sc);
    return { url: p.tab?.url, title: p.engine?.title ?? p.tab?.title };
  };
  const observeAs = async (sc: Scope, size: SnapshotSize, details = false): Promise<Snap> => {
    if (size !== "none") return sc.req<Snap>("engine.observe", { mode: "semantic", viewportOnly: size === "viewport", details });
    // No tree, but a wall is still reported: an agent keeping its results
    // small must still learn that a captcha stands in its way.
    const [b, w] = await Promise.all([brief(sc), sc.req<{ needsHuman?: Snap["needsHuman"] }>("engine.detectWall").catch(() => null)]);
    if (!w?.needsHuman) return b;
    const shot = w.needsHuman.reason === "captcha" ? await sc.req<{ screenshot?: string }>("engine.captureViewport").catch(() => null) : null;
    return { ...b, outcome: "needs_human", needsHuman: w.needsHuman, ...(shot?.screenshot ? { screenshot: shot.screenshot } : {}) };
  };

  /**
   * Wait for the page: first DOM/network quiet, then layout and animations.
   * Says when it gave up, so nobody mistakes a page mid-change for its result.
   */
  async function settlePage(call: Call, sc: Scope, quietMs = 600, timeout = 8000): Promise<{ settled: boolean; settleMs?: number; reason?: string }> {
    await sc.req("engine.waitForStable", { timeout, quietMs }).catch(() => {});
    const r = await sc.req<{ settled: boolean; settleMs?: number; reason?: string }>("engine.settle", { maxMs: 2500 }).catch(() => null);
    if (r && !r.settled) call.warnings.push(`the page was still changing (${r.reason}): wait (browser_wait) before relying on its layout`);
    return r ?? { settled: false, reason: "the page did not answer" };
  }

  const snapshotOption = z
    .enum(["full", "viewport", "none"])
    .default("full")
    .describe("What the snapshot holds: full (default), viewport (only what is on screen — much smaller), none (just url and title)");

  /**
   * Add the page's visible text to a snapshot when asked, and always when the
   * tree is empty — a JSON response or a page of prose has nothing to click,
   * and an empty tree with no hint left agents stuck.
   */
  const attachText = async (sc: Scope, snap: Snap, wanted: boolean): Promise<Snap> => {
    const empty = Array.isArray(snap.tree) && snap.tree.length === 0;
    if (!wanted && !empty) return snap;
    const r = (await sc.req("engine.observe", { mode: "read" }).catch(() => null)) as {
      text?: string;
      truncated?: boolean;
      nextOffset?: number;
    } | null;
    if (!r) return snap;
    return {
      ...snap,
      ...(empty && !wanted ? { hint: "nothing interactive on this page; its text is included" } : {}),
      text: r.text,
      ...(r.truncated
        ? { textTruncated: true, textNextOffset: r.nextOffset, textHint: "more text: browser_observe({mode:\"read\", offset: textNextOffset})" }
        : {}),
    };
  };

  /** A wall on the page: say so in the result, show it, and tell the agent what next. */
  const reportWall = (call: Call, snap: Snap): Snap => {
    const img = imageContent(snap.screenshot);
    if (img) call.images.push(img);
    const { screenshot: _s, ...rest } = snap;
    const w = snap.needsHuman;
    if (!w) return rest;
    if (w.agentCanFix && w.dismiss)
      call.warnings.push(`a notice covers the page; dismiss it first: agent_browser_act({ref: ${w.dismiss.ref}}) ("${w.dismiss.name}")`);
    else {
      call.warnings.push(
        `a human is needed: ${w.reason === "captcha" ? "a captcha" : "a notice that cannot be accepted yet"} blocks this page. ` +
          "Stop, tell the user, and do not report the page as empty or as having no results",
      );
      call.degraded.push(`page blocked by ${w.reason}${w.node?.name ? `: ${w.node.name}` : ""} — needs a human`);
    }
    return rest;
  };

  /** One line on anything that went wrong in the page since `since`. */
  async function diagSummary(sc: Scope, since: number): Promise<string | undefined> {
    const d = await sc
      .req<{ network?: { url: string; status?: number; error?: string }[]; console?: { level: string }[]; media?: unknown[] }>("engine.diagnostics", { since })
      .catch(() => null);
    if (!d) return undefined;
    const parts: string[] = [];
    const net = d.network ?? [];
    if (net.length) {
      const path = (u: string) => {
        try {
          const x = new URL(u);
          return x.pathname.length > 40 ? `…${x.pathname.slice(-40)}` : x.pathname;
        } catch {
          return u.slice(0, 40);
        }
      };
      const shown = net.slice(0, 3).map((n) => `${path(n.url)} ${n.status ?? n.error}`).join(", ");
      parts.push(`${net.length} failed request${net.length > 1 ? "s" : ""} (${shown}${net.length > 3 ? ", …" : ""})`);
    }
    const errors = (d.console ?? []).filter((c) => c.level === "error").length;
    const warns = (d.console ?? []).filter((c) => c.level === "warn").length;
    if (errors) parts.push(`${errors} console error${errors > 1 ? "s" : ""}`);
    if (warns) parts.push(`${warns} console warning${warns > 1 ? "s" : ""}`);
    if (d.media?.length) parts.push(`${d.media.length} media load failure${d.media.length > 1 ? "s" : ""}`);
    return parts.length ? `${parts.join(", ")} — details: browser_diagnostics` : undefined;
  }

  /** A viewport image and a record on disk, to cite later. */
  async function evidence(sc: Scope, tool: string, info: { url?: unknown; title?: unknown; [k: string]: unknown }, image?: string) {
    if (!ctx.cfg.evidence.enabled) return undefined;
    let img = image;
    if (!img) img = ((await sc.req<{ screenshot?: string }>("engine.captureViewport").catch(() => null))?.screenshot) ?? undefined;
    const e = recordEvidence(ctx.cfg, evidenceDir(sc.s), { tool, ...info, url: String(info.url ?? ""), title: String(info.title ?? "") }, img);
    if (e) ctx.audit.log("evidence", { tool, file: e.file });
    return e;
  }

  /** The first password typed on a host is worth a word: this profile keeps everything. */
  function passwordHostWarning(host: string): string | undefined {
    const file = resolve(ctx.cfg.stateDir, "password-hosts.json");
    let hosts: string[] = [];
    try {
      hosts = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
    if (hosts.includes(host)) return undefined;
    try {
      writeFileSync(file, JSON.stringify([...hosts, host], null, 2));
    } catch {}
    return (
      `first password typed on ${host} in this browser profile. The profile is persistent and shared by every session: ` +
      "a login here stays logged in for all agents, and the profile keeps it. Use a test account you are willing to leave there"
    );
  }

  /**
   * Navigate the session's tab — opening the session's window when it has
   * none — and wait until the NEW document has committed and answers.
   * Committing is counted, not guessed from the host name: a route change on
   * the same host used to pass the check at once, and the snapshot that came
   * back was of the page being left.
   */
  async function navigateAndWait(call: Call, sc: Scope, nav: { url?: string; history?: "back" | "forward" | "reload" }, timeoutMs: number) {
    const s = sc.s;
    let before = 0;
    let beforeUrl = "";
    if (!s.legacy && s.tabId === undefined) {
      if (!nav.url) throw new AbError("NO_SESSION_TAB", "this session has no page yet — there is no history to move through");
      const w = await ctx.bridge.request<{ tabId: number; windowId: number }>("engine.openSessionWindow", { url: nav.url });
      ctx.sessions.bind(s, w.tabId, w.windowId);
      call.tabId = w.tabId;
      call.extra.openedWindow = { tabId: w.tabId, windowId: w.windowId, hint: "this session's own window, opened in the background" };
      ctx.audit.log("session.open_window", { session: s.key.slice(0, 12), tabId: w.tabId });
    } else {
      const p = await ping(sc).catch(() => ({}) as Ping);
      before = p.tab?.navCount ?? 0;
      beforeUrl = p.tab?.url ?? "";
      const r = await sc.req<{ tabId?: number }>("engine.navigate", nav.url ? { url: nav.url } : { action: nav.history });
      // The legacy session learns which tab the navigation went to.
      if (s.legacy && r.tabId !== undefined) call.tabId = r.tabId;
    }
    const t0 = Date.now();
    let last: Ping = {};
    while (Date.now() - t0 < timeoutMs) {
      await sleep(300);
      last = await ping(sc).catch(() => ({}) as Ping);
      if (last.engine?.error || !last.tab) continue;
      if ((last.tab.navCount ?? 0) > before) return { landed: true, from: beforeUrl, to: last.tab.url };
    }
    return { landed: false, from: beforeUrl, to: last.tab?.url, error: last.engine?.error };
  }

  // ============================================================
  // HIGH-LEVEL INTENT TOOLS — preferred for AI agents
  // ============================================================

  /** The extension that is connected, against the one on disk. */
  const extensionStatus = () => {
    if (!ctx.bridge.connected()) return {};
    let onDisk = "";
    try {
      onDisk = JSON.parse(readFileSync(resolve(ctx.cfg.extensionDir, "manifest.json"), "utf8")).version;
    } catch {}
    const running = ctx.bridge.extension?.version ?? "unknown (older than 0.0.5)";
    const stale = !!onDisk && running !== onDisk;
    return {
      extension: {
        running,
        onDisk,
        ...(stale ? { stale: true, humanAction: "press Reload on the Agent Bridge card at chrome://extensions (once)" } : {}),
      },
    };
  };

  tool(
    "agent_browser_status",
    [
      "Status of the persistent agent browser (stealth Chrome + extension bridge): whether the bridge is ",
      "connected, which build the server runs versus the one on disk (staleBuild + the restart command when ",
      "they differ), this connection's sessions and their tabs, host-helper reachability. No side effects.",
    ].join(""),
    {},
    async () => {
      const helperUp = hostHelper.available() ? await hostHelper.health() : false;
      const bridgeConnected = ctx.bridge.connected();
      const b = buildStatus();
      const launcher = ctx.client.launcherBuild;
      const mine = ctx.sessions
        .all()
        .filter((s) => s.ownerClient === ctx.client.id || s.lastSeen.has(ctx.client.id))
        .map((s) => ({ session: s.label, shared: s.shared, tabId: s.tabId ?? null, windowId: s.windowId ?? null }));
      return {
        serverRunning: true, // answering at all means it is (the launcher reports false)
        bridgeConnected,
        ready: bridgeConnected && !b.staleBuild,
        build: {
          ...b,
          ...(launcher && launcher !== buildId(RUNNING) && launcher !== "unknown"
            ? { launcher, launcherWarning: "this client's tool list comes from an older build: reconnect the agent-browser MCP server (/mcp)" }
            : {}),
        },
        staleBuild: b.staleBuild,
        ...extensionStatus(),
        sessions: mine,
        hostHelperReachable: helperUp,
      };
    },
  );

  tool(
    "agent_browser_ensure_running",
    [
      "Make sure the stealth Chrome + extension are running and the bridge is connected, launching the ",
      "browser if needed (via the host helper when it is running, otherwise directly). Idempotent. ",
      "restartIfStale:true also restarts the browser server when it runs an older build than the one on disk. ",
      "If this fails, tell the user in one sentence and record the step as not done.",
    ].join(""),
    {
      timeoutMs: z.number().int().default(45_000),
      restartIfStale: z.boolean().default(false).describe("Restart the server if agent_browser_status reports staleBuild"),
    },
    async ({ timeoutMs, restartIfStale }) => {
      if (restartIfStale && buildStatus().staleBuild) {
        const others = ctx.sessions.othersRunning(ctx.client.id);
        if (others > 0)
          throw new AbError("STALE_BUILD", `not restarting: ${others} call(s) from other agents are in progress`, {
            recovery: "retry in a few seconds",
          });
        ctx.audit.log("mcp.restart_stale", { from: buildId(RUNNING) });
        // A non-zero exit makes launchd start it again; without launchd the
        // launcher starts it on the next call.
        setTimeout(() => process.exit(75), 300).unref();
        return { restarting: true, from: buildId(RUNNING), to: buildStatus().onDisk, hint: "call agent_browser_ensure_running again in a few seconds" };
      }
      const r = await ensureBrowser(timeoutMs);
      return r.already
        ? { already: true, bridgeConnected: true, ...(buildStatus().staleBuild ? { staleBuild: true } : {}) }
        : { launched: true, launchedVia: r.launchedVia, bridgeConnected: true, waitedMs: r.waitedMs };
    },
  );

  tool(
    "agent_browser_visit",
    [
      "Open a URL — or go back / forward / reload — in your session's own browser window, wait for it to settle, ",
      "and return a compact accessibility-tree snapshot of the links, buttons, fields and headings. The first visit ",
      "of a session opens its window (in the background). Pass text:true to also get the page's visible text. ",
      "If a captcha or notice blocks the page, the result says outcome:\"needs_human\" — stop and tell the user; do not ",
      "report the page as empty. Failed requests and console errors since the call started are summarised in `diagnostics`. ",
      "Auto-ensures the browser is running.",
      SESSION_RULES,
    ].join(""),
    {
      url: z.string().url().optional().describe("Page to open. Give this or `history`."),
      history: z.enum(["back", "forward", "reload"]).optional().describe("Move through this tab's history instead of opening a URL."),
      text: z.boolean().default(false).describe("Also return the page's visible text (first 8000 chars; the result says how to page on)."),
      snapshot: snapshotOption.describe("Tree size: full (default), viewport (only what is on screen), none (no tree — with text:true, just the text)"),
      details: z.boolean().default(false).describe("Also give each link's href and each image's or video's src in the tree"),
      session: SESSION_ARG,
      tabId: TAB_ARG,
      lock: z.boolean().optional().describe("Shared sessions: true takes (or renews) a lease so other clients cannot act until it ends; false releases it"),
      leaseMs: z.number().int().min(1000).max(600_000).optional(),
    },
    async ({ url, history, text, snapshot, details, session, tabId, lock, leaseMs }, call) => {
      if (!url === !history) throw new AbError("BAD_REQUEST", "give exactly one of url or history", { recovery: "e.g. {url:\"https://…\"} or {history:\"back\"}" });
      await ensureBrowser(45_000);
      const sc = scope(call, { session, tabId, lock, leaseMs }, url ? "open" : "tab");
      // Navigation is read-only and unrestricted — any URL is fair game. The
      // sensitive-action gate lives in agent_browser_act, and only for the
      // action classes a caller explicitly labels.
      return inSession(call, sc, async () => {
        const t0 = Date.now();
        const nav = await navigateAndWait(call, sc, url ? { url } : { history }, url ? 15_000 : 10_000);
        if (!nav.landed) {
          if (history)
            throw new AbError("NAV_TIMEOUT", `${history} did not change the page (still on ${nav.from})`, {
              recovery: `there may be no ${history === "back" ? "earlier" : "later"} page in this tab's history; open the page with agent_browser_visit({url}) instead`,
            });
          throw new AbError("NAV_TIMEOUT", `navigation to ${url} did not commit${nav.error ? `: ${nav.error}` : ""}`, {
            recovery: "retry, or call agent_browser_status to check the bridge",
          });
        }
        const settled = await settlePage(call, sc);
        const snap = reportWall(call, await attachText(sc, await observeAs(sc, snapshot, details), text));
        const diagnostics = await diagSummary(sc, t0);
        const ev = await evidence(sc, "visit", { url: snap.url, title: snap.title, ...(history ? { history } : {}) });
        ctx.audit.log("tool.agent_browser_visit", { ...(history ? { history, from: nav.from } : { url }), to: snap.url, tabId: call.tabId, ...(ev ? { evidence: ev.file } : {}) });
        return {
          ...snap,
          tabId: call.tabId,
          ...(settled.settled ? {} : { settled: false, settleReason: settled.reason }),
          ...(diagnostics ? { diagnostics } : {}),
          ...(ev ? { evidence: ev } : {}),
        };
      });
    },
  );

  const ACTIONS = ["click", "type", "fill", "clear", "press", "hover", "focus", "check", "uncheck", "submit", "select", "drag"] as const;
  const AT = z
    .object({ x: z.union([z.number(), z.string()]), y: z.union([z.number(), z.string()]) })
    .partial()
    .describe("A point inside the element: px from its top-left, or percentages like {x:\"25%\", y:\"50%\"}. Default: its centre");

  tool(
    "agent_browser_act",
    [
      "DO an action on your session's page by accessible name — click a button, type into an input, submit a form, ",
      "hover, or drag (a slider, a scrubber, a list item: action \"drag\" with `to`). Finds the first matching element ",
      "(role + name), performs the action, waits for the page to settle, and returns the post-action snapshot. ",
      "No ref bookkeeping needed. If the action changed nothing, the result says so (noEffect + warning); a hover that ",
      "changes nothing fails with HOVER_NOT_EFFECTIVE rather than claiming success. Events are synthetic (no CDP). ",
      "Failures carry a `code` (NEEDS_HUMAN, OCCLUDED, NO_MATCH, …) and `fixSteps`. ",
      "Policy-gated; sensitive actions on untrusted domains escalate.",
      SESSION_RULES,
    ].join(""),
    {
      name: z.string().optional().describe("Accessible name (button label, link text, input placeholder/label) — case-insensitive substring match"),
      role: z.string().optional().describe("Optional role filter: button, link, textbox, checkbox, combobox, slider, video… Recommended when the name is ambiguous."),
      ref: z.number().int().optional().describe("Or: a ref from the latest snapshot, instead of name/role"),
      action: z
        .enum(ACTIONS)
        .default("click")
        .describe("click (default) | type (append text) | fill (replace text) | clear | press (key, value=key; Enter in a form field submits it) | hover | focus | check | uncheck | submit | select (dropdown; value = option text or value) | drag (needs `to`)"),
      value: z.string().optional().describe("Required for type/fill/press/select; for press it's the key (e.g. \"Enter\")"),
      at: AT.optional(),
      to: z
        .object({ name: z.string().optional(), role: z.string().optional(), ref: z.number().int().optional(), x: z.number().optional(), y: z.number().optional() })
        .optional()
        .describe("drag: where to drop — an element (name/role/ref) or a point {x,y} in viewport CSS pixels"),
      toAt: AT.optional().describe("drag: the point inside the `to` element (default its centre)"),
      steps: z.number().int().min(1).max(100).default(10).describe("drag: how many pointer moves between start and end"),
      holdMs: z.number().int().min(0).max(5000).default(0).describe("drag: pause after pressing, before moving"),
      snapshot: snapshotOption.describe(
        "What snapshotAfter holds: full (default), viewport (only what is on screen — much smaller), none (just url and title; use for a run of fills)",
      ),
      onDialog: z
        .enum(["accept", "dismiss"])
        .default("accept")
        .describe("How to answer a confirm/prompt box this action raises: accept (OK, the default) or dismiss (Cancel). Boxes that appeared are listed in `dialogs`."),
      dialogText: z.string().optional().describe("The answer to type into a prompt box, if one appears"),
      actionClass: z
        .string()
        .optional()
        .describe("Optional label for consequential actions: payment | delete_destructive | credential_entry | file_upload. Labelled actions need a trusted domain; everything else runs freely."),
      robust: z
        .enum(["auto", "always", "never"])
        .default("auto")
        .describe(
          "Dead-click handling for action=click. auto (default): if the click provably did nothing, retry in the page's own JS world (handles React fiber handlers, unhydrated listeners, focus-gated effects). always: skip straight to it. never: for non-idempotent buttons where a double-fire would be harmful.",
        ),
      session: SESSION_ARG,
      tabId: TAB_ARG,
      lock: z.boolean().optional().describe("Shared sessions: true takes (or renews) a lease so other clients cannot act until it ends; false releases it"),
      leaseMs: z.number().int().min(1000).max(600_000).optional(),
    },
    async (args, call) => {
      const { name, role, ref, action, value, at, to, toAt, steps, holdMs, actionClass, robust, snapshot, onDialog, dialogText } = args;
      if (existsSync(resolve(ctx.cfg.stateDir, "HALT"))) throw new AbError("HALTED", "HALTED: kill switch active");
      if (name === undefined && role === undefined && ref === undefined)
        throw new AbError("BAD_REQUEST", "say which element: name (and optionally role), or ref");
      if (action === "drag" && !to) throw new AbError("BAD_REQUEST", "drag needs `to`: an element {name, role} or {ref}, or a point {x, y}");
      await ensureBrowser(45_000);
      const sc = scope(call, args, "tab");

      return inSession(call, sc, async () => {
        const t0 = Date.now();
        // Policy gate: only fires for an explicitly labelled sensitive class.
        // A plain click/type/submit is an ordinary action anywhere on the web.
        const tabBefore = (await ping(sc)).tab;
        const tabUrl = tabBefore?.url ?? "";
        const d = ctx.policy.evaluate({ url: tabUrl, actionClass });
        if (!d.allow) {
          ctx.audit.log("policy.block", { tool: "agent_browser_act", url: tabUrl, action, reason: d.reason });
          throw new AbError("POLICY_BLOCKED", `blocked by policy: ${d.reason}`, { recovery: POLICY_ADVICE });
        }
        if (DRY_RUN) return { dryRun: true, wouldAct: { action, name, role, value }, currentUrl: tabUrl, policy: d.reason };

        // 1. Locate. For a drag, the drop target is found by the engine in
        //    the same pass as the action: a second lookup from here could
        //    re-index the page and renumber this one's ref.
        const match: Match & { gen?: number } = ref !== undefined ? { ref, role: role ?? "", name: name ?? "" } : await locateOne(sc, name, role);
        const toLocator = to && (to.name !== undefined || to.role !== undefined) ? { name: to.name, role: to.role } : undefined;

        // 2. Act with the just-located ref + matching generation.
        //
        // A click that navigates tears down the document it ran in, so the
        // engine's reply can be lost to a closed port. That is SUCCESS, not
        // failure — the SW distinguishes it (PORT_CLOSED_AFTER_ACTION) rather
        // than retrying, which would fire the action a second time.
        type ActResult = {
          acted?: boolean;
          changed?: boolean;
          signals?: Record<string, unknown>;
          dialogs?: unknown[];
          credentialStoreBlocked?: unknown[];
          passwordField?: boolean;
          host?: string;
          [k: string]: unknown;
        };
        let result: ActResult;
        try {
          result = await sc.req<ActResult>("engine.act", {
            ref: match.ref,
            gen: ref !== undefined ? undefined : match.gen,
            action,
            value,
            onDialog,
            dialogText,
            ...(action === "drag"
              ? { at, toRef: to?.ref, toLocator, toAt, toPoint: to?.x !== undefined && to?.y !== undefined ? { x: to.x, y: to.y } : undefined, steps, holdMs }
              : {}),
          });
        } catch (e) {
          if (!PORT_DIED.test((e as Error).message)) throw e;
          ctx.audit.log("act.navigated_mid_action", { name, role, action, url: tabUrl });
          result = { acted: true, changed: true, signals: { navigated: true, portClosed: true } };
        }

        // 2b. Dead-click escalation. Modern SPA buttons routinely ignore a
        // synthetic click from an isolated world: the handler is a React
        // fiber prop, or the effect is gated on the tab being focused, or
        // the listener isn't attached yet because hydration hasn't finished.
        // `engine.robustClick` runs in the PAGE's own JS world and works
        // through those cases (hydration wait → focus spoof → authentic
        // pointer sequence → native click → fiber onClick → formAction).
        //
        // Only escalate when the first click provably did NOTHING, and
        // re-check after a beat first — a slow handler that already fired
        // must not be clicked twice (double-submit, double-purchase).
        let escalated: "none" | "robust" = "none";
        if (action === "click" && robust !== "never") {
          let dead = robust === "always";
          if (robust === "auto" && result.changed === false) {
            await sleep(700);
            const recheck = await ping(sc);
            // A pending navigation hasn't changed the URL yet but proves the
            // click landed — treating that as dead would fire it twice. So does
            // a tab it opened (target=_blank): the page it ran in is unchanged.
            const navigating = recheck.tab?.status === "loading";
            const openedTab =
              tabBefore?.id !== undefined &&
              (await ctx.bridge.request<{ opened: unknown[] }>("engine.openedFrom", { tabId: tabBefore.id, since: t0 }).catch(() => ({ opened: [] }))).opened.length > 0;
            dead = !navigating && !openedTab && (recheck.tab?.url ?? tabUrl) === tabUrl;
          }
          if (dead) {
            escalated = "robust";
            ctx.audit.log("act.escalate_robust_click", { name, role, url: tabUrl });
            await sc.req("engine.robustClick", { ref: match.ref }).catch(() => {});
          }
        }

        // 3. Give the page a moment to settle (navigation or DOM update).
        await sc.req("engine.waitForStable", { timeout: 6000, quietMs: 400 }).catch(() => {});

        // 3b. A link with target=_blank moves the agent to a new tab. The
        // session follows it; the old tab stays open (browser_tabs switches back).
        let switchedTab: Record<string, unknown> | undefined;
        if (!sc.s.legacy && sc.s.tabId !== undefined) {
          const opened = (await ctx.bridge.request<{ opened: { tabId: number; windowId: number }[] }>("engine.openedFrom", { tabId: sc.s.tabId, since: t0 }).catch(() => ({ opened: [] }))).opened;
          const child = opened[opened.length - 1];
          if (child) {
            switchedTab = { from: sc.s.tabId, to: child.tabId, hint: "this action opened another tab and your session moved to it; browser_tabs lists, switches and closes tabs" };
            ctx.sessions.bind(sc.s, child.tabId, child.windowId);
            call.tabId = child.tabId;
            await sc.req("engine.waitForStable", { timeout: 6000, quietMs: 400 }).catch(() => {});
          }
        }

        // 4. Re-observe so the agent's next call has fresh state.
        //
        // The action already happened. If the snapshot can't be taken — the
        // page is still committing, or an extension-hostile document like
        // chrome:// is in the way — that's a degraded result, not a failed
        // action. Reporting it as an error would invite the agent to retry
        // and perform the action twice.
        let after: Snap;
        try {
          after = reportWall(call, await attachText(sc, await observeAs(sc, snapshot), false));
        } catch (obsErr) {
          const p = await ping(sc).catch(() => ({}) as Ping);
          ctx.audit.log("act.observe_failed", { name, action, msg: (obsErr as Error).message });
          after = {
            url: p.tab?.url,
            title: p.tab?.title,
            snapshotUnavailable: (obsErr as Error).message,
            hint: "action succeeded; call agent_browser_visit or browser_observe for a fresh tree",
          };
          call.degraded.push("no snapshot after the action (the page could not be read); the action itself ran");
        }

        // One answer to "did we navigate", measured after the settle. The
        // engine's own flag is taken 60ms after the action, before most
        // navigations commit, so the two used to disagree.
        const navigated = tabUrl !== after.url;
        const tabNow = (await ping(sc).catch(() => null))?.tab;
        if (sc.s.legacy && tabNow?.id != null && tabBefore?.id != null && tabNow.id !== tabBefore.id)
          switchedTab = { from: tabBefore.id, to: tabNow.id, hint: "this action opened or moved to another tab; browser_tabs lists, switches and closes tabs" };
        // An action meant to change something that changed nothing is not a
        // success. The Enter that did nothing on Wikipedia came back as a
        // plain `acted: true`; say so instead, so the caller tries another way.
        // A slow server: the form was submitted, but the next page has not
        // arrived. The tab is loading — that is an effect, not a no-op.
        const loading = !navigated && tabNow?.status === "loading";
        const noEffect = action !== "focus" && !navigated && !loading && !switchedTab && result.changed === false;
        if (noEffect)
          call.warnings.push(
            escalated === "robust"
              ? `the first click changed nothing; a page-world retry ran and the URL did not change. ${snapshot === "none" ? "Take a snapshot" : "Check snapshotAfter"} before assuming it worked`
              : "nothing on the page changed (no navigation, no DOM or value change): this probably did not do what you intended",
          );
        if (result.credentialStoreBlocked)
          call.warnings.push("the page tried to save a credential in the browser (credentials.store); it was refused, nothing was saved");
        if (result.passwordField && result.host) {
          const w = passwordHostWarning(result.host);
          if (w) call.warnings.push(w);
        }
        const diagnostics = await diagSummary(sc, t0);

        const { acted: _a, changed: _c, signals, dialogs, credentialStoreBlocked, passwordField: _p, host: _h, snapshotStale: _st, action: _ac, ...engineExtra } = result;
        ctx.audit.log("tool.agent_browser_act", { name, role, action, urlBefore: tabUrl, urlAfter: after.url, noEffect, tabId: call.tabId });
        return {
          acted: true,
          target: { ref: match.ref, role: match.role, name: match.name },
          action,
          value,
          signals: { ...(signals ?? {}), navigated },
          escalated,
          navigated,
          ...engineExtra,
          ...(noEffect ? { noEffect } : {}),
          ...(loading
            ? { stillLoading: true, hint: "the action started a page load that has not finished: call browser_wait, then look — do not repeat the action" }
            : {}),
          // Always reported, whatever the snapshot size: a confirm box the
          // page asked is a decision made on the user's behalf.
          ...(dialogs?.length ? { dialogs } : {}),
          ...(credentialStoreBlocked ? { credentialStoreBlocked } : {}),
          ...(switchedTab ? { switchedTab } : {}),
          ...(diagnostics ? { diagnostics } : {}),
          urlBefore: tabUrl,
          urlAfter: after.url,
          snapshotAfter: after,
        };
      });
    },
  );

  // ============================================================
  // [ADVANCED] PRIMITIVE BROWSER TOOLS — for fine-grained control
  // Most agents should prefer the high-level tools above.
  // ============================================================

  const ADV_RULES = " Acts on your session's tab (see agent_browser_visit for session rules); before your first visit there is none.";

  tool("browser_status", "[advanced] Report whether the agent Chrome / bridge is connected. Prefer `agent_browser_status`.", {}, async () => ({
    bridgeConnected: ctx.bridge.connected(),
  }));

  tool(
    "browser_ping",
    "[advanced] Round-trip a ping through the bridge to the in-page content engine." + ADV_RULES,
    { session: SESSION_ARG, tabId: TAB_ARG },
    async (args, call) => {
      const sc = scope(call, args, "tab");
      return inSession(call, sc, async () => {
        const r = await ping(sc);
        ctx.audit.log("tool.browser_ping", { tabId: call.tabId });
        return r as Record<string, unknown>;
      });
    },
  );

  tool(
    "browser_observe",
    [
      "Observe your session's tab without navigating. semantic = the accessibility tree with refs ",
      "(default); read = the page's visible text, paged with offset/maxChars (the result gives ",
      "nextOffset while there is more); marks = tree plus a screenshot with each ref's number drawn on. ",
      "A captcha or notice blocking the page comes back as outcome:\"needs_human\".",
      ADV_RULES,
    ].join(""),
    {
      session: SESSION_ARG,
      tabId: TAB_ARG,
      mode: z.enum(["semantic", "read", "marks"]).default("semantic"),
      offset: z.number().int().min(0).optional().describe("read mode: character offset to start from"),
      maxChars: z.number().int().min(100).max(50_000).optional().describe("read mode: how much text to return (default 8000)"),
      details: z.boolean().default(false).describe("semantic/marks: also give each link's href and each image's or video's src"),
    },
    async (args, call) => {
      const sc = scope(call, args, "tab");
      return inSession(call, sc, async () => {
        const r = await sc.req<Snap>("engine.observe", { mode: args.mode, offset: args.offset, maxChars: args.maxChars, details: args.details });
        ctx.audit.log("tool.browser_observe", { mode: args.mode, tabId: call.tabId });
        return reportWall(call, r);
      });
    },
  );

  tool(
    "browser_locate",
    "[advanced] Find elements by semantic locator (role and/or accessible name) in your session's tab. Returns matching stable refs." + ADV_RULES,
    { session: SESSION_ARG, tabId: TAB_ARG, role: z.string().optional(), name: z.string().optional() },
    async (args, call) => {
      const sc = scope(call, args, "tab");
      return inSession(call, sc, async () => {
        const r = await sc.req("engine.locate", { role: args.role, name: args.name });
        ctx.audit.log("tool.browser_locate", { role: args.role, name: args.name });
        return r;
      });
    },
  );

  tool(
    "browser_navigate",
    "[advanced] Start a navigation in your session's tab and return at once, without waiting for the page or returning a snapshot. Prefer `agent_browser_visit` ({url} or {history}), which waits and returns the new page. url=go to URL (opens your session's window if it has none), or action=back|forward|reload. A reload on a shared tab affects every agent on it." + ADV_RULES,
    {
      session: SESSION_ARG,
      tabId: TAB_ARG,
      url: z.string().url().optional(),
      action: z.enum(["back", "forward", "reload"]).optional(),
    },
    async (args, call) => {
      if (!args.url === !args.action) throw new AbError("BAD_REQUEST", "give exactly one of url or action");
      const sc = scope(call, args, args.url ? "open" : "tab");
      if (DRY_RUN) return { dryRun: true, wouldNavigate: args.url ?? args.action };
      return inSession(call, sc, async () => {
        if (!sc.s.legacy && sc.s.tabId === undefined) {
          const w = await ctx.bridge.request<{ tabId: number; windowId: number }>("engine.openSessionWindow", { url: args.url });
          ctx.sessions.bind(sc.s, w.tabId, w.windowId);
          call.tabId = w.tabId;
          ctx.audit.log("tool.browser_navigate", { url: args.url, tabId: w.tabId, opened: true });
          return { navigating: true, to: args.url, tabId: w.tabId, windowId: w.windowId, mode: "opened_session_window" };
        }
        const r = await sc.req("engine.navigate", args.url ? { url: args.url } : { action: args.action });
        ctx.audit.log("tool.browser_navigate", { target: args.url ?? args.action, tabId: call.tabId });
        return r;
      });
    },
  );

  tool(
    "browser_act",
    "[advanced] Act on an element by ref from the latest observe snapshot. Re-observe after (refs go stale). actions: click/type/fill/clear/press/hover/focus/check/uncheck/select/submit." + ADV_RULES,
    {
      session: SESSION_ARG,
      tabId: TAB_ARG,
      ref: z.number().int(),
      gen: z.number().optional(),
      action: z.enum(["click", "type", "fill", "clear", "press", "hover", "focus", "check", "uncheck", "select", "submit"]),
      value: z.string().optional(),
      actionClass: z.string().optional(),
    },
    async (args, call) => {
      const sc = scope(call, args, "tab");
      return inSession(call, sc, async () => {
        const url = (await ping(sc)).tab?.url ?? "";
        const d = ctx.policy.evaluate({ url, actionClass: args.actionClass });
        if (!d.allow) {
          ctx.audit.log("policy.block", { tool: "browser_act", url, action: args.action, reason: d.reason });
          throw new AbError("POLICY_BLOCKED", `blocked by policy: ${d.reason}`, { recovery: POLICY_ADVICE });
        }
        if (DRY_RUN) return { dryRun: true, wouldAct: { action: args.action, ref: args.ref, value: args.value }, url, policy: d.reason };
        let r: Record<string, unknown>;
        try {
          r = await sc.req("engine.act", { ref: args.ref, gen: args.gen, action: args.action, value: args.value });
        } catch (e) {
          // Same rule as agent_browser_act: a port that closed mid-action means
          // the action navigated — it ran. This used to come back as an error
          // advising "re-observe and retry", i.e. firing it a second time.
          if (!PORT_DIED.test((e as Error).message)) throw e;
          r = { acted: true, changed: true, signals: { navigated: true, portClosed: true }, snapshotStale: true };
        }
        if (r.changed === false && args.action !== "focus")
          call.warnings.push("nothing on the page changed (no navigation, no DOM or value change): this probably did not do what you intended");
        ctx.audit.log("tool.browser_act", { url, action: args.action, ref: args.ref });
        return r;
      });
    },
  );

  tool(
    "browser_robust_click",
    [
      "[advanced] Click a ref in the PAGE's own JS world, for buttons that ignore an ",
      "ordinary click. Waits for React hydration, forces focus/visibility, then tries an ",
      "authentic pointer sequence, native click, the React fiber onClick, and formAction ",
      "in turn — reporting which strategies ran. `agent_browser_act` already escalates to ",
      "this automatically; reach for it directly only when driving refs by hand.",
      ADV_RULES,
    ].join(""),
    { session: SESSION_ARG, tabId: TAB_ARG, ref: z.number().int(), hydrationTimeoutMs: z.number().int().default(4000) },
    async (args, call) => {
      if (DRY_RUN) return { dryRun: true, wouldRobustClick: args.ref };
      const sc = scope(call, args, "tab");
      return inSession(call, sc, async () => {
        const r = await sc.req("engine.robustClick", { ref: args.ref, hydrationTimeoutMs: args.hydrationTimeoutMs });
        ctx.audit.log("tool.browser_robust_click", { ref: args.ref });
        return r;
      });
    },
  );

  tool(
    "browser_wait_for_navigation",
    [
      "[advanced] Wait until your session's tab commits a navigation whose URL matches a regex, ",
      "and return that URL with its query parameters parsed out. For redirect-driven flows ",
      "— OAuth consent, SSO hand-off, payment return, magic links — where the value you need ",
      "arrives as a URL that may bounce onward before you could observe it. Recent history is ",
      "checked first, so a redirect that already landed is still caught.",
      ADV_RULES,
    ].join(""),
    {
      session: SESSION_ARG,
      tabId: TAB_ARG,
      urlPattern: z.string().describe("JS regex matched against the full URL, e.g. \"/callback\\\\?code=\" or \"^https://example\\\\.com/done\""),
      timeoutMs: z.number().int().default(20_000),
      lookbackMs: z.number().int().default(5_000).describe("How far back in navigation history to also consider"),
    },
    async (args, call) => {
      const sc = scope(call, args, "tab");
      const r = await sc.req<{ matched?: boolean }>("engine.waitForNavigation", {
        urlPattern: args.urlPattern,
        timeoutMs: args.timeoutMs,
        sinceTs: Date.now() - args.lookbackMs,
      });
      ctx.audit.log("tool.browser_wait_for_navigation", { urlPattern: args.urlPattern, matched: !!r.matched });
      if (!r.matched)
        throw new AbError("NAV_TIMEOUT", `no navigation matched ${args.urlPattern} within ${args.timeoutMs}ms`, {
          recovery: "widen the pattern, raise timeoutMs, or check recentUrls for what actually loaded",
          ...r,
        });
      return r;
    },
  );

  tool(
    "browser_wait",
    [
      "Wait for your session's page. With text, or name/role: until that text or element appears ",
      "(gone:true — until it disappears), up to 25s. With neither: until the page is ",
      "DOM/network-quiet and its layout and animations have stopped. Use after an action that loads something.",
      ADV_RULES,
    ].join(""),
    {
      session: SESSION_ARG,
      tabId: TAB_ARG,
      text: z.string().optional().describe("Wait until this text is on the page (case-insensitive)"),
      name: z.string().optional().describe("Wait until an element with this accessible name exists"),
      role: z.string().optional().describe("Narrow `name` to a role, or wait for any element of this role"),
      gone: z.boolean().default(false).describe("Wait for the text/element to disappear instead"),
      timeout: z.number().int().default(8000),
      quietMs: z.number().int().default(600),
    },
    async (args, call) => {
      const sc = scope(call, args, "tab");
      return inSession(call, sc, async () => {
        const targeted = args.text !== undefined || args.name !== undefined || args.role !== undefined;
        ctx.audit.log("tool.browser_wait", { targeted });
        if (!targeted) {
          const settled = await settlePage(call, sc, args.quietMs, args.timeout);
          return { stable: settled.settled, ...settled };
        }
        const r = await sc.req<{ timedOut?: boolean }>("engine.waitFor", { text: args.text, name: args.name, role: args.role, gone: args.gone, timeout: args.timeout });
        if (r.timedOut)
          throw new AbError("NAV_TIMEOUT", `${args.gone ? "still there" : "did not appear"} after ${Math.min(args.timeout, 25_000)}ms`, {
            recovery: "check the page (browser_observe) — the text or name may differ from what you expect",
          });
        return r;
      });
    },
  );

  tool(
    "browser_scroll",
    [
      "Scroll your session's page: to top or bottom, a screen up or down, or to a y offset. Returns ",
      "the position, page height, atBottom, and grewBy when the page loaded more (an infinite ",
      "feed). Element actions and screenshots scroll by themselves; use this to load more ",
      "content or to look around.",
      ADV_RULES,
    ].join(""),
    {
      session: SESSION_ARG,
      tabId: TAB_ARG,
      to: z.enum(["top", "bottom", "up", "down"]).optional(),
      y: z.number().optional().describe("Scroll to this offset in CSS pixels instead"),
    },
    async (args, call) => {
      if (!args.to === (args.y === undefined)) throw new AbError("BAD_REQUEST", "give exactly one of to or y", { recovery: "e.g. {to:\"bottom\"} or {y:2400}" });
      const sc = scope(call, args, "tab");
      return inSession(call, sc, async () => {
        const r = await sc.req("engine.scroll", { to: args.to, y: args.y });
        ctx.audit.log("tool.browser_scroll", { to: args.to, y: args.y });
        return r;
      });
    },
  );

  tool(
    "browser_tabs",
    [
      "List, switch, open or close tabs. list shows every tab and which session holds it (`yours`). ",
      "switch makes a tab your session's tab (by explicit tabId; never one another session holds) and brings it ",
      "to the front of its own window without raising the window. new opens a tab in your session's window. ",
      "close closes one of your own tabs. With session \"default\", the old behaviour: tools act on the focused tab.",
    ].join(""),
    {
      session: SESSION_ARG,
      action: z.enum(["list", "switch", "new", "close"]).default("list"),
      tabId: z.number().int().optional().describe("For switch and close: a tabId from the list"),
      url: z.string().url().optional().describe("For new: the page to open"),
    },
    async (args, call) => {
      const { action, tabId, url } = args;
      if ((action === "switch" || action === "close") && tabId === undefined)
        throw new AbError("BAD_REQUEST", `${action} needs a tabId`, { recovery: "call browser_tabs({action:\"list\"}) first" });
      const r = resolveKey(ctx.client.id, args.session);
      const s = ctx.sessions.get(r, ctx.client.id);
      call.session = s;
      type TabList = { tabs: { tabId: number; windowId: number; [k: string]: unknown }[]; activeTabId?: number; createdTabId?: number };
      const list = () => ctx.bridge.request<TabList>("engine.tabs", { action: "list" });
      const label = (t: { tabId: number; windowId: number }) => {
        const o = ctx.sessions.ownerOfTab(t.tabId);
        const yours = !!o && (o === s || o.ownerClient === ctx.client.id);
        return { ...(o ? { session: o.shared ? o.label : yours ? o.label : "another agent" } : {}), yours };
      };
      const annotate = (l: TabList) => ({ ...l, tabs: l.tabs.map((t) => ({ ...t, ...label(t) })) });
      const mineTab = (id: number, windowId?: number) => ctx.sessions.ownerOfTab(id) === s || (s.windowId !== undefined && windowId === s.windowId);

      if (s.legacy) {
        const out = await ctx.bridge.request<TabList>("engine.tabs", { action, tabId, url, focusWindow: true });
        ctx.audit.log("tool.browser_tabs", { action, tabId, legacy: true });
        call.warnings.push("session \"default\" acts on whichever tab is focused — which other agents and the user also use. Omit `session` to get a window of your own");
        return annotate(out);
      }
      if (action === "list") return annotate(await list());
      const all = (await list()).tabs;
      if (action === "new") {
        if (s.windowId === undefined) {
          const w = await ctx.bridge.request<{ tabId: number; windowId: number }>("engine.openSessionWindow", { url });
          ctx.sessions.bind(s, w.tabId, w.windowId);
          ctx.audit.log("tool.browser_tabs", { action, tabId: w.tabId, opened: true });
          return { ...annotate(await list()), yourTab: w.tabId };
        }
        const out = await ctx.bridge.request<TabList>("engine.tabs", { action: "new", url, windowId: s.windowId });
        if (out.createdTabId !== undefined) ctx.sessions.bind(s, out.createdTabId, s.windowId);
        ctx.audit.log("tool.browser_tabs", { action, tabId: out.createdTabId });
        return { ...annotate(out), yourTab: out.createdTabId };
      }
      const target = all.find((t) => t.tabId === tabId);
      if (!target) throw new AbError("TAB_GONE", `no tab ${tabId}; list the tabs first`);
      const owner = ctx.sessions.ownerOfTab(tabId!);
      if (owner && owner !== s && !(owner.ownerClient === ctx.client.id && !owner.shared))
        throw new AbError("TAB_OWNED_BY_OTHER", `tab ${tabId} belongs to another session`);
      if (action === "close") {
        if (!mineTab(tabId!, target.windowId))
          throw new AbError("TAB_OWNED_BY_OTHER", `tab ${tabId} is not one of your session's tabs; close only your own`);
        const out = await ctx.bridge.request<TabList>("engine.tabs", { action: "close", tabId });
        if (s.tabId === tabId) ctx.sessions.unbind(s);
        ctx.audit.log("tool.browser_tabs", { action, tabId });
        return annotate(out);
      }
      // switch: an explicit choice of tab — it becomes this session's tab.
      if (owner && owner !== s) ctx.sessions.unbind(owner);
      const out = await ctx.bridge.request<TabList>("engine.tabs", { action: "switch", tabId });
      ctx.sessions.bind(s, tabId!, target.windowId);
      ctx.audit.log("tool.browser_tabs", { action, tabId });
      return { ...annotate(out), yourTab: tabId };
    },
  );

  tool(
    "browser_screenshot",
    [
      "Screenshot your session's tab, without CDP. It first waits for the page to settle (layout still, ",
      "animations and fonts done, network quiet) and reports settled/settleMs/reason, plus documentGeneration and ",
      "layoutHash — compare them across captures to tell a changed page from the same one. No options: the visible ",
      "viewport. fullPage:true: the whole page, scrolled and stitched (fixed headers appear once). name/role or ref: ",
      "just that element, centred, with any fixed bar over it hidden (hidOverlays) — or an OCCLUDED error naming what ",
      "covers it. clip: a region in CSS pixels from the page's top-left. Tall captures come back as several images in ",
      "page order, each at most 4000px. The scroll position is restored. Each capture is also saved to disk (`evidence`).",
      ADV_RULES,
    ].join(""),
    {
      session: SESSION_ARG,
      tabId: TAB_ARG,
      fullPage: z.boolean().default(false),
      name: z.string().optional().describe("Capture the first element whose accessible name contains this"),
      role: z
        .string()
        .optional()
        .describe("Narrow `name` to a role: button, link, heading… and also table, row, figure, img, article, list, paragraph, region — which are not in the snapshot but can be captured (a table is named by its caption or first text)"),
      ref: z.number().int().optional().describe("Capture this element from the latest snapshot"),
      clip: z
        .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
        .optional()
        .describe("Region in CSS pixels, page coordinates"),
      scale: z.number().min(0.25).max(4).optional().describe("Image pixels per CSS pixel. Default: the screen's (sharp) — or 1 for fullPage, to keep it small"),
      format: z.enum(["png", "jpeg"]).optional().describe("Default: jpeg for fullPage (about a third of the size), png otherwise"),
      settle: z.boolean().default(true).describe("Wait for the page to stop changing first (default). false: capture at once"),
    },
    async (args, call) => {
      const { fullPage, name, role, ref, clip, scale, format } = args;
      const targets = [fullPage, name !== undefined || role !== undefined, ref !== undefined, clip !== undefined];
      if (targets.filter(Boolean).length > 1) throw new AbError("BAD_REQUEST", "give at most one of fullPage, name/role, ref, clip", { recovery: "pick one target per screenshot" });
      const sc = scope(call, args, "tab");
      return inSession(call, sc, async () => {
        let settled: { settled: boolean; settleMs?: number; reason?: string } | null = null;
        if (args.settle) {
          settled = await sc.req<{ settled: boolean; settleMs?: number; reason?: string }>("engine.settle", { maxMs: 3000 }).catch(() => null);
          if (settled && !settled.settled) {
            call.warnings.push(`captured while the page was still changing (${settled.reason}); a second capture may differ — wait (browser_wait) and capture again before comparing`);
            call.degraded.push(`screenshot of an unsettled page: ${settled.reason}`);
          }
        }
        let target = ref;
        if (name !== undefined || role !== undefined) target = (await locateOne(sc, name, role)).ref;
        const r = await sc.req<Record<string, unknown> & { screenshot?: string; images?: string[]; hidOverlays?: string[] }>(
          "engine.screenshot",
          { fullPage, ref: target, clip, scale, format },
          90_000,
        );
        const images = (r.images ?? [r.screenshot]).map(imageContent).filter((i): i is Image => i !== null);
        if (!images.length) throw new AbError("CAPTURE_FAILED", "no screenshot came back");
        const state = await sc.req<{ documentGeneration?: string; layoutHash?: string }>("engine.pageState").catch(() => ({}) as { documentGeneration?: string; layoutHash?: string });
        const navCount = (await ping(sc).catch(() => ({}) as Ping)).tab?.navCount;
        const { screenshot: _s, images: _i, ...meta } = r;
        // Bytes per image, so a caller can see the cost before using one.
        const bytes = images.map((i) => Math.floor((i.data.length * 3) / 4));
        const ev = await evidence(sc, "screenshot", { url: meta.url, target: target ?? (fullPage ? "fullPage" : clip ? "clip" : "viewport") }, r.images?.[0] ?? r.screenshot);
        ctx.audit.log("tool.browser_screenshot", { fullPage, ref: target, clip: !!clip, tabId: call.tabId, ...(ev ? { evidence: ev.file } : {}) });
        call.images.push(...images);
        return {
          ...meta,
          ...(settled ? { settled: settled.settled, settleMs: settled.settleMs, ...(settled.reason ? { settleReason: settled.reason } : {}) } : {}),
          ...state,
          ...(navCount !== undefined ? { navCount } : {}),
          bytes,
          ...(images.length > 1 ? { tiles: images.length } : {}),
          ...(ev ? { evidence: ev } : {}),
        };
      });
    },
  );

  tool(
    "browser_inspect",
    [
      "Read one element's state — what a test asserts: attributes (src, href, aria-pressed and every aria-*), value, ",
      "checked, selected options, an image's currentSrc, a video's or audio's readyState/networkState/error/currentTime/",
      "duration/paused, its box, computed display/visibility/opacity, and whether it is the topmost element at its centre ",
      "(coveredBy when not). By name/role or ref. Works on any page.",
      ADV_RULES,
    ].join(""),
    {
      session: SESSION_ARG,
      tabId: TAB_ARG,
      name: z.string().optional(),
      role: z.string().optional().describe("e.g. button, link, img, video, textbox"),
      ref: z.number().int().optional(),
    },
    async (args, call) => {
      if (args.ref === undefined && args.name === undefined && args.role === undefined) throw new AbError("BAD_REQUEST", "say which element: name/role, or ref");
      const sc = scope(call, args, "tab");
      return inSession(call, sc, async () => {
        const ref = args.ref ?? (await locateOne(sc, args.name, args.role)).ref;
        const r = await sc.req("engine.inspect", { ref });
        ctx.audit.log("tool.browser_inspect", { ref });
        return r;
      });
    },
  );

  const blocked = (url: string) => evalBlockedBy(url, ctx.cfg.eval.blockedDomains);

  tool(
    "browser_eval",
    [
      "Evaluate a JavaScript expression in your session's page (its own JS world) and return the value as JSON — ",
      "to read app state: a variable, a store, video.readyState, canPlayType. Promises are awaited (up to timeoutMs). ",
      "Read only by convention: do not change the page with it; use agent_browser_act for that. Refused on the ",
      "domains in eval.blockedDomains (identity, payment, banking by default) and where the page's CSP forbids eval — ",
      "browser_inspect reads element state without eval. Results over 20KB are cut.",
      ADV_RULES,
    ].join(""),
    {
      session: SESSION_ARG,
      tabId: TAB_ARG,
      expression: z.string().min(1).describe("e.g. \"document.querySelector('video').readyState\" or \"window.store.getState().player\""),
      awaitPromise: z.boolean().default(true),
      timeoutMs: z.number().int().min(100).max(25_000).default(5000),
    },
    async (args, call) => {
      const sc = scope(call, args, "tab");
      return inSession(call, sc, async () => {
        const url = (await ping(sc)).tab?.url ?? "";
        const hit = blocked(url);
        ctx.audit.log("tool.browser_eval", { url, expression: args.expression.slice(0, 200), blocked: !!hit });
        if (hit) throw new AbError("EVAL_BLOCKED", `eval is not allowed on ${new URL(url).hostname} (eval.blockedDomains: ${hit})`);
        return await sc.req("engine.eval", { expression: args.expression, awaitPromise: args.awaitPromise, timeoutMs: args.timeoutMs }, args.timeoutMs + 5000);
      });
    },
  );

  tool(
    "browser_diagnostics",
    [
      "What went wrong in your session's page: failed or non-2xx requests (url, method, status, type, error — on every ",
      "host), and on development hosts (localhost, 127.0.0.1, private IPs, *.local, *.test, and diagnostics.hosts in the ",
      "config) also console errors and warnings, uncaught exceptions and unhandled rejections with their source. Media ",
      "elements that failed to load are listed too. `since` is a ms timestamp; default: everything kept (last 100 requests, 200 entries).",
      ADV_RULES,
    ].join(""),
    { session: SESSION_ARG, tabId: TAB_ARG, since: z.number().int().optional() },
    async (args, call) => {
      const sc = scope(call, args, "tab");
      return inSession(call, sc, async () => {
        const r = await sc.req<{ network?: unknown[]; console?: unknown[]; media?: unknown[] }>("engine.diagnostics", { since: args.since ?? 0 });
        const url = (await ping(sc).catch(() => ({}) as Ping)).tab?.url ?? "";
        let host = "";
        try {
          host = new URL(url).hostname;
        } catch {}
        const dev =
          /^(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(host) ||
          /\.(localhost|local|test)$/.test(host) ||
          ctx.cfg.diagnostics.hosts.some((h) => host === h || host.endsWith(`.${h}`));
        return { ...r, ...(dev ? {} : { note: `console capture is off on ${host || "this page"} (not a development host); network failures are still listed` }) };
      });
    },
  );

  tool(
    "browser_pointer",
    [
      "Send an explicit pointer sequence — down / move / up / wheel — for gestures agent_browser_act's drag does not cover ",
      "(a press-and-hold, a multi-point path, a wheel over a canvas, modifier keys). Each step gives x,y in viewport CSS ",
      "pixels, or `at` (px or % inside the target element). Synthetic events (isTrusted:false; no CDP); pointer capture works.",
      ADV_RULES,
    ].join(""),
    {
      session: SESSION_ARG,
      tabId: TAB_ARG,
      name: z.string().optional().describe("Target element by accessible name (for `at` points)"),
      role: z.string().optional(),
      ref: z.number().int().optional(),
      pointerType: z.enum(["mouse", "pen", "touch"]).default("mouse"),
      sequence: z
        .array(
          z.object({
            type: z.enum(["down", "move", "up", "wheel"]),
            x: z.number().optional(),
            y: z.number().optional(),
            at: AT.optional(),
            buttons: z.number().int().optional(),
            deltaX: z.number().optional(),
            deltaY: z.number().optional(),
            modifiers: z.object({ shift: z.boolean(), ctrl: z.boolean(), alt: z.boolean(), meta: z.boolean() }).partial().optional(),
            waitMs: z.number().int().min(0).max(5000).optional(),
          }),
        )
        .min(1)
        .max(200),
    },
    async (args, call) => {
      if (existsSync(resolve(ctx.cfg.stateDir, "HALT"))) throw new AbError("HALTED", "HALTED: kill switch active");
      const sc = scope(call, args, "tab");
      return inSession(call, sc, async () => {
        const ref = args.ref ?? (args.name !== undefined || args.role !== undefined ? (await locateOne(sc, args.name, args.role)).ref : undefined);
        const r = await sc.req<Record<string, unknown>>("engine.act", { action: "pointer", ref, sequence: args.sequence, pointerType: args.pointerType });
        await sc.req("engine.waitForStable", { timeout: 4000, quietMs: 300 }).catch(() => {});
        ctx.audit.log("tool.browser_pointer", { ref, steps: args.sequence.length });
        if (r.changed === false) call.warnings.push("nothing on the page changed: the gesture probably did not do what you intended");
        return r;
      });
    },
  );
}
