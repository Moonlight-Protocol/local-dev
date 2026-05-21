#!/usr/bin/env bash
set -euo pipefail

# network-dashboard-demo wrapper.
#
# Continuous demo loop that randomly creates councils and joins PPs to
# existing councils so the network-dashboard at :3040 paints constant
# activity. Each council uses a fresh ephemeral admin key; each PP uses
# a fresh operator key. State is held in-memory by the script — nothing
# is written to .local-dev-state.
#
# Tweak via env:
#   DEMO_MAX_COUNCILS=12   cap on councils created
#   DEMO_SLEEP_MIN_MS=3000 min jitter between actions
#   DEMO_SLEEP_MAX_MS=8000 max jitter between actions
#
# Ctrl-C to stop.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DENO_BIN="${DENO_BIN:-deno}"
command -v "$DENO_BIN" >/dev/null 2>&1 || DENO_BIN="$HOME/.deno/bin/deno"
command -v "$DENO_BIN" >/dev/null 2>&1 || {
  echo "ERROR: deno not found. Run up.sh first or install Deno." >&2
  exit 1
}

cd "$SCRIPT_DIR"
exec "$DENO_BIN" run --allow-all network-dashboard-demo.ts "$@"
