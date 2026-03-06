#!/usr/bin/env bash
set -euo pipefail

# Rebuild both wallet extensions (Chrome + Brave)
#
# Usage: ./rebuild.sh

WALLET_PATH="${WALLET_PATH:-$HOME/repos/browser-wallet}"

DENO_BIN="${DENO_BIN:-deno}"
command -v "$DENO_BIN" >/dev/null 2>&1 || DENO_BIN="$HOME/.deno/bin/deno"

cd "$WALLET_PATH"

echo "Building Chrome (dist/chrome/)..."
SEED_FILE=.env.seed.local BUILD_DIR=dist/chrome "$DENO_BIN" task build

echo "Building Brave (dist/brave/)..."
SEED_FILE=.env.seed.local.brave BUILD_DIR=dist/brave "$DENO_BIN" task build

echo "Done."
