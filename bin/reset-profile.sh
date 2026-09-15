#!/usr/bin/env bash
# Wipe per-site state in the stealth profile while preserving Cookies (login),
# extension registrations, and preferences. Use this when the stealth Chrome
# starts hitting renderer OOMs / "Aw Snap" on claude.com — almost always
# residual corrupted state from earlier proxied sessions.
set -euo pipefail

PROFILE_ROOT="${HOME}/.agent-chrome/profile"
P="$PROFILE_ROOT/Default"
[[ -d "$P" ]] || { echo "Profile not found at $P" >&2; exit 1; }

echo "→ killing any stealth Chrome processes on this profile…"
pkill -f "user-data-dir=$PROFILE_ROOT" 2>/dev/null || true
# wait for clean shutdown
for _ in 1 2 3 4 5; do
  if ! pgrep -f "user-data-dir=$PROFILE_ROOT" >/dev/null; then break; fi
  sleep 0.5
done
pkill -9 -f "user-data-dir=$PROFILE_ROOT" 2>/dev/null || true
sleep 0.5

# Per-site web-platform state. We KEEP: Cookies*, Extensions/, Extension*,
# Preferences, Bookmarks, Local State (one level up).
echo "→ wiping per-site state (keeping cookies + extensions + prefs)…"
for d in \
  "Cache" \
  "Code Cache" \
  "GPUCache" \
  "DawnGraphiteCache" \
  "DawnWebGPUCache" \
  "Service Worker" \
  "IndexedDB" \
  "Local Storage" \
  "Session Storage" \
  "Sessions" \
  "Storage" \
  "Shared Dictionary" \
  "File System" \
  "databases" \
  "blob_storage" \
  "Application Cache"
do
  if [[ -e "$P/$d" ]]; then
    rm -rf "$P/$d"
    echo "  - $d"
  fi
done

# Top-level browser caches (outside Default/) that also linger.
for d in "ShaderCache" "GraphiteDawnCache" "GrShaderCache" "OptimizationGuidePredictionModels"; do
  if [[ -e "$PROFILE_ROOT/$d" ]]; then
    rm -rf "$PROFILE_ROOT/$d"
    echo "  - (root) $d"
  fi
done

echo "Done. Next:"
echo "  npm run launch                       # fresh Chrome, system networking"
echo "  chrome://extensions -> reload ↻ Agent Bridge"
echo "  npm run smoke                        # verify the bridge is answering"
