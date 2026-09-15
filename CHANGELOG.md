# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
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

### Fixed
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
