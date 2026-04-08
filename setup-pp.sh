#!/usr/bin/env bash
set -euo pipefail

# Local Dev — Privacy Provider Setup (wrapper)
#
# Registers a Privacy Provider in the council created by setup-c.sh, exercising
# the production join flow end-to-end against the local stack:
#   - Loads admin SK + council ID from .local-dev-state
#   - Generates a fresh PP operator keypair, funds via Friendbot
#   - PP operator authenticates to provider-platform dashboard
#   - PP operator registers a PP via POST /dashboard/pp/register
#   - PP operator submits a signed join envelope via POST /dashboard/council/join
#   - Admin authenticates to council-platform, lists requests, approves
#   - Admin calls on-chain add_provider against the channel-auth contract
#   - Polls provider-platform until the membership flips ACTIVE
#   - Appends PP keys to .local-dev-state
#
# This is production-like — every step exercises the same API surface that
# provider-console + council-console use. If a platform release breaks the
# public surface, this script breaks too. That's intentional.
#
# Prerequisites:
#   - up.sh has been run
#   - setup-c.sh has been run (.local-dev-state exists)
#
# Idempotency: each run generates a fresh PP and registers it. Re-running adds
# a second PP to the same council. To reset to one PP: down → up → setup-c →
# setup-pp.
#
# Usage:
#   ./setup-pp.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DENO_BIN="${DENO_BIN:-deno}"
command -v "$DENO_BIN" >/dev/null 2>&1 || DENO_BIN="$HOME/.deno/bin/deno"
command -v "$DENO_BIN" >/dev/null 2>&1 || {
  echo "ERROR: deno not found. Run up.sh first or install Deno." >&2
  exit 1
}

cd "$SCRIPT_DIR/lifecycle"
exec "$DENO_BIN" run --allow-all setup-pp.ts "$@"
