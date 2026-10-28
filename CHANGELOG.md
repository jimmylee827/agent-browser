# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- **Sessions: one agent, one window.** Each MCP connection gets its own
  background window on its first visit, and every call acts on that tab only —
  two agents no longer type into, navigate or screenshot each other's page, and
  an agent never lands in the user's tab. `session: "shared:<name>"` shares a tab
  on purpose; results then name the `lastActor` and what changed since your last
  call, and `lock: true` leases it. `session: "default"` keeps the old behaviour
  with a warning
- **Structured failures.** Every error carries a `code` (NEEDS_HUMAN, OCCLUDED,
  NO_MATCH, STALE_SNAPSHOT, TAB_GONE, HOVER_NOT_EFFECTIVE, …), `agentCanFix`,
  `fixSteps`, `humanAction` and, for a server problem, `logTail`; codes are
  carried from the page through the extension and the bridge
- `degraded: string[]` on every result: what could not be done as asked
- **Human walls.** A captcha, or a notice whose only way out is disabled, comes
  back as `outcome: "needs_human"` with the blocking element (cross-origin
  iframes now have refs) and a screenshot; a cookie banner as a consent wall
  with its dismiss button's ref. Acting on a blocked element fails `NEEDS_HUMAN`
- **Settled captures and change detection.** Screenshots wait for layout,
  animations, fonts and the network to settle, report `settled`/`settleReason`,
  and carry `documentGeneration` and `layoutHash`
- **Build identity.** `agent_browser_status` reports the server's build against
  the one on disk (`staleBuild` + the restart command), the extension's version
  against the one on disk, and the launcher's; the first result a client gets
  says so once. `agent_browser_ensure_running({restartIfStale: true})`
- `drag` in `agent_browser_act` (range inputs, custom sliders, pointer-capture
  scrubbers, HTML5 drag-and-drop) and `browser_pointer` for raw sequences
- `browser_inspect` (attributes, value, media state, box, topmost-at-centre),
  `browser_eval` (any page but `eval.blockedDomains`), `browser_diagnostics`
  (failed requests everywhere; console errors and exceptions on development
  hosts), and a one-line `diagnostics` summary in visit and act results
- The tree shows `pressed`, `current`, and video/audio elements with their
  state; `details: true` adds hrefs and srcs
- An evidence trail: each visit and screenshot is saved under
  `~/.agent-chrome/sessions/<session>/` and returned as `evidence`
- Tests: `npm test` (unit, in CI) and `npm run test:e2e` (real Google Chrome,
  isolated instance, local fixtures; `npm run test:e2e:setup` once)
- Persistent Chrome + MV3 extension bridge, with no CDP or debugger API
- MCP server exposing `agent_browser_visit` / `agent_browser_act`, plus
  `browser_*` primitives, over stdio and Streamable HTTP
- Dead-click escalation: when a click provably changes nothing,
  `agent_browser_act` re-clicks in the page's own JS world — React hydration
  wait, focus/visibility spoof, authentic pointer sequence, native click,
  React fiber `onClick`, `formAction` POST
- `browser_wait_for_navigation`: match a redirect by URL pattern and read its
  query parameters, backed by a navigation ring buffer, for OAuth/SSO/payment
  return flows
- `npm run mcp:install`: run the server as a launchd daemon, so the bridge
  outlives any single client and survives login
- Optional launchd host-helper that spawns the browser on request
- Accessibility-tree perception with redaction of password, OTP, and card fields
- Kill switch (`npm run halt` / `npm run resume`) and audit log
- Screenshots beyond the viewport: `browser_screenshot` takes `fullPage`
  (scrolled and stitched, fixed headers shown once, long pages split into
  tiles of at most 4000px), one element by `name`/`role` or `ref`, or a `clip`
  region; `scale` and `jpeg` keep large captures small
- `agent_browser_visit({history: "back" | "forward" | "reload"})`, settled and
  with a snapshot, and `text: true` to get the page's visible text with the tree
- `agent_browser_act` takes `snapshot: "viewport" | "none"` to shrink its
  result, and `action: "select"` picks a dropdown option by its text
- `browser_observe({mode: "read"})` pages long text with `offset`/`maxChars`
  and says when there is more

- A stdio launcher (`dist/launcher.js`) to register with MCP clients in place
  of the HTTP address. It always loads, so the browser tools exist even when
  everything is off, and it starts the daemon on the first call that needs it.
  Registered by URL, a session that began while the daemon was down had no
  browser tools and no way to get them
- `browser_screenshot` captures tables, rows, figures, images, articles, lists
  and paragraphs by role and name, though the snapshot leaves them out
- `npm run mcp:stop`; the daemon logs the signal it stopped on
- `browser_tabs` lists, switches, opens and closes tabs, and an act that moved
  to a new tab says `switchedTab: {from, to}`
- `browser_scroll` (top, bottom, a screen, or a y; reports `atBottom` and how
  much an infinite feed grew) and `browser_wait({text | name | role, gone?})`
- `agent_browser_act` takes `onDialog: "accept" | "dismiss"` and `dialogText`;
  every confirm/prompt box an action raised is reported in `dialogs`, at any
  snapshot size. `agent_browser_visit` takes `snapshot`, so text can be read
  without the tree
- The tree shows a dropdown's `selected` label and `options`, an input's type
  when it fixes the format, and a radio's or checkbox's `group` (fieldset
  legend), which name matching also accepts ("Pizza Size Small")
- Screenshot results give `bytes` per image

### Fixed
- **A hover that changed nothing no longer reports success.** It applies the
  page's `:hover` rules and fails `HOVER_NOT_EFFECTIVE` when nothing changes
- **Element screenshots no longer capture the sticky header instead.** The
  element is centred, a fixed bar over it is hidden, and anything else covering
  it is an `OCCLUDED` error
- An `<a>` with a click handler and no href (`data-toggle`, `onclick`) is a
  button, found by its text
- A visit to another route on the same host returned the old route's tree: the
  wait now counts commits instead of comparing host names
- `name: "Play"` matched the heading "Player" before the Play button: an exact
  name now beats a prefix, a prefix a substring, a control a heading
- A link that opened a new tab counted as a dead click and was clicked again
- The session mutex never held: the HTTP transport builds a server per request,
  and each had its own session registry. There is one per daemon now
- The extension reloads itself when any of its files (not just `sw.js`) or its
  secret and port differ from what it runs, on start and on every reconnect
- A page's `navigator.credentials.store` is refused in the persistent profile
  and reported, and the first password typed on a host carries a warning
- **A failed action no longer comes back as a success.** The engine reports its
  own failures — no such option, a disabled or covered element — as a reply
  carrying `error`, and nothing checked for it, so `select "Option 9"` returned
  `acted: true` with nothing selected. The extension now turns those into
  errors, for every method. A closed message channel (an action that navigated
  away) is unchanged: still success, still never retried
- Date, time, number and other whole-value fields can be filled. Typing one
  character at a time made every partial value invalid, and Chrome cleared the
  field after each. They are now set in one write; a value the field rejects
  is an error naming the format, and the field keeps its old value
- Same-origin iframes are reachable: an editor's body (TinyMCE) is a `textbox`
  you can type into, iframe text appears in read mode, iframe elements are
  labelled from their own document, and positions, the occlusion check and
  screenshots account for the frame's offset
- Menu items, tabs and options take their name from their text (TinyMCE's
  "File" was unnamed)
- Viewport screenshots honour `scale` and `format`
- Element screenshots include text that overflows its box (TodoMVC's heading
  was cut in half)
- A slow form submit is reported as a page still loading (`stillLoading`), not
  as an action with no effect
- The "similar elements" suggestion no longer lists unrelated elements of the
  same role when a name was given
- `agent_browser_status` keeps reporting `serverRunning` once the browser is up,
  and titles are the page's own (not the URL Chrome shows for an untitled page)
- A call no longer hangs for 30s when the extension restarts under it: pending
  calls fail as soon as the connection drops, and read-only ones are re-sent
  once on the new connection. A self-reloading worker now checks itself before
  connecting, so it takes no calls it is about to drop
- A cold start no longer waits 8s for a browser that isn't running (1.1s now)
- `npm run mcp:restart` loads the daemon when it was stopped, instead of
  failing with `Could not find service`
- Full-page captures no longer repeat the scrollbar down the right edge, and
  default to JPEG (a 6.7 MB PNG became about 1.8 MB)
- A missed element lookup in `browser_screenshot` names similar elements, as
  `agent_browser_act` does, and says when nothing has that role
- Custom-styled checkboxes and radios are reachable. Inputs hidden with
  `opacity: 0` (the real control under a painted box, as in TodoMVC) were
  dropped from the snapshot and from lookup; an unlabelled checkbox now takes
  its name from the label beside it
- `press Enter` in a form field submits the form, as a real key press does. A
  synthetic keydown gets no implicit submission, so search boxes silently did
  nothing while the result said `acted: true`
- An action that changed nothing now says so (`noEffect` plus a warning)
  instead of reporting plain success, and the two `navigated` flags agree
- Back and forward work after the tool has clicked through pages. They used
  Chrome's Back button, which skips any page left without a user gesture —
  every page this tool clicks away from — so it went back two pages or failed
  with "Cannot find a next page in history." They now run in the page
- Screenshots no longer fail with "image readback failed" while the agent
  window is behind other windows. macOS Chrome stops painting a covered
  window; the launcher now keeps it painting
  (`--disable-backgrounding-occluded-windows`), and a capture retries briefly
- The numbered overlay (`browser_observe({mode: "marks"})`) is in the image;
  the capture used to run before the overlay was painted
- After an update, the extension's service worker runs the new code. Chrome
  kept running the cached worker across restarts and version bumps — this
  install ran a September build for a month beside a current content engine.
  The worker now compares itself with `src/sw.js` on disk at every start and
  reloads once if they differ
- `browser_act` no longer reports a click that navigated as an error with
  "re-observe and retry" — retrying fired the action twice
- Error advice matches the state: no more "ensure agent Chrome is launched"
  while it is running. A missed lookup names similar elements (a search box
  whose role changed from searchbox to combobox). The kill-switch and policy
  messages tell the agent to stop and ask the user, not how to remove the gate
- A page with nothing interactive (a JSON response) returns its text instead
  of an empty tree. Text keeps its line breaks and indentation, and links are
  named by their visible text before their tooltip
- Full-page captures get a longer bridge timeout than ordinary calls
- `agent_browser_act` can reach elements past the snapshot cap. Refs were only
  assigned to the first 220 nodes the snapshot listed, so on a long page (the
  Hacker News front page, for one) any control after them — footer links,
  "FAQ" — was unreachable by name. Every element now gets a ref; only the
  returned tree is capped, and it reports how many it left out (`omitted`)
- Lookup by name re-indexes the page once before reporting no match, so a
  control that appeared after the last snapshot (an opened menu, an SPA route)
  is found
- Icon-only links and buttons take their name from a child's `aria-label`,
  `alt`, or `title`, instead of showing up unnamed
- The browser launches without the host helper. All three tools that start it
  refused when the helper wasn't installed, and waited 45s for nothing when its
  secret file was on disk but the helper wasn't running. They now share one
  launch path that tries the helper and otherwise spawns the launcher directly,
  and refuses to launch while the kill switch is on
- A click that navigates no longer reports as an error. Chrome tears the
  document down before the async reply lands; that is success, and retrying it
  would fire the action twice
- Content-script injection is idempotent. Re-injection previously stacked a
  second `onMessage` listener, so a stale instance answered into a dead channel
  after a back/forward-cache restore
- Dead-click escalation no longer fires on a pending navigation, which could
  double-submit a non-idempotent button
- The bridge no longer drops after ~30s of inactivity. Chrome suspends an idle
  extension service worker, and the alarm backstop only fires once a minute, so
  tool calls could fail for up to a minute at a time. A 20s server heartbeat
  keeps the worker resident, and callers now wait briefly for a genuine
  reconnect instead of failing on a race
