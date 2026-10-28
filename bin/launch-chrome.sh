#!/usr/bin/env bash
# Launch a real, non-headless Chrome with the persistent agent profile.
# NO automation flags, NO --remote-debugging-port, NO --headless, NO CDP.
# Automation fingerprints are the primary bot-detection signal we avoid.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="$ROOT/config/default.json"

expand() { local p="$1"; echo "${p/#\~/$HOME}"; }

PROFILE_DIR="$(expand "$(jq -r .profileDir "$CFG")")"
EXT_DIR="$ROOT/packages/extension"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[[ -x "$CHROME" ]] || { echo "Google Chrome not found at expected path." >&2; exit 1; }

mkdir -p "$PROFILE_DIR"

# Chrome uses the system network and the machine's own locale/timezone. Any
# VPN/proxy you want applied is a system-level concern, not this tool's job.

# V8 max old-space heap (MB). Off by default (use Chrome's normal ceiling).
# Set AB_V8_HEAP_MB to override if a legitimately heavy page hits OOM.
V8_HEAP_MB="${AB_V8_HEAP_MB:-}"

echo "Launching agent Chrome:"
echo "  profile : $PROFILE_DIR"
echo "  routing : system network"
if [[ -n "$V8_HEAP_MB" ]]; then
  echo "  v8 heap : ${V8_HEAP_MB} MB per V8 isolate (override)"
  JS_FLAGS_ARG=(--js-flags="--max-old-space-size=${V8_HEAP_MB}")
else
  echo "  v8 heap : Chrome default"
  JS_FLAGS_ARG=()
fi
# Google Chrome ignores --load-extension (since 137): the extension is loaded
# once by hand into the profile, and stays.
echo "  ext     : load once manually via chrome://extensions -> $EXT_DIR"

# --autoplay-policy=no-user-gesture-required: media may play with sound without
# a click first, as on a site a person visits often. An agent's synthetic
# click carries no user gesture, so without it play() was refused; agent
# windows open muted, so nothing is heard. Not an automation switch.
#
# --disable-backgrounding-occluded-windows: keep painting the window while it
# sits behind others. Without it macOS Chrome stops rendering a covered window,
# and every screenshot fails with "image readback failed" until something
# forces a repaint. Not an automation switch, and invisible to pages — the
# page simply stays "visible", as it would for a partly uncovered window.
exec "$CHROME" \
  --user-data-dir="$PROFILE_DIR" \
  ${JS_FLAGS_ARG[@]+"${JS_FLAGS_ARG[@]}"} \
  --disable-backgrounding-occluded-windows \
  --autoplay-policy=no-user-gesture-required \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=Translate \
  "$@"
