import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "../bridge/server.js";
import type { Policy } from "../policy.js";
import type { SessionManager } from "../sessions.js";
import type { Audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { hostHelper } from "../host-helper-client.js";
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
const PORT_DIED = /PORT_CLOSED_AFTER_ACTION|back\/forward cache|message channel is closed|Receiving end does not exist/i;

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
      "connected, launching the browser via the host helper if needed. Idempotent. ",
      "Use this before any agent_browser_visit / advanced browser_* calls.",
    ].join(""),
    { timeoutMs: z.number().int().default(45_000) },
    async ({ timeoutMs }) => {
      if (ctx.bridge.connected()) return ok({ already: true, bridgeConnected: true });
      if (await ctx.bridge.waitForConnection(8_000))
        return ok({ already: true, bridgeConnected: true, waited: true });
      if (!hostHelper.available())
        return fail(
          "stealth Chrome not running and host helper unavailable",
          "install the host helper (host-helper:install)",
        );
      await hostHelper.launchChrome().catch(() => {});
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (ctx.bridge.connected())
          return ok({ launched: true, bridgeConnected: true, waitedMs: Date.now() - t0 });
        await new Promise((r) => setTimeout(r, 1500));
      }
      return fail(
        `bridge not connected within ${timeoutMs}ms`,
        "the extension may need to be loaded once via chrome://extensions → Load unpacked",
      );
    },
  );

  server.tool(
    "agent_browser_visit",
    [
      "Navigate the persistent agent browser to a URL (policy-gated), wait for it to ",
      "settle, and return a compact accessibility-tree snapshot. Auto-ensures the ",
      "browser is running first. Use this for read/observe tasks.",
    ].join(""),
    {
      url: z.string().url(),
    },
    async ({ url }) => {
      // ensure running
      if (!ctx.bridge.connected()) {
        // The worker may just be reconnecting (browser starting, extension
        // reloaded). Give it a moment before concluding nothing is there.
        await ctx.bridge.waitForConnection(8_000);
      }
      if (!ctx.bridge.connected()) {
        if (!hostHelper.available())
          return fail("agent browser not running", "install host helper, or run `npm run launch` on host");
        await hostHelper.launchChrome().catch(() => {});
        const t0 = Date.now();
        while (Date.now() - t0 < 45_000 && !ctx.bridge.connected())
          await new Promise((r) => setTimeout(r, 1500));
        if (!ctx.bridge.connected())
          return fail("agent browser failed to come up within 45s", "see ~/.agent-chrome/host-helper.log");
      }
      // Navigation is read-only and unrestricted — any URL is fair game. The
      // sensitive-action gate lives in agent_browser_act, and only for the
      // action classes a caller explicitly labels.
      try {
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
              await ctx.bridge
                .request("engine.waitForStable", { timeout: 8000, quietMs: 600 })
                .catch(() => {});
              const snap = await ctx.bridge.request("engine.observe", { mode: "semantic" });
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
      "Policy-gated; sensitive actions on untrusted domains escalate.",
    ].join(""),
    {
      name: z.string().describe("Accessible name (button label, link text, input placeholder/label) — case-insensitive substring match"),
      role: z.string().optional().describe("Optional role filter: button, link, textbox, checkbox, combobox, etc. Recommended when the name is ambiguous."),
      action: z
        .enum(["click", "type", "fill", "clear", "press", "hover", "focus", "check", "uncheck", "submit"])
        .default("click")
        .describe("click (default) | type (append text) | fill (replace text) | clear | press (key, value=key) | hover | focus | check | uncheck | submit"),
      value: z.string().optional().describe("Required for type/fill/press; for press it's the key (e.g. \"Enter\")"),
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
    async ({ name, role, action, value, actionClass, robust, session }) => {
      try {
        if (existsSync(resolve(ctx.cfg.stateDir, "HALT")))
          return fail("HALTED: kill switch active", "rm ~/.agent-chrome/HALT to resume");

        // Ensure browser is running (same idempotent pattern as agent_browser_visit).
        if (!ctx.bridge.connected()) {
          await ctx.bridge.waitForConnection(8_000);
        }
        if (!ctx.bridge.connected()) {
          if (!hostHelper.available())
            return fail("agent browser not running", "install host helper, or call agent_browser_ensure_running first");
          await hostHelper.launchChrome().catch(() => {});
          const t0 = Date.now();
          while (Date.now() - t0 < 45_000 && !ctx.bridge.connected())
            await new Promise((r) => setTimeout(r, 1500));
          if (!ctx.bridge.connected())
            return fail("agent browser failed to come up within 45s", "see ~/.agent-chrome/host-helper.log");
        }

        // Policy gate: only fires for an explicitly labelled sensitive class.
        // A plain click/type/submit is an ordinary action anywhere on the web.
        const ping = (await ctx.bridge.request("engine.ping", {})) as { tab?: { url?: string } };
        const tabUrl = ping.tab?.url ?? "";
        const d = ctx.policy.evaluate({ url: tabUrl, actionClass });
        if (!d.allow)
          return fail(
            `blocked by policy: ${d.reason}`,
            "sensitive action needs human approval — add the domain to policy.trustedDomains in config/default.json if you want it autonomous",
          );

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
          if (!match)
            return fail(
              `no element matching role=${role ?? "any"} name="${name}" on ${tabUrl}`,
              "call agent_browser_visit to refresh the page snapshot, OR widen the name to a less specific substring",
            );

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
          let after: Record<string, unknown>;
          try {
            after = (await ctx.bridge.request("engine.observe", { mode: "semantic" })) as Record<
              string,
              unknown
            >;
          } catch (obsErr) {
            const ping = (await ctx.bridge
              .request("engine.ping", {})
              .catch(() => ({}))) as { tab?: { url?: string; title?: string } };
            ctx.audit.log("act.observe_failed", { name, action, msg: (obsErr as Error).message });
            after = {
              url: ping.tab?.url,
              title: ping.tab?.title,
              snapshotUnavailable: (obsErr as Error).message,
              hint: "action succeeded; call agent_browser_visit or browser_observe for a fresh tree",
            };
          }

          ctx.audit.log("tool.agent_browser_act", { name, role, action, urlBefore: tabUrl, urlAfter: (after as { url?: string }).url });
          return ok({
            acted: true,
            target: { ref: match.ref, role: match.role, name: match.name },
            action,
            value,
            signals: result.signals ?? {},
            escalated,
            navigated: tabUrl !== (after as { url?: string }).url,
            urlBefore: tabUrl,
            urlAfter: (after as { url?: string }).url,
            snapshotAfter: after,
          });
        });
      } catch (e) {
        const msg = (e as Error).message;
        const recovery = /STALE_SNAPSHOT|REF_NOT_FOUND/.test(msg)
          ? "the page changed under us — call agent_browser_visit OR re-call agent_browser_act with the same name (a fresh locate runs internally)"
          : /NOT_ACTIONABLE/.test(msg)
            ? "element not actionable (hidden/disabled/covered); wait or scroll, then retry"
            : "retry after agent_browser_status reports bridgeConnected:true";
        return fail(msg, recovery);
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
        return fail((e as Error).message, "ensure agent Chrome is launched and a tab is open");
      }
    },
  );

  server.tool(
    "browser_observe",
    "[advanced] Observe the active tab. Prefer `agent_browser_visit` for read tasks. semantic=compact synthetic accessibility tree w/ stable refs (default); read=distilled text; marks=tree + numbered screenshot overlay.",
    {
      session: z.string().default("default"),
      mode: z.enum(["semantic", "read", "marks"]).default("semantic"),
    },
    async ({ session, mode }) => {
      try {
        const r = (await ctx.sessions.withLock(session, () =>
          ctx.bridge.request("engine.observe", { session, mode }),
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
        return fail((e as Error).message, "re-launch agent Chrome or open a tab, then retry");
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
        return fail((e as Error).message, "open a page then retry");
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
    "[advanced] Low-level navigate. Prefer `agent_browser_visit`. url=go to URL, or action=back|forward|reload. Policy-gated.",
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
        return fail((e as Error).message, "ensure agent Chrome is launched");
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
          return fail(
            `blocked by policy: ${d.reason}`,
            "sensitive action needs human approval — add the domain to policy.trustedDomains in config/default.json if you want it autonomous",
          );
        }
        if (DRY_RUN) {
          ctx.audit.log("dryrun.browser_act", { url, action, ref });
          return ok({ dryRun: true, wouldAct: { action, ref, value }, url, policy: d.reason });
        }
        const r = await ctx.sessions.withLock(session, () =>
          ctx.bridge.request("engine.act", { ref, gen, action, value }),
        );
        ctx.audit.log("tool.browser_act", { session, url, action, ref });
        return ok(r);
      } catch (e) {
        const msg = (e as Error).message;
        const recovery = /STALE_SNAPSHOT|REF_NOT_FOUND/.test(msg)
          ? "call browser_observe again to refresh refs, then retry"
          : /NOT_ACTIONABLE/.test(msg)
            ? "element not actionable; wait or scroll, then re-observe"
            : "re-observe and retry";
        return fail(msg, recovery);
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
        return fail((e as Error).message, "re-observe to refresh refs, then retry");
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
        return fail((e as Error).message, "ensure the browser is running and a tab is open");
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
        return fail((e as Error).message, "ensure a tab is open");
      }
    },
  );

  server.tool(
    "browser_screenshot",
    "[advanced] Capture the active tab's visible viewport (PNG) without CDP.",
    { session: z.string().default("default") },
    async ({ session }) => {
      try {
        const r = (await ctx.sessions.withLock(session, () =>
          ctx.bridge.request("engine.screenshot", {}),
        )) as Record<string, unknown>;
        ctx.audit.log("tool.browser_screenshot", { session });
        const img = imageContent(r.screenshot);
        return img
          ? { content: [{ type: "text" as const, text: JSON.stringify({ url: r.url }) }, img] }
          : fail("no screenshot", "ensure a tab is focused");
      } catch (e) {
        return fail((e as Error).message, "ensure agent Chrome is launched");
      }
    },
  );

}
