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
│  mcp-server (daemon) ◄────────────┘                    │
│   └─ HTTP MCP :8788   → any HTTP-capable MCP client    │
│        ▲                                               │
│  launcher (stdio, one per client session)              │
│   └─ lists tools always; starts the daemon on demand   │
│        ▲  Claude Code et al.                           │
│                                                        │
│  host-helper :8789 (launchd, optional)                 │
│   └─ one job: spawn GUI Chrome on request              │
└────────────────────────────────────────────────────────┘
```

## First call on a fresh machine

Most of it an agent can do itself; one step only a person can.

| Who | Step |
| --- | --- |
| agent | `agent_browser_status` — is the server up, which build, is the extension current? |
| agent | `agent_browser_ensure_running` — starts the server and Chrome as needed |
| **person, once** | `chrome://extensions` → Developer mode → **Load unpacked** → `packages/extension`. Chrome allows no other way to install it. Afterwards the extension reloads itself when its files change; if `agent_browser_status` ever says `extension.stale`, press Reload on its card once. |

### When it is down

1. `agent_browser_status`. If `staleBuild` is true: `agent_browser_ensure_running({restartIfStale: true})`.
2. `agent_browser_ensure_running`.
3. Still failing: the error's `code` and `humanAction` say what is wrong. Tell
   the person in one sentence, and record the step as not done (carry the
   result's `degraded` entries into the final report) — never report a page
   that was not reached as empty.

## Install

Two commands, and one click that Chrome insists a person makes.

```bash
npm install
npm run setup
```

`npm run setup` checks the machine, builds, writes the bridge secret, installs
the server as a login item, launches Chrome on the agent profile, and verifies
the whole chain. It is safe to run again at any time; it only changes what is
missing or out of date.

The one manual step is loading the extension into Chrome — no Chrome release
lets a script do it. Setup opens the right page and waits; in that window:

1. `chrome://extensions`
2. Developer mode (top right)
3. **Load unpacked** → the path setup prints

Then `npm run setup` again, or `npm run doctor`, until it says **Ready**.

| Command | |
| --- | --- |
| `npm run setup` | install and verify everything |
| `npm run doctor` | check only, change nothing (non-zero exit when not ready) |
| `npm run setup -- --with-input` | also set up real OS input (macOS: one Accessibility grant) |
| `npm run setup -- --no-daemon` | do not install the login item |
| `npm run setup -- --fresh` | reinstall dependencies first |

Requirements: Node 20 or newer, and Google Chrome or Chromium. macOS gets the
full set; on Linux the server and browser work, the login item and real input
are macOS-only.

One install per machine: the server owns fixed localhost ports, so a second
clone would fight the first. Setup notices and stops with the path of the one
already running.

Setup registers the launcher with Claude Code when the `claude` CLI is present.
For any other client, register this (not the daemon's HTTP address):

```bash
claude mcp add agent-browser --scope user -- "$(which node)" "$PWD/packages/mcp-server/dist/launcher.js"
```

Register the launcher, not the daemon's HTTP address. A client only reads a
server's tools when a session starts: registered by URL, a session that starts
while the daemon is down gets no browser tools at all, and nothing inside the
session can bring them back. The launcher always starts, lists the tools from
the same code the daemon runs, and starts the daemon on the first call that
needs it. `agent_browser_status` reports "off" without starting anything, and
nothing starts while the kill switch is on.

Clients that only speak HTTP can still use `http://127.0.0.1:8788/mcp` directly.

When Chrome isn't running, the browser tools launch it themselves — the daemon
runs in your GUI login session, so it can open Chrome directly. The host helper
is only needed when the server has no GUI session (for example, run over ssh or
in a container):

```bash
npm run host-helper:install
```

When it is installed and answering, launches go through it; otherwise the
server spawns `bin/launch-chrome.sh` itself.

### Why a daemon rather than stdio

The extension holds a persistent WebSocket to the bridge, so the bridge has to
outlive any one client. A stdio MCP server lives only as long as the client that
spawned it — between sessions the extension has nothing to connect to. And since
the server owns fixed ports and exits if they're taken, two concurrent stdio
clients fight and the second one dies. One long-lived server fixes both: any
number of clients attach over HTTP.

The launcher is a thin stdio front for that one daemon, so many sessions share
it. (`npm run mcp` runs the full server on stdio instead; don't run it beside
the daemon.)

| | |
| --- | --- |
| `npm run mcp:status` | is it up? |
| `npm run mcp:restart` | reload after `npm run build` (loads it if it was stopped) |
| `npm run mcp:stop` | stop it; it starts again at login or on the next browser tool call |
| `npm run mcp:logs` | follow stderr (says why it stopped) |
| `npm run mcp:uninstall` | remove the launchd agent |

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| No `agent-browser` tools in a session | The client is registered by URL, or the registration is missing. Register the launcher (above), then start a new session — or `/mcp` → reconnect. |
| `Could not find service "com.agent-browser.mcp-server"` | Old `mcp:restart`; update, or run `npm run mcp:install`. |
| Tools answer `HALTED` | The kill switch is on (`~/.agent-chrome/HALT`). That is the user's call: `npm run resume`. |

## Sessions: one agent, one window

Each MCP connection (one launcher — one agent conversation) gets its **own
browser window**, opened in the background on its first visit. Its calls act on
its own tab and nothing else: two agents testing the same page never see each
other's typing or navigation, and an agent never lands in a tab the user has
open. Every tool takes an optional `session`:

| `session` | Meaning |
| --- | --- |
| omitted | your private window |
| `"name"` | another private window of yours (for a subagent sharing your connection) |
| `"shared:<name>"` | one tab shared by every caller passing the same name; each result says who else acted since your last call (`lastActor`, `changedSinceYourLastCall`), and `lock: true` leases it |
| `"default"` | the old behaviour — whatever tab is focused — with a warning |

Cookies and logins are **not** separated: there is one browser profile, so a
login in one session is a login in all. Use test accounts you are happy to
leave in that profile; a page's attempt to save a credential
(`navigator.credentials.store`) is refused and reported.

## Results

Every result carries `degraded: string[]` — what could not be done — so a
caller can carry it into its report. Every failure carries a `code`
(`NEEDS_HUMAN`, `OCCLUDED`, `NO_MATCH`, `STALE_SNAPSHOT`, `TAB_GONE`,
`HOVER_NOT_EFFECTIVE`, …), `agentCanFix`, `fixSteps` and `humanAction`, beside
the `error` and `recovery` prose. A captcha or a notice in the way comes back as
`outcome: "needs_human"` with the blocking element and a screenshot.

## Tools

### Primary

| Tool | What it does |
| ---- | ------------ |
| `agent_browser_visit({url} \| {history}, text?, snapshot?, details?)` | Navigate your session's tab — or go back / forward / reload — wait for the page to settle, return an accessibility tree. `text: true` adds the visible text; `snapshot: "none"` drops the tree; `details: true` adds hrefs and srcs. Failed requests and console errors since the call began are summarised in `diagnostics`, the API calls the page made in `network`. |
| `agent_browser_act({name, role?, action, value?, to?, snapshot?, onDialog?})` | Find an element by accessible name, act on it, wait, return the new tree. A failed action is an error; one that changed nothing says `noEffect`. `drag` takes `to` (an element or a point) and `at`/`toAt` as percentages. `waitForResponse: {urlPattern}` also returns the response the action made the page fetch. |
| `browser_observe({mode: "read", offset?})` | The page's visible text, paged, including same-origin iframes. |
| `browser_screenshot({fullPage? \| name? \| ref? \| clip?})` | Viewport, whole page (stitched), one element, or a region — after the page settles (`settled`, `settleReason`), with `documentGeneration` and `layoutHash` to tell two captures of a changed page apart. An element is centred and any fixed bar over it hidden; something else covering it is an `OCCLUDED` error. Saved to disk as `evidence`. |
| `browser_inspect({name \| ref})` | One element's state: attributes (`src`, `href`, every `aria-*`), value, checked, media state, box, visibility, topmost-at-centre. |
| `browser_eval({expression})` | A JS expression in the page, its value as JSON — app state, `video.readyState`. Refused on `eval.blockedDomains`. |
| `browser_network({urlPattern?, status?, type?, includeBodies?, action?})` | What the page sent and received: fetch/XHR bodies (JSON parsed), WebSocket and EventSource messages, headers and timing. `action: "export"` writes a HAR or NDJSON file. See [Network capture](#network-capture). |
| `browser_diagnostics({since?})` | Failed requests (every host); console errors, exceptions and rejections (development hosts). |
| `browser_jobs({action})` | Background jobs: keep a page open, record it, work it with steps, heal it. See [Background jobs](#background-jobs). |
| `browser_pointer({sequence})` | A down / move / up / wheel sequence, for gestures `drag` does not cover. |
| `browser_tabs({action})` | List, switch, open or close tabs. |
| `browser_scroll({to \| y})` | Scroll; reports `atBottom` and how much an infinite feed grew. |
| `browser_wait({text? \| name? \| role?, gone?} \| {response})` | Wait for text or an element to appear or go; for a response (`{urlPattern}`, up to 5 minutes, returned parsed); with none, for the page to go quiet. |
| `agent_browser_status()` | Is the browser ready? No side effects. |
| `agent_browser_ensure_running()` | Idempotent launch (auto-fires on first visit). |

`action` is one of `click | type | fill | clear | press | hover | focus |
check | uncheck | submit | select | drag`. Name matching is case-insensitive:
an exact name wins over a prefix, a prefix over a substring, a control over a
heading; pass `role` when a name is still ambiguous.

Events are synthetic (`isTrusted: false`) — the price of having no CDP. Hover
applies the page's own `:hover` rules and fails with `HOVER_NOT_EFFECTIVE` when
nothing changes; drag works with pointer capture and HTML5 drag-and-drop. Things
that need a real user gesture — `video.play()` with sound, `requestFullscreen` —
are refused by Chrome, and the refusal shows up in `diagnostics`. `snapshot` is `full`
(default), `viewport`, or `none` — use the smaller ones for a run of fills.

### Advanced primitives

`browser_status` · `browser_ping` · `browser_locate` · `browser_navigate` ·
`browser_act` · `browser_robust_click` · `browser_wait_for_navigation`

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

## Real input, viewports and mobile

Synthetic events from an extension carry `isTrusted: false`, and Chrome refuses
some things without a real gesture: sound, fullscreen, some native dialogs.
`agent_browser_act({..., trusted: true})` posts the click or hover from the
operating system instead, through a small macOS helper — the page sees a
person's input. The agent's window comes forward for the instant of the gesture
and focus goes back afterwards; the cursor is put back where it was.

```bash
npm run input-helper:install    # build + start it (asks for Accessibility once)
npm run input-helper:status     # running? allowed?
npm run input-helper:uninstall
```

macOS needs a one-time Accessibility grant: System Settings → Privacy & Security
→ Accessibility → **Agent Browser Input**. It is a separate app so the grant
covers nothing else; after a rebuild macOS treats it as new and asks again.

| Option | On | Gives |
| --- | --- | --- |
| `trusted: true` | `agent_browser_act` (click, hover) | a real gesture: sound without a click first, fullscreen, native dialogs |
| `viewport: {width, height, deviceScaleFactor}` | `agent_browser_visit` (kept for the session) | a real layout at that size — 375px at 3×, media queries included |
| `mobile: true` | `agent_browser_visit` (kept for the session) | a phone's User-Agent and client hints, touch, no hover, a coarse pointer (an approximation, no CDP) |
| `sound: true` | `agent_browser_visit` | this session's page may be heard (agent windows open muted) |
| `allowPopups: true \| false` | visit, act | let the site open a popup without a click (or stop it) — audit-logged |

## Network capture

`chrome.webRequest` sees every request's headers but never a body, so the
extension also records from inside the page: a script in the page's own world,
loaded before any of the page's scripts, records what `fetch`, `XMLHttpRequest`,
`WebSocket` and `EventSource` send and receive. An agent reads the data a page
loaded — a product list, search results, a dashboard's readings — instead of
scraping it off the screen.

```js
agent_browser_act({ name: "Search", waitForResponse: { urlPattern: "/api/search" } })
// → response.json: the results the page fetched
browser_network({ urlPattern: "/api/", includeBodies: true })
browser_network({ action: "export", format: "har" })   // → a file devtools opens
```

- **Where:** every page except `network.blockedDomains` (identity, payment and
  banking hosts by default; edit in `config/local.json`). On those, only what
  `webRequest` sees: status and URL, no headers or bodies.
- **Secrets first:** before anything is stored, the listed headers
  (`Authorization`, `Cookie`, `Set-Cookie`, API keys…) are removed, along with any
  JSON, form or query field whose name matches `network.redactKeys`, JWTs, and
  values the agent typed into password fields. Cookies never reach the extension
  at all.
- **The page must not notice:** each patched function is a Proxy of the original
  and reports itself as native code; `fetch` hands back the browser's own
  promise; only a clone of a response is read. Cross-origin frames (mostly ads and
  fraud scripts) are left alone. A page that compares functions against a
  pristine frame's copy could still tell — that is the remaining risk.
- **Kept:** in the browser (IndexedDB in the agent profile), per tab, up to
  `maxEntriesPerTab` and `retainHours`; cleared when the tab closes and when the
  browser restarts. It is written to disk only when exported, or by a job.
- **Limits:** bodies up to `maxBodyChars`; images, fonts, media, scripts and
  streams are recorded without bodies; WebSocket messages are capped per socket.
  Named EventSource events (`event: foo`), requests from workers, and pages
  opened before capture was on are not recorded (reload the page).

## Background jobs

A job keeps a page open in a window of its own and writes the responses that
match to `~/.agent-chrome/jobs/<id>/<date>.ndjson`, for as long as it runs:
hours or days, beyond any conversation. Start one only for a page you want
watched or recorded over time.

```bash
npm run ab -- jobs start --id readings --url https://dash.example/overview \
  --capture /api/readings --health-text '°C'
npm run ab -- jobs status readings
npm run ab -- jobs tail readings --follow
npm run ab -- jobs stop readings
```

When the page stops answering — its requests fail, or the health text is gone —
the job climbs a ladder: reload, then navigate again, then reopen the window,
then stop and say so (`needs-attention`, `ab jobs status --check` exits 3).
Only a real recovery clears the ladder: good responses and a quiet spell. A
cached answer right after its own reload does not count. Nothing is done while
a page loads, and page loads, scheduled refreshes included, are capped per hour
(`jobs.defaults.maxLoadsPerHour`), so a sick site is never hammered.

### Steps: what a job does on its page

A job can work its page after each load. A page often needs a click before it
shows anything: accept a cookie banner, pick "Today", press Refresh.

```bash
npm run ab -- jobs start --id dash --url https://dash.example/overview \
  --capture /api/readings \
  --step dismiss-consent --step 'click?:Accept all' \
  --step 'click:Today@tab' --step 'click:Refresh'
```

| `--step` | Does |
| --- | --- |
| `dismiss-consent` | Clicks the accept button of a cookie or consent banner, when one shows |
| `click:Name` | Clicks the element with that accessible name (add `@role` to narrow it) |
| `click?:Name` | The same, skipped when it is not there (a banner that only sometimes shows) |
| `fill:Field:value` / `type:Field:value` | Types into a field |
| `fill:Field:@secret` | Types a secret you approved (below) |
| `press:Field:Enter`, `select:Field:Option`, `check:Name` | As they read |
| `wait:Text` | Waits until that text is on the page |

At most 10 steps, run once per page load after `jobs.defaults.pageGraceMs`. A step that
finds nothing (unless marked `?`) counts as the page being unwell: the healing
ladder takes over. No step ever double-fires: steps use a plain click, never the
dead-click retry or real OS input.

### Secrets: a password, code or card a job may type

A job never types into a password, one-time-code or card field on its own. It
does it only from a **secret you approve for a named host**:

```bash
npm run ab -- secrets set shop-login --kind password --host login.shop.example
npm run ab -- secrets set shop-2fa   --kind totp     --host login.shop.example
npm run ab -- secrets list          # names, kinds and hosts — never values
npm run ab -- secrets remove shop-login
```

Then `--step 'fill:Password:@shop-login'`. Kinds: `password`, `totp`,
`card-number`, `card-expiry`, `card-cvc`, `text`.

- **Where it is kept:** the macOS login Keychain. `secrets.json` holds only
  the name, kind and hosts. (Off macOS: a 0600 file in the state dir, and the
  CLI says so.)
- **Where it is used:** only on the hosts you named (or their subdomains). A
  redirect to a look-alike host gets nothing, and the job stops and says so.
- **Where it shows up:** nowhere. Not in `jobs.json`, the job log, the audit
  log, or the recorded traffic: the value is redacted from captures before
  they are stored, whatever the field is called.
- **TOTP** stores the authenticator app's seed (base32 or the `otpauth://`
  link) and computes the six-digit code at the moment it is needed (RFC 6238),
  so a 2FA login can run unattended. An SMS code cannot: it is different every
  time, so that step still needs a person.
- **SMS and push approvals still need you.** A job that meets one flags
  `needs-attention` and waits.

The server drives jobs, not the page: they survive the extension sleeping and
the server restarting (it finds the tab again). The kill switch pauses them;
what the page recorded meanwhile is written when it is lifted. If the browser
stays disconnected — on macOS, a Chrome with no window open has unloaded the
extension — the server opens a window, a few times a day at most. Records are
removed after `evidence.retainDays`.

## From a terminal

Everything an agent's tools can read or start, `npm run ab` does too, with
`--json` for scripts:

```bash
npm run ab -- status
npm run ab -- tabs
npm run ab -- network --tab <id> --url /api/ --bodies
npm run ab -- network --tab <id> --export har
npm run ab -- jobs list
npm run ab -- secrets list
```

## Safety

Navigation and ordinary interaction are unrestricted — the agent can go
anywhere and click anything. The only gate is **action class**: a caller can
label an action `payment`, `delete_destructive`, `credential_entry`, or
`file_upload`, and those are refused off `policy.trustedDomains`.

**Letting an agent ask, and you click approve.** Your own domains live in
`config/local.json`, which is never committed:

```json
{ "policy": { "trustedDomains": ["shop.internal"] } }
```

When a block names a domain, the agent can propose exactly that edit; Claude
Code shows you the diff and you approve it in chat. The server re-reads the
file when it changes, so the next action is allowed — no restart. The agent
never writes the file itself: your approval is what makes the change happen.

- **Kill switch:** `touch ~/.agent-chrome/HALT` blocks every action.
  `npm run resume` to clear.
- **Dry-run:** `AB_DRY_RUN=1` reports intent without executing.
- **Activity feed:** `npm run activity` (`~/.agent-chrome/audit.log`).
- **Redaction:** password / OTP / card fields are stripped from snapshots
  (`policy.redactSelectors`), and secrets from recorded traffic (see
  [Network capture](#network-capture)).
- **Web pages cannot drive it:** the control port listens on 127.0.0.1, which
  any web page in any browser on the machine can reach. Requests carrying what
  only a browser adds (`Origin`, a cross-site `Sec-Fetch-Site`) or naming
  another host (DNS rebinding) are refused and audit-logged.

## Layout

- `bin/` — Chrome launcher, profile reset
- `packages/mcp-server/` — MCP server + bridge + control plane (TypeScript)
- `packages/extension/` — MV3 Agent Bridge: service worker, perception/action engine (`src/content`), the page-world network hook (`src/main`), and its store, redaction and joining (`src/lib`)
- `host-helper/` — optional launchd daemon that spawns GUI Chrome
- `scripts/` — `ab.mjs` (the terminal client), setup, bridge-secret sync, smoke + action tests
- `skills/` — the `persistent-web-engine` agent skill
- `config/default.json` — policy, bridge, profile paths

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `bridge not connected` | Is Chrome open on the agent profile? Is the extension loaded and enabled? |
| Extension loaded but never connects | Re-run `node scripts/sync-ext-secret.mjs`, then reload the extension. |
| Edited extension code, nothing changed | The extension compares its files with what it runs and reloads itself on start and on every reconnect. If `agent_browser_status` still says `extension.stale` (or a call fails `EXTENSION_STALE`), hit reload ↻ on `chrome://extensions` once. |
| `staleBuild: true` in a result | The server runs older code than `dist/`: `npm run mcp:restart`, or `agent_browser_ensure_running({restartIfStale: true})`. A `launcherWarning` means the client's tool list is old: reconnect it (`/mcp`). |
| Daemon crash-looping in the logs | Something else holds `8787`/`8788`. The ports are single-owner; stop the other instance. |

**Service-worker lifetime.** Chrome tears down an extension service worker after
~30s idle, which would drop the bridge between tool calls and leave it down until
the extension's alarm backstop fired up to a minute later. The server sends a
heartbeat every 20s; receiving a WebSocket message resets that idle timer, so the
worker stays resident while the browser is open. Calls that do arrive during a
genuine reconnect (browser just started, extension reloaded) wait up to 8s rather
than failing immediately.

## Tests

```bash
npm test                 # unit tests, no browser (also in CI)
npm run test:e2e:setup   # once: a person loads the extension into a test profile
npm run test:e2e         # end to end, in real Google Chrome
```

The end-to-end tests run a second, isolated instance — their own server on free
ports, real Google Chrome on `~/.agent-chrome-test/profile`, local fixture pages
in `test/fixtures` — and never touch your agent browser, its profile or its
server. Chrome no longer loads extensions from the command line, so the test
profile is set up like the agent profile: the extension is loaded once by hand.

## Uninstall

```bash
npm run host-helper:uninstall
claude mcp remove agent-browser --scope user
```
