#!/usr/bin/env bash
set -euo pipefail

# Local E2E — Down
# Stops all services, removes accounts, and cleans up generated files.
#
# Usage: ./down.sh

PROVIDER_PLATFORM_PATH="${PROVIDER_PLATFORM_PATH:-$HOME/repos/provider-platform}"
WALLET_PATH="${WALLET_PATH:-$HOME/repos/browser-wallet}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

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

# Fallback: kill any deno processes listening on port 3000
if [ "$killed" = false ]; then
  for pid in $(lsof -ti :3000 2>/dev/null || true); do
    if ps -p "$pid" -o command= 2>/dev/null | grep -q deno; then
      kill "$pid" 2>/dev/null
      info "Stopped deno process on port 3000 (PID $pid)"
    fi
  done
fi

# --- Stop Jaeger ---
if docker ps -a --format '{{.Names}}' | grep -q "^jaeger-local$"; then
  docker rm -f jaeger-local >/dev/null 2>&1
  info "Stopped Jaeger"
fi

# --- Stop PostgreSQL ---
if [ -f "$PROVIDER_PLATFORM_PATH/docker-compose.yml" ]; then
  info "Stopping PostgreSQL..."
  docker compose -f "$PROVIDER_PLATFORM_PATH/docker-compose.yml" down 2>/dev/null || warn "docker compose down failed"
fi

# --- Stop local Stellar network ---
if command -v stellar >/dev/null 2>&1; then
  info "Stopping local Stellar network..."
  stellar container stop local 2>/dev/null || warn "Local network was not running"

  for name in admin provider treasury; do
    if stellar keys address "$name" >/dev/null 2>&1; then
      stellar keys rm "$name" 2>/dev/null && info "Removed account: $name" || warn "Could not remove account: $name"
    fi
  done
else
  warn "Stellar CLI not found, skipping network cleanup"
fi

# --- Clean up generated files ---
for f in \
  "$PROVIDER_PLATFORM_PATH/.env" \
  "$WALLET_PATH/.env.seed.local" \
  "$WALLET_PATH/.env.seed.local.brave" \
  "$SCRIPT_DIR/provider.log" \
  "$SCRIPT_DIR/jaeger.log" \
; do
  if [ -f "$f" ]; then
    rm "$f"
    info "Removed $f"
  fi
done

echo ""
info "Down. Everything stopped and cleaned up."
