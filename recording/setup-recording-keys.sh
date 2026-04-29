#!/usr/bin/env bash
set -euo pipefail

# Local Dev — Recording Keys (wrapper)
#
# Generates and funds keys for one video-recording run. Run this before
# invoking the per-section Playwright recording scripts.
#
# Usage:
#   ./setup-recording-keys.sh                # default master + ISO timestamp run-id
#   RUN_ID=demo-2026-04-28 ./setup-recording-keys.sh
#   MASTER_SECRET=S... FRIENDBOT_URL=http://localhost:8000/friendbot \
#     ./setup-recording-keys.sh
#
# See setup-recording-keys.ts for the full env override list.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DENO_BIN="${DENO_BIN:-deno}"
command -v "$DENO_BIN" >/dev/null 2>&1 || DENO_BIN="$HOME/.deno/bin/deno"
command -v "$DENO_BIN" >/dev/null 2>&1 || {
  echo "ERROR: deno not found. Run up.sh first or install Deno." >&2
  exit 1
}

cd "$SCRIPT_DIR"
exec "$DENO_BIN" run --allow-all setup-recording-keys.ts "$@"
