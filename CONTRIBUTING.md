# Contributing to agent-browser

Contributions are welcome. Issues and pull requests both help.

## Ground rules

1. **No CDP, no Playwright, no Puppeteer.** Stealth-first is a hard constraint,
   not a preference — the whole design follows from it. A patch that attaches
   the debugger will not be merged, however convenient it is.
2. **No credentials committed.** The bridge secret is generated at runtime into
   `~/.agent-chrome/` and must never be checked in.
3. **Don't widen the policy gate silently.** `payment`, `delete_destructive`,
   `credential_entry`, and `file_upload` escalate off the trusted list. If a
   change lets one through without a human, say so explicitly in the PR.
4. **Actions must not be able to fire twice.** Anything state-changing needs to
   be safe against a dropped message channel — see `PORT_DIED` handling in
   `packages/mcp-server/src/tools/index.ts` for why.

## Development setup

```bash
# Prerequisites: Node >= 20, Google Chrome
npm install
npm run build
node scripts/sync-ext-secret.mjs
npm run launch
```

Then load `packages/extension` once via `chrome://extensions` → Developer mode
→ Load unpacked.

Run the server and smoke test:

```bash
npm run mcp      # in one terminal
npm run smoke    # in another
```

### Working on the extension

The content engine (`src/content/engine.js`) is read from disk on each
injection, so reloading the page picks up changes.

The service worker (`src/sw.js`) is different: Chrome keeps running its cached
copy across browser restarts, and even past a manifest version bump. The
worker checks itself on every start: if its running code no longer matches
`src/sw.js` on disk, it reloads the extension once. So after editing it,
restart the agent Chrome — or just wait: the worker wakes at least once a
minute — and the new code takes over. Reload on `chrome://extensions` still
works too.

One caveat: the check compares function bodies, so a change confined to a
top-level constant is not detected. Restarting Chrome won't pick that up
either — press reload on `chrome://extensions`.

## Commit style

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(tools): add browser_wait_for_navigation
fix(extension): replace listener on re-injection instead of stacking
docs: clarify dead-click escalation
```

## Pull requests

1. Branch off `main`.
2. Fill in the PR template.
3. Make sure `npm run build` and `npm run smoke` pass locally.
4. Squash-merge after approval.

## Security issues

Do **not** open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
