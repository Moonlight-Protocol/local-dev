#!/usr/bin/env bash
set -euo pipefail

# Local Dev — Down
#
# Tears down everything up.sh started: services, containers, generated env
# files, log files, and the .local-dev-state file written by setup-c.sh /
# setup-pp.sh.
#
# This is "nuclear cleanup" — when you re-run up.sh you get a clean slate
# (fresh Stellar ledger, empty databases, no contracts, no PPs). Run setup-c
# and setup-pp again to repopulate the application state.
#
# Usage: ./down.sh

BASE_DIR="${BASE_DIR:-$HOME/repos}"
PROVIDER_PLATFORM_PATH="${PROVIDER_PLATFORM_PATH:-$BASE_DIR/provider-platform}"
COUNCIL_PLATFORM_PATH="${COUNCIL_PLATFORM_PATH:-$BASE_DIR/council-platform}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

# Ports & names — must match the values used in up.sh
PROVIDER_PORT="${PROVIDER_PORT:-3010}"
COUNCIL_PLATFORM_PORT="${COUNCIL_PLATFORM_PORT:-3015}"
PROVIDER_CONSOLE_PORT="${PROVIDER_CONSOLE_PORT:-3020}"
COUNCIL_CONSOLE_PORT="${COUNCIL_CONSOLE_PORT:-3030}"
NETWORK_DASHBOARD_PORT="${NETWORK_DASHBOARD_PORT:-3040}"
PG_CONTAINER="${PG_CONTAINER:-provider-platform-db}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }

# --- Helper: stop a process by PID file or port ---
stop_process() {
  local name=$1
  local pid_file=$2
  local port=$3
  local killed=false

  if [ -f "$pid_file" ]; then
    local pid
    pid=$(cat "$pid_file")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      info "Stopped $name (PID $pid)"
      killed=true
    fi
    rm "$pid_file"
  fi

  if [ "$killed" = false ]; then
    for pid in $(lsof -ti :"$port" 2>/dev/null || true); do
      if ps -p "$pid" -o command= 2>/dev/null | grep -q deno; then
        kill "$pid" 2>/dev/null
        info "Stopped deno process on port $port (PID $pid)"
      fi
    done
  fi
}

# --- Stop all processes ---
stop_process "provider-platform" "$SCRIPT_DIR/.provider.pid" "$PROVIDER_PORT"
stop_process "council-platform" "$SCRIPT_DIR/.council-platform.pid" "$COUNCIL_PLATFORM_PORT"
stop_process "provider-console" "$SCRIPT_DIR/.provider-console.pid" "$PROVIDER_CONSOLE_PORT"
stop_process "council-console" "$SCRIPT_DIR/.council-console.pid" "$COUNCIL_CONSOLE_PORT"
stop_process "network-dashboard" "$SCRIPT_DIR/.network-dashboard.pid" "$NETWORK_DASHBOARD_PORT"

# --- Stop PostgreSQL container ---
if docker ps -a --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1
  info "Stopped PostgreSQL ($PG_CONTAINER)"
fi

# --- Stop Jaeger container ---
JAEGER_CONTAINER="${JAEGER_CONTAINER:-jaeger}"
if docker ps -a --format '{{.Names}}' | grep -q "^${JAEGER_CONTAINER}$"; then
  docker rm -f "$JAEGER_CONTAINER" >/dev/null 2>&1
  info "Stopped Jaeger ($JAEGER_CONTAINER)"
fi

# --- Clean up generated files ---
# Note: up.sh no longer creates Stellar keys (account creation moved to
# setup-c.sh / setup-pp.sh, which use ephemeral keys per run — nothing to
# remove from the stellar CLI keyring).
for f in \
  "$PROVIDER_PLATFORM_PATH/.env" \
  "$COUNCIL_PLATFORM_PATH/.env" \
  "$SCRIPT_DIR/.local-dev-state" \
  "$SCRIPT_DIR/provider.log" \
  "$SCRIPT_DIR/council-platform.log" \
  "$SCRIPT_DIR/provider-console.log" \
  "$SCRIPT_DIR/council-console.log" \
  "$SCRIPT_DIR/network-dashboard.log" \
; do
  if [ -f "$f" ]; then
    rm "$f"
    info "Removed $f"
  fi
done

# --- Wipe Deno KV stores ---
# Both platforms persist event-watcher cursors and other state in
# ./.data/memory-kvdb.db relative to their working directory. This file
# survives docker/postgres teardown and would otherwise carry stale ledger
# cursors into the next up cycle (event watcher tries to poll a ledger
# that no longer exists on the freshly-launched Stellar quickstart).
for d in \
  "$PROVIDER_PLATFORM_PATH/.data" \
  "$COUNCIL_PLATFORM_PATH/.data" \
; do
  if [ -d "$d" ]; then
    rm -rf "$d"
    info "Removed $d"
  fi
done

# --- Stop the Stellar quickstart container started by `stellar container start local`.
# This is the same container up.sh launches via the Stellar CLI. Without this
# step, `down → up` reuses the same ledger state — which masks bugs in
# scripts that assume a fresh ledger and breaks deterministic deploys
# (the contracts setup-c.sh deploys at fixed addresses already exist).
if command -v stellar >/dev/null 2>&1; then
  stellar container stop local >/dev/null 2>&1 && info "Stopped Stellar container (stellar-local)" || true
fi
# Belt-and-braces: also force-remove anything that matches the
# stellar-local container name in case the CLI subcommand failed.
if docker ps -a --format '{{.Names}}' | grep -q "^stellar-local$"; then
  docker rm -f stellar-local >/dev/null 2>&1 && info "Force-removed stellar-local container" || true
fi

# --- Tear down lifecycle Docker Compose if running ---
if [ -f "$SCRIPT_DIR/lifecycle/docker-compose.yml" ]; then
  docker compose -f "$SCRIPT_DIR/lifecycle/docker-compose.yml" down 2>/dev/null && info "Stopped lifecycle containers" || true
fi

# --- Clean up old pid files (backward compat) ---
rm -f "$SCRIPT_DIR/.console.pid" "$SCRIPT_DIR/console.log" 2>/dev/null

echo ""
info "Down. All services stopped."
