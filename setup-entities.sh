#!/usr/bin/env bash
set -euo pipefail

# Local Dev — Seed entity interactions (real API)
#
# Drives three real submitter flows against one PP so the provider-console
# "Entities" section shows the full range of states, produced entirely through
# the public API (no DB writes):
#
#   K1  unauthorized bundle submit (403) → then KYC register → APPROVED
#   K2  unauthorized bundle submit (403) → stays UNVERIFIED
#   K3  KYC register (APPROVED) → then a real deposit bundle (accepted)
#
# Requires: up.sh + setup-c.sh + setup-pp.sh (reads .local-dev-state).
#
# Env overrides:
#   PP_INDEX        default 1   (which PP_<n>_* in the state file to seed)
#   DEPOSIT_AMOUNT  default 50  (XLM for K3's accepted deposit)
#
# Usage:
#   ./setup-entities.sh

DENO_BIN="${DENO_BIN:-deno}"
command -v "$DENO_BIN" >/dev/null 2>&1 || DENO_BIN="$HOME/.deno/bin/deno"

cd "$(dirname "$0")"
exec "$DENO_BIN" run --allow-all setup-entities.ts "$@"
