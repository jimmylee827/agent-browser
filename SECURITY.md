# Security Policy

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately via [GitHub Security Advisories](https://github.com/jimmylee827/agent-browser/security/advisories/new).

Include a description, steps to reproduce, and the potential impact. Reports
are acknowledged as quickly as practical; this is a personal project, not a
staffed product, so please set expectations accordingly.

## What this software does

agent-browser drives a real Chrome instance on your machine under automated
control. Understand the following before running it:

- **It acts with your browser's full authority.** The profile is persistent, so
  the agent inherits every session you have logged into. Anything you are signed
  in to, it can act as.
- **It listens on localhost.** The bridge (`8787`), control plane (`8788`), and
  optional host-helper (`8789`) bind to `127.0.0.1` and authenticate with a
  shared secret stored 0600 in `~/.agent-chrome/`. Any local process running as
  your user can read that secret — this is a trust boundary of one machine, not
  a sandbox.
- **The extension holds `<all_urls>`.** It can read and act on every page.

Run it with a profile dedicated to the task. Do not sign that profile into
accounts you would not want an automated agent to operate.

## Design principles

- **No CDP / debugger API.** Chrome DevTools Protocol is never attached.
- **No automation flags.** `--remote-debugging-port`, `--enable-automation` and
  friends are never passed.
- **Loopback only.** All listeners bind `127.0.0.1` and reject non-local peers.
- **No credentials in git.** The bridge secret is generated at runtime into
  `~/.agent-chrome/`, never committed.
- **Redaction.** Password, OTP, and card fields are stripped from snapshots via
  `policy.redactSelectors`.
- **Audit log.** Every action is appended to `~/.agent-chrome/audit.log`.
- **Kill switch.** `npm run halt` blocks all browser actions immediately;
  `npm run resume` clears it.

## Responsible use

This project avoids automation fingerprints. That property is here so ordinary
automation is not broken by heuristics aimed at abuse — not to help you
misrepresent yourself to a service that has told you not to automate it.

You are responsible for complying with the terms of service of any site you
point it at, and with the law in your jurisdiction. Do not use it to evade
access controls, defeat anti-abuse systems, scrape in violation of a site's
terms, or operate accounts you are not authorised to operate.
