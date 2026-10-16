import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "../bridge/server.js";
import type { Policy } from "../policy.js";
import type { SessionManager } from "../sessions.js";
import type { Audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { hostHelper, launchBrowser } from "../host-helper-client.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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
}

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

/** Split a data URL into MCP image content; null if not a data URL. */
function imageContent(dataUrl: unknown) {
  if (typeof dataUrl !== "string") return null;
  const m = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!m) return null;
  return { type: "image" as const, data: m[2], mimeType: m[1] };
}
// The kill switch is the human's. Telling an agent how to remove it — as the
// old "rm ~/.agent-chrome/HALT to resume" did — invites it to.
const HALT_ADVICE = "the user has switched on the kill switch: stop and tell them; do not try to turn it off";
// Same principle for the policy gate: the decision belongs to the user.
const POLICY_ADVICE =
  "this needs the user's approval: stop and ask them. Do not retry it, relabel it, or change the policy yourself";

const fail = (msg: string, recovery: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: JSON.stringify({ error: msg, recovery }, null, 2) }],
});

/**
 * MCP tool surface, split into two tiers:
 *
 *   1. HIGH-LEVEL intent tools (preferred): `agent_browser_visit` reads a page,
 *      `agent_browser_act` does something on it. Each handles locate → act →
 *      settle → re-observe end-to-end, so agents never track refs themselves.
 *
 *   2. [ADVANCED] primitive tools (`browser_*`) for fine-grained control.
 *      Most agents shouldn't need these.
 */
export function registerTools(server: McpServer, ctx: Ctx): void {
  /**
   * Bring the browser up if the bridge isn't connected. Returns how it got
   * there, or a ready-made failure result. Shared by every tool that needs a
   * live browser so the launch path and its error advice exist once.
   */
  async function ensureBrowser(
    timeoutMs: number,
  ): Promise<{ already: boolean; launchedVia?: string; waitedMs?: number } | ReturnType<typeof fail>> {
    if (ctx.bridge.connected()) return { already: true };
    // The worker may just be reconnecting (browser starting, extension
    // reloaded). Give it a moment before concluding nothing is there.
    if (await ctx.bridge.waitForConnection(8_000)) return { already: true };
    if (existsSync(resolve(ctx.cfg.stateDir, "HALT"))) return fail("HALTED: kill switch active", HALT_ADVICE);
    const launchedVia = await launchBrowser();
    ctx.audit.log("browser.launch", { via: launchedVia });
    const t0 = Date.now();
    if (await ctx.bridge.waitForConnection(timeoutMs))
      return { already: false, launchedVia, waitedMs: Date.now() - t0 };
    return fail(
      `agent browser did not connect within ${timeoutMs}ms (launched via ${launchedVia})`,
      "if Chrome opened, load the extension once via chrome://extensions → Load unpacked → packages/extension; " +
        "if it did not, run `npm run launch` in the agent-browser repo and read its output",
    );
  }
  const isFail = (r: object): r is ReturnType<typeof fail> => "isError" in r;

  /**
   * Recovery advice that matches the actual state. A fixed "ensure agent
   * Chrome is launched" sent agents chasing a browser that was running fine.
   */
  const advise = (e: unknown, fallback: string) => {
    const msg = (e as Error).message ?? String(e);
    if (/HALTED/.test(msg)) return HALT_ADVICE;
    if (!ctx.bridge.connected()) return "the browser is not connected: call agent_browser_ensure_running, then retry";
    if (/STALE_SNAPSHOT|REF_NOT_FOUND/.test(msg)) return "the page changed: take a fresh snapshot (agent_browser_visit / browser_observe), then retry";
    if (/NOT_ACTIONABLE/.test(msg)) return "element not actionable (hidden, disabled, or covered): wait or scroll, then retry";
    return fallback;
  };
  const failWith = (e: unknown, fallback: string) => fail((e as Error).message ?? String(e), advise(e, fallback));

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ping = async () =>
    (await ctx.bridge.request("engine.ping", {})) as {
      tab?: { url?: string; title?: string; status?: string };
      engine?: { error?: string };
    };

  type Snap = Record<string, unknown> & { url?: string; tree?: unknown[] };
  const settleAndObserve = async (observe: Record<string, unknown> = {}) => {
    await ctx.bridge.request("engine.waitForStable", { timeout: 8000, quietMs: 600 }).catch(() => {});
    return (await ctx.bridge.request("engine.observe", { mode: "semantic", ...observe })) as Snap;
  };

  /**
   * Add the page's visible text to a snapshot when asked, and always when the
   * tree is empty — a JSON response or a page of prose has nothing to click,
   * and an empty tree with no hint left agents stuck.
   */
  const attachText = async (snap: Snap, wanted: boolean): Promise<Snap> => {
    const empty = Array.isArray(snap.tree) && snap.tree.length === 0;
    if (!wanted && !empty) return snap;
    const r = (await ctx.bridge.request("engine.observe", { mode: "read" }).catch(() => null)) as {
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

  // ============================================================
  // HIGH-LEVEL INTENT TOOLS — preferred for AI agents
  // ============================================================

  server.tool(
    "agent_browser_status",
    [
      "Status of the persistent agent browser (stealth Chrome + extension bridge). ",
      "Returns whether the SW bridge is connected, the active tab URL, host-helper ",
      "reachability. No side effects.",
    ].join(""),
    {},
    async () => {
      const helperUp = hostHelper.available() ? await hostHelper.health() : false;
      const bridgeConnected = ctx.bridge.connected();
      let activeTab: { url?: string; title?: string } | null = null;
      if (bridgeConnected) {
        try {
          const r = (await ctx.bridge.request("engine.ping", {})) as { tab?: { url?: string; title?: string } };
          activeTab = r.tab ?? null;
        } catch {}
      }
      return ok({
        bridgeConnected,
        activeTab,
        hostHelperReachable: helperUp,
        ready: bridgeConnected,
      });
    },
  );

  server.tool(
    "agent_browser_ensure_running",
    [
      "Make sure the stealth Chrome + extension are running and the bridge is ",
      "connected, launching the browser if needed (via the host helper when it is ",
      "running, otherwise directly). Idempotent. ",
      "Use this before any agent_browser_visit / advanced browser_* calls.",
    ].join(""),
    { timeoutMs: z.number().int().default(45_000) },
    async ({ timeoutMs }) => {
      const r = await ensureBrowser(timeoutMs);
      if (isFail(r)) return r;
      return ok(
        r.already
          ? { already: true, bridgeConnected: true }
          : { launched: true, launchedVia: r.launchedVia, bridgeConnected: true, waitedMs: r.waitedMs },
      );
    },
  );

  server.tool(
    "agent_browser_visit",
    [
      "Navigate the persistent agent browser to a URL — or go back / forward / reload — ",
      "wait for it to settle, and return a compact accessibility-tree snapshot of the ",
      "links, buttons, fields and headings. Pass text:true to also get the page's ",
      "visible text (paragraphs, prices, scores, JSON); it is included automatically ",
      "when the page has nothing interactive. Auto-ensures the browser is running first.",
    ].join(""),
    {
      url: z.string().url().optional().describe("Page to open. Give this or `history`."),
      history: z
        .enum(["back", "forward", "reload"])
        .optional()
        .describe("Move through this tab's history instead of opening a URL."),
      text: z.boolean().default(false).describe("Also return the page's visible text (first 8000 chars; the result says how to page on)."),
    },
    async ({ url, history, text }) => {
      if (!url === !history) return fail("give exactly one of url or history", "e.g. {url:\"https://…\"} or {history:\"back\"}");
      const up = await ensureBrowser(45_000);
      if (isFail(up)) return up;
      if (history) {
        try {
          const before = (await ping()).tab?.url ?? "";
          await ctx.bridge.request("engine.navigate", { action: history });
          // Done when the URL moves (back/forward) or the reload has finished
          // and the content engine answers again.
          const t0 = Date.now();
          let landed = false;
          while (!landed && Date.now() - t0 < 10_000) {
            await sleep(300);
            const p = await ping().catch(() => null);
            if (!p || p.engine?.error) continue;
            landed = history === "reload"
              ? Date.now() - t0 > 600 && p.tab?.status === "complete"
              : (p.tab?.url ?? "") !== before;
          }
          if (!landed)
            return fail(
              `${history} did not change the page (still on ${before})`,
              `there may be no ${history === "back" ? "earlier" : "later"} page in this tab's history; open the page with agent_browser_visit({url}) instead`,
            );
          const snap = await attachText(await settleAndObserve(), text);
          ctx.audit.log("tool.agent_browser_visit", { history, from: before, to: snap.url });
          return ok(snap);
        } catch (e) {
          return failWith(e, "retry; if it repeats, open the page with agent_browser_visit({url})");
        }
      }
      // Navigation is read-only and unrestricted — any URL is fair game. The
      // sensitive-action gate lives in agent_browser_act, and only for the
      // action classes a caller explicitly labels.
      try {
        url = url!;
        await ctx.bridge.request("engine.navigate", { url });

        // Poll until the active tab has committed to the new origin AND the
        // content engine answers. Mirrors the control-plane /visit logic.
        // Without this, an `observe` immediately after `navigate` can hit a
        // still-on-chrome:// tab and error with "Cannot access chrome:// URL".
        const wantHost = new URL(url).hostname;
        const t0 = Date.now();
        let lastErr = "navigation did not commit";
        while (Date.now() - t0 < 15_000) {
          await new Promise((r) => setTimeout(r, 400));
          try {
            const p = (await ctx.bridge.request("engine.ping", {})) as {
              tab?: { url?: string };
              engine?: { error?: string };
            };
            if (p.engine?.error) { lastErr = p.engine.error; continue; }
            const tabUrl = p.tab?.url ?? "";
            if (!tabUrl) continue;
            const h = new URL(tabUrl).hostname;
            if (h === wantHost || h.endsWith("." + wantHost) || wantHost.endsWith("." + h)) {
              const snap = await attachText(await settleAndObserve(), text);
              ctx.audit.log("tool.agent_browser_visit", { url });
              return ok(snap);
            }
          } catch (e) {
            lastErr = String((e as Error).message || e);
          }
        }
        return fail(`navigation did not commit to ${wantHost}: ${lastErr}`, "retry, or call agent_browser_status to check bridge");
      } catch (e) {
        return fail((e as Error).message, "retry after agent_browser_status reports bridgeConnected:true");
      }
    },
  );

  server.tool(
    "agent_browser_act",
    [
      "DO an action on the active page by accessible name — click a button, type into an ",
      "input, submit a form, etc. Finds the first matching element (role + name), performs ",
      "the action, waits for the page to settle, and returns the post-action accessibility-tree ",
      "snapshot. No ref/snapshot-generation bookkeeping needed — this tool handles it. ",
      "Pair with agent_browser_visit (read) for the full read-and-do agentic loop. ",
      "If the action changed nothing on the page, the result says so (noEffect + warning). ",
      "Policy-gated; sensitive actions on untrusted domains escalate.",
    ].join(""),
    {
      name: z.string().describe("Accessible name (button label, link text, input placeholder/label) — case-insensitive substring match"),
      role: z.string().optional().describe("Optional role filter: button, link, textbox, checkbox, combobox, etc. Recommended when the name is ambiguous."),
      action: z
        .enum(["click", "type", "fill", "clear", "press", "hover", "focus", "check", "uncheck", "submit", "select"])
        .default("click")
        .describe("click (default) | type (append text) | fill (replace text) | clear | press (key, value=key; Enter in a form field submits it) | hover | focus | check | uncheck | submit | select (dropdown; value = option text or value)"),
      value: z.string().optional().describe("Required for type/fill/press/select; for press it's the key (e.g. \"Enter\")"),
      snapshot: z
        .enum(["full", "viewport", "none"])
        .default("full")
        .describe("What snapshotAfter holds: full (default), viewport (only what is on screen — much smaller), none (just url and title; use for a run of fills)"),
      actionClass: z
        .string()
        .optional()
        .describe(
          "Optional label for consequential actions: payment | delete_destructive | credential_entry | file_upload. Labelled actions need a trusted domain; everything else runs freely.",
        ),
      robust: z
        .enum(["auto", "always", "never"])
        .default("auto")
        .describe(
          "Dead-click handling for action=click. auto (default): if the click provably did nothing, retry in the page's own JS world (handles React fiber handlers, unhydrated listeners, focus-gated effects). always: skip straight to it. never: for non-idempotent buttons where a double-fire would be harmful.",
        ),
      session: z.string().default("default"),
    },
    async ({ name, role, action, value, actionClass, robust, snapshot, session }) => {
      try {
        if (existsSync(resolve(ctx.cfg.stateDir, "HALT"))) return fail("HALTED: kill switch active", HALT_ADVICE);

        const up = await ensureBrowser(45_000);
        if (isFail(up)) return up;

        // Policy gate: only fires for an explicitly labelled sensitive class.
        // A plain click/type/submit is an ordinary action anywhere on the web.
        const tabUrl = (await ping()).tab?.url ?? "";
        const d = ctx.policy.evaluate({ url: tabUrl, actionClass });
        if (!d.allow) return fail(`blocked by policy: ${d.reason}`, POLICY_ADVICE);

        if (DRY_RUN)
          return ok({
            dryRun: true,
            wouldAct: { action, name, role, value },
            currentUrl: tabUrl,
            policy: d.reason,
          });

        return await ctx.sessions.withLock(session, async () => {
          // 1. Locate. Uses the same engine.locate as the [advanced] tool.
          const loc = (await ctx.bridge.request("engine.locate", { role, name })) as {
            snapshotGeneration?: number;
            matches?: { ref: number; role: string; name: string }[];
          };
          const match = loc.matches?.[0];
          if (!match) {
            // Say what IS there. Pages change an element's role under you
            // (Wikipedia's search box turns from searchbox into combobox once
            // its suggestions open), and a bare "no element" hides that.
            const near = async (q: { role?: string; name?: string }) =>
              ((await ctx.bridge.request("engine.locate", q).catch(() => ({}))) as typeof loc).matches ?? [];
            let similar = role ? await near({ name }) : [];
            if (!similar.length) {
              const word = name.split(/\s+/).sort((a, b) => b.length - a.length)[0];
              if (word && word.length >= 3 && word !== name) similar = await near({ name: word });
            }
            return fail(
              `no element matching role=${role ?? "any"} name="${name}" on ${tabUrl}`,
              similar.length
                ? `similar elements: ${similar.slice(0, 5).map((m) => `${m.role} "${m.name}"`).join(", ")} — retry with one of those`
                : "call agent_browser_visit to refresh the page snapshot, OR widen the name to a less specific substring",
            );
          }

          // 2. Act with the just-located ref + matching generation.
          //
          // A click that navigates tears down the document it ran in, so the
          // engine's reply can be lost to a closed port. That is SUCCESS, not
          // failure — the SW distinguishes it (PORT_CLOSED_AFTER_ACTION) rather
          // than retrying, which would fire the action a second time.
          let result: { acted?: boolean; changed?: boolean; signals?: Record<string, unknown> };
          try {
            result = (await ctx.bridge.request("engine.act", {
              ref: match.ref,
              gen: loc.snapshotGeneration,
              action,
              value,
            })) as typeof result;
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
              await new Promise((r) => setTimeout(r, 700));
              const recheck = (await ctx.bridge.request("engine.ping", {})) as {
                tab?: { url?: string; status?: string };
              };
              // A pending navigation hasn't changed the URL yet but proves the
              // click landed — treating that as dead would fire it twice.
              const navigating = recheck.tab?.status === "loading";
              dead = !navigating && (recheck.tab?.url ?? tabUrl) === tabUrl;
            }
            if (dead) {
              escalated = "robust";
              ctx.audit.log("act.escalate_robust_click", { name, role, url: tabUrl });
              await ctx.bridge
                .request("engine.robustClick", { ref: match.ref })
                .catch(() => {});
            }
          }

          // 3. Give the page a moment to settle (navigation or DOM update).
          await ctx.bridge
            .request("engine.waitForStable", { timeout: 6000, quietMs: 400 })
            .catch(() => {});

          // 4. Re-observe so the agent's next call has fresh state.
          //
          // The action already happened. If the snapshot can't be taken — the
          // page is still committing, or an extension-hostile document like
          // chrome:// is in the way — that's a degraded result, not a failed
          // action. Reporting it as an error would invite the agent to retry
          // and perform the action twice.
          let after: Snap;
          try {
            if (snapshot === "none") {
              const p = await ping();
              after = { url: p.tab?.url, title: p.tab?.title };
            } else {
              after = await attachText(
                (await ctx.bridge.request("engine.observe", {
                  mode: "semantic",
                  viewportOnly: snapshot === "viewport",
                })) as Snap,
                false,
              );
            }
          } catch (obsErr) {
            const p = await ping().catch(() => ({}) as Awaited<ReturnType<typeof ping>>);
            ctx.audit.log("act.observe_failed", { name, action, msg: (obsErr as Error).message });
            after = {
              url: p.tab?.url,
              title: p.tab?.title,
              snapshotUnavailable: (obsErr as Error).message,
              hint: "action succeeded; call agent_browser_visit or browser_observe for a fresh tree",
            };
          }

          // One answer to "did we navigate", measured after the settle. The
          // engine's own flag is taken 60ms after the action, before most
          // navigations commit, so the two used to disagree.
          const navigated = tabUrl !== after.url;
          // An action meant to change something that changed nothing is not a
          // success. The Enter that did nothing on Wikipedia came back as a
          // plain `acted: true`; say so instead, so the caller tries another way.
          const noEffect =
            !["hover", "focus"].includes(action) && !navigated && result.changed === false;
          const warning = !noEffect
            ? undefined
            : escalated === "robust"
              ? "the first click changed nothing; a page-world retry ran and the URL did not change. Check snapshotAfter before assuming it worked"
              : "nothing on the page changed (no navigation, no DOM or value change): this probably did not do what you intended";

          ctx.audit.log("tool.agent_browser_act", { name, role, action, urlBefore: tabUrl, urlAfter: after.url, noEffect });
          return ok({
            acted: true,
            target: { ref: match.ref, role: match.role, name: match.name },
            action,
            value,
            signals: { ...(result.signals ?? {}), navigated },
            escalated,
            navigated,
            ...(noEffect ? { noEffect, warning } : {}),
            urlBefore: tabUrl,
            urlAfter: after.url,
            snapshotAfter: after,
          });
        });
      } catch (e) {
        // The action may already have run, so never advise a blind retry.
        return failWith(e, "check the page (agent_browser_visit) before retrying — the action may have run");
      }
    },
  );

  // ============================================================
  // [ADVANCED] PRIMITIVE BROWSER TOOLS — for fine-grained control
  // Most agents should prefer the high-level tools above.
  // ============================================================

  server.tool(
    "browser_status",
    "[advanced] Report whether the agent Chrome / bridge is connected. Prefer `agent_browser_status`.",
    {},
    async () => ok({ bridgeConnected: ctx.bridge.connected() }),
  );

  server.tool(
    "browser_ping",
    "[advanced] Round-trip a ping through the bridge to the in-page content engine.",
    { session: z.string().default("default") },
    async ({ session }) => {
      try {
        const r = await ctx.sessions.withLock(session, () =>
          ctx.bridge.request("engine.ping", { session }),
        );
        ctx.audit.log("tool.browser_ping", { session });
        return ok(r);
      } catch (e) {
        return failWith(e, "open a tab, then retry");
      }
    },
  );

  server.tool(
    "browser_observe",
    [
      "Observe the active tab without navigating. semantic = the accessibility tree with refs ",
      "(default); read = the page's visible text, paged with offset/maxChars (the result gives ",
      "nextOffset while there is more); marks = tree plus a screenshot with each ref's number drawn on.",
    ].join(""),
    {
      session: z.string().default("default"),
      mode: z.enum(["semantic", "read", "marks"]).default("semantic"),
      offset: z.number().int().min(0).optional().describe("read mode: character offset to start from"),
      maxChars: z.number().int().min(100).max(50_000).optional().describe("read mode: how much text to return (default 8000)"),
    },
    async ({ session, mode, offset, maxChars }) => {
      try {
        const r = (await ctx.sessions.withLock(session, () =>
          ctx.bridge.request("engine.observe", { session, mode, offset, maxChars }),
        )) as Record<string, unknown>;
        ctx.audit.log("tool.browser_observe", { session, mode });
        const img = imageContent(r.screenshot);
        if (img) delete r.screenshot;
        const content = [
          { type: "text" as const, text: JSON.stringify(r, null, 2) },
          ...(img ? [img] : []),
        ];
        return { content };
      } catch (e) {
        return failWith(e, "retry; if it repeats, call agent_browser_status");
      }
    },
  );

  server.tool(
    "browser_locate",
    "[advanced] Find elements by semantic locator (role and/or accessible name) in the active tab. Returns matching stable refs.",
    {
      session: z.string().default("default"),
      role: z.string().optional(),
      name: z.string().optional(),
    },
    async ({ session, role, name }) => {
      try {
        const r = await ctx.sessions.withLock(session, () =>
          ctx.bridge.request("engine.locate", { role, name }),
        );
        ctx.audit.log("tool.browser_locate", { session, role, name });
        return ok(r);
      } catch (e) {
        return failWith(e, "open a page, then retry");
      }
    },
  );

  const activeUrl = async (session: string): Promise<string> => {
    const r = (await ctx.bridge.request("engine.ping", { session })) as {
      tab?: { url?: string };
    };
    return r.tab?.url ?? "";
  };

  server.tool(
    "browser_navigate",
    "[advanced] Start a navigation and return at once, without waiting for the page or returning a snapshot. Prefer `agent_browser_visit` ({url} or {history}), which waits and returns the new page. url=go to URL, or action=back|forward|reload.",
    {
      session: z.string().default("default"),
      url: z.string().url().optional(),
      action: z.enum(["back", "forward", "reload"]).optional(),
    },
    async ({ session, url, action }) => {
      try {
        const target = url ?? (await activeUrl(session));
        if (DRY_RUN) {
          ctx.audit.log("dryrun.browser_navigate", { target });
          return ok({ dryRun: true, wouldNavigate: url ?? action });
        }
        const r = await ctx.sessions.withLock(session, () =>
          ctx.bridge.request("engine.navigate", { url, action }),
        );
        ctx.audit.log("tool.browser_navigate", { session, target });
        return ok(r);
      } catch (e) {
        return failWith(e, "retry; or open the page with agent_browser_visit({url})");
      }
    },
  );

  server.tool(
    "browser_act",
    "[advanced] Act on an element by ref from the latest observe snapshot. Re-observe after (refs go stale). actions: click/type/fill/clear/press/hover/focus/check/uncheck/select/submit.",
    {
      session: z.string().default("default"),
      ref: z.number().int(),
      gen: z.number().optional(),
      action: z.enum([
        "click", "type", "fill", "clear", "press", "hover",
        "focus", "check", "uncheck", "select", "submit",
      ]),
      value: z.string().optional(),
      actionClass: z.string().optional(),
    },
    async ({ session, ref, gen, action, value, actionClass }) => {
      try {
        const url = await activeUrl(session);
        const d = ctx.policy.evaluate({ url, actionClass });
        if (!d.allow) {
          ctx.audit.log("policy.block", { tool: "browser_act", url, action, reason: d.reason });
          return fail(`blocked by policy: ${d.reason}`, POLICY_ADVICE);
        }
        if (DRY_RUN) {
          ctx.audit.log("dryrun.browser_act", { url, action, ref });
          return ok({ dryRun: true, wouldAct: { action, ref, value }, url, policy: d.reason });
        }
        let r: unknown;
        try {
          r = await ctx.sessions.withLock(session, () =>
            ctx.bridge.request("engine.act", { ref, gen, action, value }),
          );
        } catch (e) {
          // Same rule as agent_browser_act: a port that closed mid-action means
          // the action navigated — it ran. This used to come back as an error
          // advising "re-observe and retry", i.e. firing it a second time.
          if (!PORT_DIED.test((e as Error).message)) throw e;
          r = { acted: true, changed: true, signals: { navigated: true, portClosed: true }, snapshotStale: true };
        }
        ctx.audit.log("tool.browser_act", { session, url, action, ref });
        return ok(r);
      } catch (e) {
        return failWith(e, "re-observe before retrying — the action may have run");
      }
    },
  );

  server.tool(
    "browser_robust_click",
    [
      "[advanced] Click a ref in the PAGE's own JS world, for buttons that ignore an ",
      "ordinary click. Waits for React hydration, forces focus/visibility, then tries an ",
      "authentic pointer sequence, native click, the React fiber onClick, and formAction ",
      "in turn — reporting which strategies ran. `agent_browser_act` already escalates to ",
      "this automatically; reach for it directly only when driving refs by hand.",
    ].join(""),
    {
      session: z.string().default("default"),
      ref: z.number().int(),
      hydrationTimeoutMs: z.number().int().default(4000),
    },
    async ({ session, ref, hydrationTimeoutMs }) => {
      try {
        if (DRY_RUN) return ok({ dryRun: true, wouldRobustClick: ref });
        const r = await ctx.sessions.withLock(session, () =>
          ctx.bridge.request("engine.robustClick", { ref, hydrationTimeoutMs }),
        );
        ctx.audit.log("tool.browser_robust_click", { session, ref });
        return ok(r);
      } catch (e) {
        return failWith(e, "re-observe before retrying — the click may have run");
      }
    },
  );

  server.tool(
    "browser_wait_for_navigation",
    [
      "[advanced] Wait until the browser commits a navigation whose URL matches a regex, ",
      "and return that URL with its query parameters parsed out. For redirect-driven flows ",
      "— OAuth consent, SSO hand-off, payment return, magic links — where the value you need ",
      "arrives as a URL that may bounce onward before you could observe it. Recent history is ",
      "checked first, so a redirect that already landed is still caught.",
    ].join(""),
    {
      urlPattern: z
        .string()
        .describe("JS regex matched against the full URL, e.g. \"/callback\\\\?code=\" or \"^https://example\\\\.com/done\""),
      timeoutMs: z.number().int().default(20_000),
      lookbackMs: z
        .number()
        .int()
        .default(5_000)
        .describe("How far back in navigation history to also consider"),
    },
    async ({ urlPattern, timeoutMs, lookbackMs }) => {
      try {
        const r = (await ctx.bridge.request("engine.waitForNavigation", {
          urlPattern,
          timeoutMs,
          sinceTs: Date.now() - lookbackMs,
        })) as { matched?: boolean };
        ctx.audit.log("tool.browser_wait_for_navigation", { urlPattern, matched: !!r.matched });
        if (!r.matched)
          return fail(
            `no navigation matched ${urlPattern} within ${timeoutMs}ms`,
            "widen the pattern, raise timeoutMs, or check recentUrls in the result for what actually loaded",
          );
        return ok(r);
      } catch (e) {
        return failWith(e, "retry; if it repeats, call agent_browser_status");
      }
    },
  );

  server.tool(
    "browser_wait",
    "[advanced] Wait until the page is DOM/network-quiet (no CDP heuristic). Use after navigation or an action that triggers loading.",
    {
      session: z.string().default("default"),
      timeout: z.number().int().default(8000),
      quietMs: z.number().int().default(600),
    },
    async ({ session, timeout, quietMs }) => {
      try {
        const r = await ctx.sessions.withLock(session, () =>
          ctx.bridge.request("engine.waitForStable", { timeout, quietMs }),
        );
        ctx.audit.log("tool.browser_wait", { session });
        return ok(r);
      } catch (e) {
        return failWith(e, "retry; if it repeats, call agent_browser_status");
      }
    },
  );

  server.tool(
    "browser_screenshot",
    [
      "Screenshot the active tab, without CDP. With no options: the visible viewport at full ",
      "sharpness. fullPage:true: the whole page, scrolled and stitched (fixed headers appear ",
      "once). name/role or ref: just that element. clip: a region in CSS pixels measured from ",
      "the top-left of the page (the result's `viewport` gives scrollY to convert from what you ",
      "see). Tall captures come back as several images in page order, each at most 4000px. ",
      "The page's scroll position is restored afterwards.",
    ].join(""),
    {
      session: z.string().default("default"),
      fullPage: z.boolean().default(false),
      name: z.string().optional().describe("Capture the first element whose accessible name contains this"),
      role: z.string().optional().describe("Narrow `name` to a role (button, link, img, heading…)"),
      ref: z.number().int().optional().describe("Capture this element from the latest snapshot"),
      clip: z
        .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
        .optional()
        .describe("Region in CSS pixels, page coordinates"),
      scale: z
        .number()
        .min(0.25)
        .max(4)
        .optional()
        .describe("Image pixels per CSS pixel. Default: the screen's (sharp) — or 1 for fullPage, to keep it small"),
      format: z.enum(["png", "jpeg"]).default("png").describe("jpeg is much smaller for photos and long pages"),
    },
    async ({ session, fullPage, name, role, ref, clip, scale, format }) => {
      const targets = [fullPage, name !== undefined || role !== undefined, ref !== undefined, clip !== undefined];
      if (targets.filter(Boolean).length > 1)
        return fail("give at most one of fullPage, name/role, ref, clip", "pick one target per screenshot");
      try {
        return await ctx.sessions.withLock(session, async () => {
          let target = ref;
          if (name !== undefined || role !== undefined) {
            const loc = (await ctx.bridge.request("engine.locate", { role, name })) as {
              matches?: { ref: number; name: string }[];
            };
            target = loc.matches?.[0]?.ref;
            if (target === undefined)
              return fail(
                `no element matching role=${role ?? "any"} name="${name ?? ""}"`,
                "widen the name to a shorter substring, or drop role",
              );
          }
          const r = (await ctx.bridge.request(
            "engine.screenshot",
            { fullPage, ref: target, clip, scale, format },
            90_000,
          )) as Record<string, unknown> & { screenshot?: string; images?: string[] };
          ctx.audit.log("tool.browser_screenshot", { session, fullPage, ref: target, clip: !!clip });
          const images = (r.images ?? [r.screenshot]).map(imageContent).filter((i) => i !== null);
          if (!images.length) return fail("no screenshot came back", "retry; if it repeats, call agent_browser_status");
          const { screenshot: _s, images: _i, ...meta } = r;
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ ...meta, ...(images.length > 1 ? { tiles: images.length } : {}) }) },
              ...images,
            ],
          };
        });
      } catch (e) {
        return failWith(e, "retry; if it repeats, call agent_browser_status");
      }
    },
  );

}
