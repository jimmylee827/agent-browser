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

Chrome caches unpacked extensions aggressively. After editing anything under
`packages/extension/`, click the reload icon on `chrome://extensions` — a
browser restart alone is often not enough.

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
