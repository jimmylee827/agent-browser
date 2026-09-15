---
name: persistent-web-engine
description: |
  Drive a persistent, stealth-first Chrome on this host via the `agent-browser` MCP server. **Intuitive two-tool API for reading the web AND doing agentic actions on it**: `agent_browser_visit` reads a page (returns an accessibility tree), `agent_browser_act` does an action on it (clicks, types, submits — finds the target by accessible name, no ref bookkeeping needed). Stealth-first (no CDP). Profile is persistent — cookies/logins survive sessions across reboots.

  Trigger this skill when:
  - The user asks to "visit", "open", "read", "scrape", "fetch from", "browse to", "screenshot of", "look up", "check on" any URL or website
  - You need content from a real website that has no public API
  - The user wants you to "click", "fill out", "type into", "submit", "log into", "search on" a website
  - Any multi-step web flow: search-then-click, form-fill-then-submit, navigate-and-extract
  - "Find the link / button / field that says X and ..."

  Primary tools (use these — no `ref` / `snapshotGeneration` to track):
  - `agent_browser_visit(url)` — navigate + wait + return accessibility tree
  - `agent_browser_act({ name, role?, action, value? })` — find element by name + perform action + return new accessibility tree

  Status / lifecycle:
  - `agent_browser_status()` — is the browser ready? (no side effects)
  - `agent_browser_ensure_running()` — idempotent launch (auto-fires on first visit, rarely needed manually)

  Advanced primitives (`[advanced]` in their tool descriptions) — you almost never need these directly: `browser_observe`, `browser_locate`, `browser_navigate`, `browser_act`, `browser_wait`, `browser_screenshot`, `browser_robust_click`, `browser_wait_for_navigation`. They're available for surgical control when the high-level tools aren't enough.
user-invocable: false
---

# Agent Browser

The intuitive read-and-do loop is **two tools**:

```text
snap   = agent_browser_visit(url="https://example.com")          # READ
result = agent_browser_act({ name: "Sign in", action: "click" }) # DO
# result.snapshotAfter is the new page's accessibility tree — feed it to the next decision.
```

That's the whole pattern. No refs, no generations, no manual re-observation. Each `act` call internally does: locate by name → act → wait for the page to settle → re-observe → return.

## Patterns by intent

### "Get information from a page"
```text
snap = agent_browser_visit(url="https://example.com/article")
# snap.tree[] has interactive + landmark nodes:
#   { ref, role, name, interactive?, state? }
# Use snap.title, snap.url, and walk snap.tree for headings/links.
```

### "Click a link or button by name"
```text
agent_browser_act({ name: "Pricing", action: "click" })
# Substring + case-insensitive match. Pass `role: "link"` / `role: "button"` if ambiguous.
```

### "Search for something"
```text
agent_browser_visit(url="https://google.com")
agent_browser_act({ name: "Search", action: "fill", value: "accessibility tree" })  # fill input
agent_browser_act({ name: "Search", action: "press", value: "Enter" })          # submit via Enter
```

### "Fill out a form"
```text
agent_browser_visit(url="https://example.com/signup")
agent_browser_act({ name: "Email",    action: "fill", value: "me@example.com" })
agent_browser_act({ name: "Password", action: "fill", value: "..." })
agent_browser_act({ name: "Sign up",  action: "submit" })
# Ordinary submits run anywhere. Pass actionClass only for genuinely
# consequential steps — see "Safety / policy" below.
```

### "Navigate within a site after a click"
```text
agent_browser_visit(url="https://news.ycombinator.com")
r = agent_browser_act({ name: "new", role: "link", action: "click" })
# r.urlAfter is the new URL; r.snapshotAfter is the new page's tree.
```

### "The button does nothing when clicked"

Handled for you. SPA buttons often ignore a synthetic click — the handler is a
React fiber prop, the listener isn't attached yet, or the effect is gated on the
tab being focused. When a click provably changes nothing, `agent_browser_act`
waits a beat to confirm, then re-clicks inside the page's own JS world
(hydration wait → focus spoof → authentic pointer sequence → native click →
fiber `onClick` → `formAction`).

The result tells you whether that happened:
```json
{ "acted": true, "escalated": "robust", "navigated": true }
```

For a button where firing twice would be harmful — *Place order*, *Send*,
*Delete* — pass `robust: "never"` and handle a dead click yourself.

### "Log in with Google / finish an OAuth or SSO flow"

Redirect chains hand you the value as a URL that may bounce onward before you
can observe it. Don't try to race it — ask afterwards:

```text
agent_browser_act({ name: "Authorize", action: "click" })
browser_wait_for_navigation({ urlPattern: "/callback\\?code=" })
# → { matched: true, url: "...", params: { code: "...", state: "..." } }
```

Recent history is checked first, so a redirect that already landed still counts.

## Action verbs reference

`action` values for `agent_browser_act`:

| verb | what | needs `value`? |
|---|---|---|
| `click` (default) | mouse click | no |
| `type` | append text | yes |
| `fill` | replace existing text with `value` | yes |
| `clear` | empty the input | no |
| `press` | press a key (e.g. `value: "Enter"`) | yes |
| `hover` | hover only, no click | no |
| `focus` | move keyboard focus to element | no |
| `check` / `uncheck` | for checkboxes/radios | no |
| `submit` | submit the form containing the element | no |

## Reading the result of `agent_browser_act`

```json
{
  "acted": true,
  "target": { "ref": 17, "role": "link", "name": "new" },
  "action": "click",
  "navigated": true,                                   // did the URL change?
  "urlBefore": "https://news.ycombinator.com/",
  "urlAfter":  "https://news.ycombinator.com/newest",
  "signals": { "navigated": true, "domMutations": 87 },
  "snapshotAfter": { url, title, counts, tree[] }      // fresh AX tree of the new state
}
```

Feed `snapshotAfter.tree[]` to your next decision — you never have to call `observe` separately.

## When an action can't find the target

If `agent_browser_act` returns:
```json
{ "error": "no element matching role=button name=\"Foo\" on https://...",
  "recovery": "call agent_browser_visit to refresh the page snapshot, OR widen the name ..." }
```

Try in this order:
1. Drop the `role` filter (maybe it's a `link` not a `button`)
2. Try a shorter or different substring of the visible label
3. Call `agent_browser_visit` again to refresh — the page may have changed
4. Fall back to `browser_observe` ([advanced]) to inspect the actual nodes on the page

## Safety / policy

The browser is **open by default** — this is a general web agent, not an
allowlisted one. Reading any URL and ordinary interaction (click, type, fill,
submit) run anywhere without friction.

The one gate is `actionClass`, which **you** set on `agent_browser_act` when a
step is genuinely consequential:

| `actionClass` | Use it for |
|---|---|
| `payment` | placing an order, confirming a charge |
| `delete_destructive` | deleting an account, repo, record |
| `credential_entry` | typing a password or 2FA code |
| `file_upload` | uploading a file from disk |

A labelled action is refused off `policy.trustedDomains` and returns
`blocked by policy`. Surface that to the user and let them decide — adding the
domain to `config/default.json` is their call, not yours.

Label honestly. Under-labelling to avoid a prompt defeats the only guardrail
here; over-labelling ordinary clicks makes the agent useless.

- **Kill switch**: `~/.agent-chrome/HALT` (file) blocks ALL bridge calls. If you see "HALTED: kill switch active", surface it to the user; don't try to work around it.
- All calls audit-logged to `~/.agent-chrome/audit.log`; password / OTP / card fields are redacted from snapshots.

## Don't

- Don't run Selenium / Playwright / CDP / `chrome.debugger` style automation alongside. The whole point is stealth (no automation fingerprint). The MCP tools are the only correct path.
- Don't kill / launch the agent Chrome manually. Use `agent_browser_ensure_running` if needed.
- Don't expect `isTrusted:true` events from synthetic input. A small minority of hardened sites gate on it; if one rejects the click, the tool surfaces the error rather than degrading stealth.
