# agent-browser

A general-purpose **browser body for an AI agent**. It drives a real, persistent
Chrome on your machine over MCP — the agent reads pages as accessibility trees
and acts on them by name. Any site, any flow, no site-specific glue.

```text
snap = agent_browser_visit(url="https://news.ycombinator.com")   # READ
agent_browser_act({ name: "Sign in", action: "click" })          # DO
```

That's the whole API. No refs to track, no snapshot generations, no selectors.

## Why this and not Playwright

- **Stealth-first.** No CDP, no `chrome.debugger`, no Playwright/Puppeteer, no
  automation flags. The browser is an ordinary Chrome — automation fingerprints
  are the primary bot-detection signal, and this avoids all of them.
- **Persistent identity.** One profile at `~/.agent-chrome/profile`. Cookies and
  logins survive reboots, so the agent stays signed in to whatever you signed it
  in to, once.
- **Accessibility-tree perception**, not pixels or raw DOM — compact enough to
  hand an LLM directly, stable enough to act on.

## Architecture

```text
┌──────────────────── Host (macOS) ─────────────────────┐
│                                                        │
│  Chrome (persistent profile, no automation flags)      │
│   └─ Agent Bridge MV3 extension ──┐                    │
│                                   │ ws 127.0.0.1:8787  │
│  mcp-server  ◄────────────────────┘                    │
│   ├─ stdio MCP        → Claude Code et al.             │
│   └─ HTTP MCP :8788   → any HTTP-capable MCP client    │
│                                                        │
│  host-helper :8789 (launchd, optional)                 │
│   └─ one job: spawn GUI Chrome on request              │
└────────────────────────────────────────────────────────┘
```

## Setup

```bash
npm install && npm run build
node scripts/sync-ext-secret.mjs     # generate + inject the bridge secret
npm run launch                       # opens Chrome on the agent profile
```

Then, once: `chrome://extensions` → Developer mode → **Load unpacked** →
select `packages/extension`.

Install the server as a background daemon, and point your client at it:

```bash
npm run mcp:install     # launchd agent, starts at login, restarts on crash
claude mcp add --transport http agent-browser http://127.0.0.1:8788/mcp --scope user
```

Optional — auto-launch Chrome when it isn't running:

```bash
npm run host-helper:install
```

Without it the browser tools still work; you just run `npm run launch` yourself
when Chrome is closed.

### Why a daemon rather than stdio

The extension holds a persistent WebSocket to the bridge, so the bridge has to
outlive any one client. A stdio MCP server lives only as long as the client that
spawned it — between sessions the extension has nothing to connect to. And since
the server owns fixed ports and exits if they're taken, two concurrent stdio
clients fight and the second one dies. One long-lived server fixes both: any
number of clients attach over HTTP.

Stdio still works (`npm run mcp`) if you'd rather run it per-session; just don't
run both.

| | |
| --- | --- |
| `npm run mcp:status` | is it up? |
| `npm run mcp:restart` | reload after `npm run build` |
| `npm run mcp:logs` | follow stderr |
| `npm run mcp:uninstall` | remove the launchd agent |

## Tools

### Primary

| Tool | What it does |
| ---- | ------------ |
| `agent_browser_visit(url)` | Navigate, wait for the page to settle, return an accessibility tree. |
| `agent_browser_act({name, role?, action, value?})` | Find an element by accessible name, act on it, wait, return the new tree. |
| `agent_browser_status()` | Is the browser ready? No side effects. |
| `agent_browser_ensure_running()` | Idempotent launch (auto-fires on first visit). |

`action` is one of `click | type | fill | clear | press | hover | focus |
check | uncheck | submit`. Name matching is case-insensitive substring; pass
`role` when a name is ambiguous.

### Advanced primitives

`browser_status` · `browser_ping` · `browser_observe` · `browser_locate` ·
`browser_navigate` · `browser_act` · `browser_wait` · `browser_screenshot` ·
`browser_robust_click` · `browser_wait_for_navigation`

Ref-based, for surgical control. Most agents never need them.

## Two things that make it work on real sites

**Dead-click escalation.** SPA buttons routinely ignore a synthetic click from
an extension's isolated world — the handler is a React fiber prop, hydration
hasn't attached the listener yet, or the effect is gated on the tab being
focused. When a click provably changes nothing, `agent_browser_act` waits to
confirm, then re-clicks inside the page's own JS world: hydration wait → focus
and visibility spoof → authentic pointer/mouse sequence → native click → React
fiber `onClick` → `formAction` POST, reporting which strategy landed. The
confirm step exists so a slow-but-successful handler is never clicked twice;
pass `robust: "never"` on non-idempotent buttons.

**Redirect capture.** Every top-frame navigation goes into a ring buffer, so
`browser_wait_for_navigation({urlPattern})` can answer "did we pass through a
URL matching this, and what were its query params?" *after* the chain settles.
That's what makes OAuth consent, SSO hand-off, payment returns, and magic links
tractable — you never have to out-run a redirect.

## Safety

Navigation and ordinary interaction are unrestricted — the agent can go
anywhere and click anything. The only gate is **action class**: a caller can
label an action `payment`, `delete_destructive`, `credential_entry`, or
`file_upload`, and those are refused off `policy.trustedDomains`. Add domains
there to make them fully autonomous.

- **Kill switch:** `touch ~/.agent-chrome/HALT` blocks every action.
  `npm run resume` to clear.
- **Dry-run:** `AB_DRY_RUN=1` reports intent without executing.
- **Activity feed:** `npm run activity` (`~/.agent-chrome/audit.log`).
- **Redaction:** password / OTP / card fields are stripped from snapshots
  (`policy.redactSelectors`).

## Layout

- `bin/` — Chrome launcher, profile reset
- `packages/mcp-server/` — MCP server + bridge + control plane (TypeScript)
- `packages/extension/` — MV3 Agent Bridge (service worker + perception/action engine)
- `host-helper/` — optional launchd daemon that spawns GUI Chrome
- `scripts/` — bridge-secret sync, smoke + action tests
- `skills/` — the `persistent-web-engine` agent skill
- `config/default.json` — policy, bridge, profile paths

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `bridge not connected` | Is Chrome open on the agent profile? Is the extension loaded and enabled? |
| Extension loaded but never connects | Re-run `node scripts/sync-ext-secret.mjs`, then reload the extension. |
| Edited extension code, nothing changed | Chrome caches unpacked extensions. Hit reload ↻ on `chrome://extensions` — restarting the browser is often not enough. |
| Daemon crash-looping in the logs | Something else holds `8787`/`8788`. The ports are single-owner; stop the other instance. |

**Service-worker lifetime.** Chrome tears down an extension service worker after
~30s idle, which would drop the bridge between tool calls and leave it down until
the extension's alarm backstop fired up to a minute later. The server sends a
heartbeat every 20s; receiving a WebSocket message resets that idle timer, so the
worker stays resident while the browser is open. Calls that do arrive during a
genuine reconnect (browser just started, extension reloaded) wait up to 8s rather
than failing immediately.

## Uninstall

```bash
npm run host-helper:uninstall
claude mcp remove agent-browser --scope user
```
