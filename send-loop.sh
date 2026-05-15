#!/usr/bin/env bash
set -euo pipefail

DENO_BIN="${DENO_BIN:-deno}"
command -v "$DENO_BIN" >/dev/null 2>&1 || DENO_BIN="$HOME/.deno/bin/deno"

cd "$(dirname "$0")"
exec "$DENO_BIN" run --allow-all send-loop.ts "$@"
