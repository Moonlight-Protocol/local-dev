#!/usr/bin/env bash
set -euo pipefail

# Local Dev — Account Funder (wrapper)
#
# Funds Stellar accounts via Friendbot. Generic — takes one or more Stellar
# public keys as arguments. Idempotent: already-funded accounts are reported
# as such and the script exits cleanly.
#
# Usage:
#   ./setup-accounts.sh GABC... GDEF... GHIJ...
#
# For the typical browser-wallet manual test cycle, use the wallet-aware
# wrapper instead, which derives pubkeys from the wallet's seed mnemonics:
#   ./setup-accounts-extension.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DENO_BIN="${DENO_BIN:-deno}"
command -v "$DENO_BIN" >/dev/null 2>&1 || DENO_BIN="$HOME/.deno/bin/deno"
command -v "$DENO_BIN" >/dev/null 2>&1 || {
  echo "ERROR: deno not found. Run up.sh first or install Deno." >&2
  exit 1
}

cd "$SCRIPT_DIR/lifecycle"
exec "$DENO_BIN" run --allow-all setup-accounts.ts "$@"
