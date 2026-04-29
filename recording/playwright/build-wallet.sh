#!/usr/bin/env bash
# Build the Moonlight browser-wallet **without seed injection** so we can
# drive the full onboarding UI on screen during recording.
#
# Usage:
#   ./build-wallet.sh                         # default path (~/repos/browser-wallet)
#   BROWSER_WALLET_REPO=/path/to/repo ./build-wallet.sh
#
# Outputs the unpacked extension at <repo>/dist — the recording playwright
# config loads that path into Chromium.
set -euo pipefail

REPO="${BROWSER_WALLET_REPO:-$HOME/repos/browser-wallet}"

if [ ! -d "$REPO" ]; then
  echo "browser-wallet repo not found at $REPO" >&2
  echo "Set BROWSER_WALLET_REPO to override." >&2
  exit 1
fi

cd "$REPO"

# Move any existing .env.seed aside — recording uses the real onboarding UI,
# not seed injection.
if [ -f .env.seed ]; then
  mv .env.seed ".env.seed.bak.$(date +%s)"
  echo "Moved existing .env.seed aside (seed injection would skip onboarding)."
fi

DENO_BIN="${DENO_BIN:-$HOME/.deno/bin/deno}"
if ! command -v "$DENO_BIN" >/dev/null 2>&1; then
  if command -v deno >/dev/null 2>&1; then
    DENO_BIN=deno
  else
    echo "deno not found; install or set DENO_BIN" >&2
    exit 1
  fi
fi

# Ensure deno is on PATH for child processes spawned by build.ts
export PATH="$(dirname "$DENO_BIN"):$PATH"

"$DENO_BIN" task build

echo ""
echo "browser-wallet built at: $REPO/dist"
