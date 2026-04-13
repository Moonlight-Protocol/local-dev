#!/usr/bin/env bash
set -euo pipefail

# Local Dev — Browser Extension Account Funder (wrapper)
#
# Reads the browser-wallet's dev-seed files (.env.seed.user1, .env.seed.user2),
# derives the Stellar account at index 0 from each seed mnemonic using SLIP-0010
# (matching the wallet's `Keys.deriveStellarAccountFromMnemonic`), and funds
# those accounts via Friendbot.
#
# Use this in the manual test cycle so the browser extensions land with funded
# Stellar accounts after every `down → up` (the local Stellar ledger is wiped
# each time, so the wallet's previously-funded balances are gone).
#
# Combined with the deterministic local-dev stack (setup-c + setup-pp produce
# the same contract IDs every run), the typical cycle becomes:
#
#   ./down.sh && ./up.sh && ./setup-c.sh && ./setup-pp.sh && ./setup-accounts-extension.sh
#   # then click reload on both extensions in chrome:// and brave://extensions
#
# Prereqs:
#   - up.sh has been run (Friendbot must be reachable)
#   - browser-wallet/.env.seed.user1 and .env.seed.user2 exist
#
# Env overrides:
#   WALLET_SEED_DIR     default ../browser-wallet
#   SEED_FILES          default ".env.seed.user1,.env.seed.user2"
#   DERIVATION_INDEX    default 0
#
# Usage:
#   ./setup-accounts-extension.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DENO_BIN="${DENO_BIN:-deno}"
command -v "$DENO_BIN" >/dev/null 2>&1 || DENO_BIN="$HOME/.deno/bin/deno"
command -v "$DENO_BIN" >/dev/null 2>&1 || {
  echo "ERROR: deno not found. Run up.sh first or install Deno." >&2
  exit 1
}

cd "$SCRIPT_DIR"
exec "$DENO_BIN" run --allow-all setup-accounts-extension.ts "$@"
