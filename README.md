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

Register with Claude Code:

```bash
claude mcp add agent-browser --scope user -- node "$PWD/packages/mcp-server/dist/index.js"
```

Optional — auto-launch Chrome when it isn't running:

```bash
npm run host-helper:install
```

Without it the browser tools still work; you just run `npm run launch` yourself
when Chrome is closed.

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
| Tools vanish in a second Claude Code session | The bridge port is single-owner; see below. |
| Extension loaded but never connects | Re-run `node scripts/sync-ext-secret.mjs`, then reload the extension. |

**Single-owner ports.** The server binds `8787`/`8788` and exits if they're
taken, so only one instance can run at a time. Under stdio each Claude Code
session spawns its own — so the second session's server dies on startup. If you
routinely run parallel sessions, run one persistent server (`npm run mcp`) and
point clients at the HTTP transport on `127.0.0.1:8788/mcp` instead.

## Uninstall

```bash
npm run host-helper:uninstall
claude mcp remove agent-browser --scope user
```
