#!/usr/bin/env bash
set -euo pipefail

# Local Dev — Council Setup (wrapper)
#
# Sets up a council against the running local-dev stack:
#   - Generates an ephemeral admin keypair, funds via Friendbot
#   - Deploys channel-auth + privacy-channel + native XLM SAC contracts
#   - Authenticates as the council admin against council-platform
#   - Creates the council via PUT /council/metadata (production API call)
#   - Adds the XLM channel via POST /council/channels (production API call)
#   - Writes contract IDs + admin SK to .local-dev-state for setup-pp.sh
#
# This is production-like — every step exercises the same API surface that
# council-console uses. If a council-platform release breaks the public surface,
# this script breaks too. That's intentional.
#
# Prerequisites:
#   - up.sh has been run (Stellar quickstart, postgres, jaeger, council-platform)
#
# Usage:
#   ./setup-c.sh
#
# Followups:
#   ./setup-pp.sh    Register a privacy provider in this council

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DENO_BIN="${DENO_BIN:-deno}"
command -v "$DENO_BIN" >/dev/null 2>&1 || DENO_BIN="$HOME/.deno/bin/deno"
command -v "$DENO_BIN" >/dev/null 2>&1 || {
  echo "ERROR: deno not found. Run up.sh first or install Deno." >&2
  exit 1
}

# Use the ADMIN keypair from setup-keys.sh for contract deployment.
KEYS_FILE="$SCRIPT_DIR/.local-dev-keys"
if [ -f "$KEYS_FILE" ]; then
  ADMIN_SK=$(grep "^ADMIN_SK=" "$KEYS_FILE" | cut -d= -f2)
  if [ -n "$ADMIN_SK" ]; then
    export ADMIN_SECRET="$ADMIN_SK"
  fi
fi

cd "$SCRIPT_DIR"
exec "$DENO_BIN" run --allow-all setup-c.ts "$@"
