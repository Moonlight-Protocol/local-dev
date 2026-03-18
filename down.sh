#!/usr/bin/env bash
set -euo pipefail

# Local Dev — Down
# Stops all local-dev services and cleans up.
# Does NOT touch shared services (Stellar, Jaeger) or local-dev resources.
#
# Usage: ./down.sh

PROVIDER_PLATFORM_PATH="${PROVIDER_PLATFORM_PATH:-$HOME/repos/provider-platform}"
CONSOLE_PATH="${CONSOLE_PATH:-$HOME/repos/provider-console}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

# Ports & names (must match up.sh)
PROVIDER_PORT=3010
CONSOLE_PORT=3020
PG_CONTAINER="provider-platform-db"
ACCT_ADMIN="admin"
ACCT_PROVIDER="provider"
ACCT_TREASURY="treasury"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }

# --- Stop provider-platform process ---
PID_FILE="$SCRIPT_DIR/.provider.pid"
killed=false

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    info "Stopped provider-platform (PID $PID)"
    killed=true
  fi
  rm "$PID_FILE"
fi

if [ "$killed" = false ]; then
  for pid in $(lsof -ti :"$PROVIDER_PORT" 2>/dev/null || true); do
    if ps -p "$pid" -o command= 2>/dev/null | grep -q deno; then
      kill "$pid" 2>/dev/null
      info "Stopped deno process on port $PROVIDER_PORT (PID $pid)"
    fi
  done
fi

# --- Stop provider-console process ---
CONSOLE_PID_FILE="$SCRIPT_DIR/.console.pid"
console_killed=false

if [ -f "$CONSOLE_PID_FILE" ]; then
  PID=$(cat "$CONSOLE_PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    info "Stopped provider-console (PID $PID)"
    console_killed=true
  fi
  rm "$CONSOLE_PID_FILE"
fi

if [ "$console_killed" = false ]; then
  for pid in $(lsof -ti :"$CONSOLE_PORT" 2>/dev/null || true); do
    if ps -p "$pid" -o command= 2>/dev/null | grep -q deno; then
      kill "$pid" 2>/dev/null
      info "Stopped deno process on port $CONSOLE_PORT (PID $pid)"
    fi
  done
fi

# --- Stop PostgreSQL container ---
if docker ps -a --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1
  info "Stopped PostgreSQL ($PG_CONTAINER)"
fi

# --- Remove Stellar accounts ---
if command -v stellar >/dev/null 2>&1; then
  for name in "$ACCT_ADMIN" "$ACCT_PROVIDER" "$ACCT_TREASURY"; do
    if stellar keys address "$name" >/dev/null 2>&1; then
      stellar keys rm "$name" 2>/dev/null && info "Removed account: $name" || warn "Could not remove account: $name"
    fi
  done
fi

# --- Clean up generated files ---
for f in \
  "$PROVIDER_PLATFORM_PATH/.env" \
  "$SCRIPT_DIR/provider.log" \
  "$SCRIPT_DIR/console.log" \
; do
  if [ -f "$f" ]; then
    rm "$f"
    info "Removed $f"
  fi
done

echo ""
info "Down. local-dev services stopped (shared Stellar & Jaeger left running)."
