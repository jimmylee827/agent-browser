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
  - `agent_browser_visit({ url } | { history: "back" }, text?, snapshot?)` — navigate (or go back/forward/reload) + wait + return accessibility tree; `text: true` adds the page's visible text, `snapshot: "none"` drops the tree
  - `agent_browser_act({ name, role?, action, value?, snapshot?, onDialog? })` — find element by name + perform action + return new accessibility tree
  - `browser_observe({ mode: "read", offset? })` — the page's text, paged (prices, scores, articles, JSON, iframe content)
  - `browser_screenshot({ fullPage? | name? | ref? | clip? })` — viewport, whole page, one element, or a region
  - `browser_tabs({ action })` — list, switch, open or close tabs
  - `browser_scroll({ to | y })` — scroll the page, load more of an infinite feed
  - `browser_wait({ text? | name? | role?, gone? })` — wait for something to appear or disappear

  Status / lifecycle:
  - `agent_browser_status()` — is the browser ready? (no side effects)
  - `agent_browser_ensure_running()` — idempotent launch (auto-fires on first visit, rarely needed manually)

  Advanced primitives (`[advanced]` in their tool descriptions) — rarely needed: `browser_locate`, `browser_navigate`, `browser_act`, `browser_robust_click`, `browser_wait_for_navigation`.
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

The tree lists what you can act on — links, buttons, fields, headings. Plain
text (paragraphs, prices, scores, a JSON response) is not in it. Ask for the
text when you need to read:

```text
snap = agent_browser_visit({ url: "https://example.com/article", text: true })
# snap.tree[]  — { ref, role, name, interactive?, state? }
# snap.text    — the visible text, first 8000 chars, line breaks kept
# snap.textTruncated / textNextOffset — there is more:
browser_observe({ mode: "read", offset: snap.textNextOffset })   # next page of text
```

A page with nothing interactive (a JSON response, a plain document) gets its
text automatically. A long tree is capped at 220 nodes and says how many it
`omitted`; `agent_browser_act` still finds the omitted ones by name.

### "Click a link or button by name"
```text
agent_browser_act({ name: "Pricing", action: "click" })
# Substring + case-insensitive match. Pass `role: "link"` / `role: "button"` if ambiguous.
```

### "Search for something"
```text
agent_browser_visit(url="https://google.com")
agent_browser_act({ name: "Search", action: "fill", value: "accessibility tree", snapshot: "none" })
agent_browser_act({ name: "Search", action: "press", value: "Enter" })   # submits the form, like a real Enter
```

If a result says `noEffect: true`, the action changed nothing — try another way
(click the search button, or `action: "submit"`) instead of assuming it worked.

### "Keep results small"

Every act and visit returns a snapshot. For a run of fills, pass `snapshot:
"none"` (just url and title) or `"viewport"` (only what is on screen), and take
a full one at the end. To read a page without its tree:
`agent_browser_visit({ url, text: true, snapshot: "none" })`.

### "Go back"
```text
agent_browser_visit({ history: "back" })      # also "forward", "reload"
```

### "A link opened a new tab"
The act result says `switchedTab: { from, to }` and the agent is now on the new
tab. `browser_tabs({ action: "switch", tabId: from })` goes back;
`browser_tabs({ action: "close", tabId: to })` closes it.

### "Scroll, or wait for something"
```text
browser_scroll({ to: "bottom" })        # also "top", "up", "down", or { y }; says atBottom, grewBy
browser_wait({ text: "Order confirmed" })               # until the text appears (max 25s)
browser_wait({ name: "Loading", gone: true })          # until an element goes away
```

### "Dates, times and numbers"
`fill` sets these in one go, in the field's own format: `2026-10-17` for a date,
`19:30` for a time. A value the field rejects is an error that names the
expected format, and the field keeps what it had. The tree shows the type
(`state.inputType: "time"`).

### "Confirm and prompt boxes"
A box the page opens is answered and reported in the act result's `dialogs`,
whatever the snapshot size. The default is OK; pass `onDialog: "dismiss"` for
Cancel, and `dialogText` for a prompt's answer. Answer a "Delete this?" box with
care — it is a decision on the user's behalf.

### "Editors and iframes"
Same-origin iframes are part of the page: their fields are in the tree, their
text is in read mode (under `[frame: …]`), and a rich-text editor's body is a
`textbox` you can `type` into. Cross-origin iframes appear only as a boundary
node.

### "Take a screenshot"
```text
browser_screenshot()                                   # what is on screen
browser_screenshot({ fullPage: true })                 # whole page, stitched; long pages come as several images
browser_screenshot({ name: "History", role: "heading" })   # one element
browser_screenshot({ name: "Star Ferry", role: "table" })  # a table, named by its caption / first text
browser_screenshot({ clip: { x, y, width, height } })      # region, CSS px from the page's top-left
```
Element capture also reaches things the snapshot leaves out — `table`, `row`,
`listitem`, `figure`, `img`, `article`, `list`, `paragraph` — when you give the
role. A miss names the closest candidates. Full pages default to JPEG at 1x
(about a third the size of PNG); pass `format` or `scale` on any capture to
change that. Each result gives `bytes` per image. The
result's `viewport.scrollY` converts what you see on screen into page
coordinates for `clip`.

### "The browser is off"

`agent_browser_status` says `serverRunning: false` without starting anything.
Any other browser tool — `agent_browser_ensure_running` is the obvious one —
starts the server and the browser itself. If a tool answers `HALTED`, the user
switched the kill switch on: stop and tell them.

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
| `select` | pick a dropdown option, by its text or value (a miss lists the options) | yes |

A radio or checkbox also matches by its group: `name: "Pizza Size Small"` picks
the "Small" in the "Pizza Size" fieldset (`state.group`). A dropdown's state
shows the `selected` label and its `options`.

When the action itself fails — no such option, a rejected date, a disabled
button — the call returns an error, never `acted: true`.

## Reading the result of `agent_browser_act`

```json
{
  "acted": true,
  "target": { "ref": 17, "role": "link", "name": "new" },
  "action": "click",
  "navigated": true,                                   // did the URL change?
  "urlBefore": "https://news.ycombinator.com/",
  "urlAfter":  "https://news.ycombinator.com/newest",
  "signals": { "navigated": true, "domMutations": 87, "valueChanged": false },
  "snapshotAfter": { url, title, counts, tree[] }      // fresh AX tree of the new state
}
```

When nothing changed, the result adds `"noEffect": true` and a `warning`.

Feed `snapshotAfter.tree[]` to your next decision — you never have to call `observe` separately.

## When an action can't find the target

If `agent_browser_act` returns:
```json
{ "error": "no element matching role=button name=\"Foo\" on https://...",
  "recovery": "call agent_browser_visit to refresh the page snapshot, OR widen the name ..." }
```

When something similar exists, the recovery names it (`similar elements:
combobox "Search Wikipedia"`) — pages change an element's role under you.

Otherwise, try in this order:
1. Drop the `role` filter (maybe it's a `link` not a `button`)
2. Try a shorter or different substring of the visible label
3. Call `agent_browser_visit` again to refresh — the page may have changed
4. Fall back to `browser_observe` to inspect the actual nodes on the page

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
