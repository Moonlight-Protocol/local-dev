#!/usr/bin/env bash
set -euo pipefail

# Local Dev — Up (infrastructure only)
#
# Brings up all the LONG-LIVED INFRA needed by Moonlight: Stellar quickstart,
# PostgreSQL, Jaeger, the platform services (provider, council), and the
# frontend hosts (provider-console, council-console, network-dashboard). All
# services start with infra-only configuration — no Stellar accounts, no
# deployed contracts, no councils, no PPs.
#
# After running this, the platform services are healthy and reachable but the
# protocol state is empty. To populate it, run the app-setup scripts:
#
#   ./setup-c.sh    Deploy contracts + create a council (production-like API flow)
#   ./setup-pp.sh   Register a Privacy Provider in that council (production-like flow)
#
# Both setup scripts are opt-in. If you only want to test something that
# doesn't need a real council/PP (e.g. council-console UI development), run
# `up.sh` alone and skip them.
#
# Why this split exists: account creation, contract deployment, and council/PP
# registration are application-level concerns, not infrastructure. Mixing them
# into up.sh meant every "infrastructure restart" silently rebuilt application
# state, hid which env vars the platforms actually need, and made it impossible
# to test the production setup flow because the local dev path skipped it.
#
# Usage:
#   ./up.sh

BASE_DIR="${BASE_DIR:-$HOME/repos}"
PROVIDER_PLATFORM_PATH="${PROVIDER_PLATFORM_PATH:-$BASE_DIR/provider-platform}"
PROVIDER_CONSOLE_PATH="${PROVIDER_CONSOLE_PATH:-$BASE_DIR/provider-console}"
COUNCIL_CONSOLE_PATH="${COUNCIL_CONSOLE_PATH:-$BASE_DIR/council-console}"
COUNCIL_PLATFORM_PATH="${COUNCIL_PLATFORM_PATH:-$BASE_DIR/council-platform}"
PAY_PLATFORM_PATH="${PAY_PLATFORM_PATH:-$BASE_DIR/pay-platform}"
MOONLIGHT_PAY_PATH="${MOONLIGHT_PAY_PATH:-$BASE_DIR/moonlight-pay}"
NETWORK_DASHBOARD_PATH="${NETWORK_DASHBOARD_PATH:-$BASE_DIR/network-dashboard}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Ports — override via env to run multiple stacks in parallel
STELLAR_RPC_PORT="${STELLAR_RPC_PORT:-8000}"       # shared
JAEGER_OTLP_PORT="${JAEGER_OTLP_PORT:-4318}"       # shared
PG_PORT="${PG_PORT:-5442}"
PROVIDER_PORT="${PROVIDER_PORT:-3010}"
PROVIDER_CONSOLE_PORT="${PROVIDER_CONSOLE_PORT:-3020}"
COUNCIL_PLATFORM_PORT="${COUNCIL_PLATFORM_PORT:-3015}"
COUNCIL_CONSOLE_PORT="${COUNCIL_CONSOLE_PORT:-3030}"
PAY_PLATFORM_PORT="${PAY_PLATFORM_PORT:-3025}"
MOONLIGHT_PAY_PORT="${MOONLIGHT_PAY_PORT:-3050}"
NETWORK_DASHBOARD_PORT="${NETWORK_DASHBOARD_PORT:-3040}"

# Container name — override to avoid collisions
PG_CONTAINER="${PG_CONTAINER:-provider-platform-db}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
section() { echo -e "\n${BLUE}=== $* ===${NC}"; }

# ============================================================
section "1/11  Prerequisites"
# ============================================================

command -v docker >/dev/null 2>&1 || error "Docker not found."
info "Docker: $(docker --version)"

# Detect Docker Desktop socket (macOS) — stellar CLI needs DOCKER_HOST
if [ -z "${DOCKER_HOST:-}" ] && [ ! -S /var/run/docker.sock ] && [ -S "$HOME/.docker/run/docker.sock" ]; then
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
  info "Set DOCKER_HOST=$DOCKER_HOST (Docker Desktop)"
fi

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
if ! command -v stellar >/dev/null 2>&1; then
  info "Installing Stellar CLI..."
  curl -fsSL https://raw.githubusercontent.com/stellar/stellar-cli/main/install.sh | sh
fi
info "Stellar CLI: $(stellar version)"

DENO_BIN="${DENO_BIN:-deno}"
command -v "$DENO_BIN" >/dev/null 2>&1 || DENO_BIN="$HOME/.deno/bin/deno"
if ! command -v "$DENO_BIN" >/dev/null 2>&1; then
  info "Installing Deno..."
  curl -fsSL https://deno.land/install.sh | sh
  DENO_BIN="$HOME/.deno/bin/deno"
fi
info "Deno: $($DENO_BIN --version | head -1)"

[ -d "$PROVIDER_PLATFORM_PATH" ] || error "provider-platform not found at $PROVIDER_PLATFORM_PATH"
[ -d "$PROVIDER_CONSOLE_PATH" ] || error "provider-console not found at $PROVIDER_CONSOLE_PATH"
[ -d "$COUNCIL_CONSOLE_PATH" ] || error "council-console not found at $COUNCIL_CONSOLE_PATH"
[ -d "$COUNCIL_PLATFORM_PATH" ] || error "council-platform not found at $COUNCIL_PLATFORM_PATH"
[ -d "$PAY_PLATFORM_PATH" ] || error "pay-platform not found at $PAY_PLATFORM_PATH"
[ -d "$NETWORK_DASHBOARD_PATH" ] || error "network-dashboard not found at $NETWORK_DASHBOARD_PATH"

# ============================================================
section "2/11  Jaeger (ports 4317/4318/16686)"
# ============================================================

JAEGER_CONTAINER="${JAEGER_CONTAINER:-jaeger}"
if docker ps --format '{{.Names}}' | grep -q "^${JAEGER_CONTAINER}$"; then
  info "Jaeger already running."
else
  info "Starting Jaeger..."
  docker rm -f "$JAEGER_CONTAINER" 2>/dev/null || true
  docker run -d --name "$JAEGER_CONTAINER" \
    -p 4317:4317 \
    -p 4318:4318 \
    -p 16686:16686 \
    jaegertracing/all-in-one:latest >/dev/null
  info "Waiting for Jaeger to be ready..."
  for i in $(seq 1 30); do
    if curl -sf "http://localhost:16686/api/services" >/dev/null 2>&1; then
      info "Jaeger is ready."
      break
    fi
    if [ "$i" -eq 30 ]; then
      warn "Jaeger may not be ready yet."
    fi
    sleep 1
  done
fi

# ============================================================
section "3/11  Stellar Network"
# ============================================================

# Start the shared Stellar network if not already running
if curl -sf "http://localhost:${STELLAR_RPC_PORT}/soroban/rpc" -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q "healthy"; then
  info "Stellar RPC on port $STELLAR_RPC_PORT is healthy (shared)."
else
  info "Stellar RPC not running, starting local network..."
  stellar container start local 2>/dev/null || true

  info "Waiting for Stellar RPC to be ready..."
  for i in $(seq 1 60); do
    if curl -sf "http://localhost:${STELLAR_RPC_PORT}/soroban/rpc" -X POST \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q "healthy"; then
      info "Stellar RPC is ready."
      break
    fi
    if [ "$i" -eq 60 ]; then
      error "Stellar RPC did not become healthy after 60s. Check Docker logs."
    fi
    sleep 1
  done
fi

# Wait for Friendbot (takes longer than RPC to initialize — cold boot can
# take 90-120s as Stellar Core, Horizon, and Friendbot all start up inside
# the quickstart container; Friendbot returns 502 until it is fully ready).
# setup-c.sh and setup-pp.sh both rely on Friendbot being responsive.
info "Waiting for Friendbot to be ready (first boot is slow)..."
for i in $(seq 1 180); do
  fb_code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${STELLAR_RPC_PORT}/friendbot?addr=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" 2>/dev/null || echo "000")
  if [ "$fb_code" = "200" ] || [ "$fb_code" = "400" ]; then
    info "Friendbot is ready (after ${i}s)."
    break
  fi
  if [ "$i" -eq 180 ]; then
    error "Friendbot did not become ready after 180s."
  fi
  sleep 1
done
# Brief pause so Friendbot finishes processing the health-check transaction
# before we hit it with account-funding requests
sleep 2

# ============================================================
section "4/11  PostgreSQL (port $PG_PORT)"
# ============================================================

if docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  warn "PostgreSQL container '$PG_CONTAINER' already running"
else
  docker rm -f "$PG_CONTAINER" 2>/dev/null || true
  docker run -d --name "$PG_CONTAINER" \
    -p "${PG_PORT}:5432" \
    -e POSTGRES_USER=admin \
    -e POSTGRES_PASSWORD=devpass \
    -e POSTGRES_DB=provider_platform_db \
    postgres:18 >/dev/null
  info "PostgreSQL started on port $PG_PORT"
fi

info "Waiting for PostgreSQL to be ready..."
for i in $(seq 1 30); do
  if docker exec "$PG_CONTAINER" pg_isready -U admin >/dev/null 2>&1; then
    info "PostgreSQL is ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    error "PostgreSQL did not become ready after 30s."
  fi
  sleep 1
done

# Council platform uses a separate database in the same Postgres instance.
docker exec "$PG_CONTAINER" psql -U admin -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname = 'council_platform_db'" \
  | grep -q 1 || \
  docker exec "$PG_CONTAINER" psql -U admin -d postgres -c \
  "CREATE DATABASE council_platform_db" >/dev/null

# Pay platform uses a separate database in the same Postgres instance.
docker exec "$PG_CONTAINER" psql -U admin -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname = 'pay_platform_db'" \
  | grep -q 1 || \
  docker exec "$PG_CONTAINER" psql -U admin -d postgres -c \
  "CREATE DATABASE pay_platform_db" >/dev/null

# ============================================================
section "5/11  Provider Platform (port $PROVIDER_PORT)"
# ============================================================

cd "$PROVIDER_PLATFORM_PATH"

# Infra-only env. No contract IDs, no PP keys, no council references.
# Channel routing in the multi-PP architecture is DB-driven via
# payment_providers + council_memberships, populated by setup-pp.sh.
cat > .env <<EOF
# Generated by local-dev/up.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
PORT=$PROVIDER_PORT
MODE=development
LOG_LEVEL=TRACE
SERVICE_DOMAIN=localhost

DATABASE_URL=postgresql://admin:devpass@localhost:${PG_PORT}/provider_platform_db

NETWORK=local
STELLAR_RPC_URL=http://localhost:${STELLAR_RPC_PORT}/soroban/rpc
NETWORK_FEE=1000000000

SERVICE_AUTH_SECRET=local-dev-stable-auth-secret
CHALLENGE_TTL=900
SESSION_TTL=21600

MEMPOOL_SLOT_CAPACITY=100
MEMPOOL_EXPENSIVE_OP_WEIGHT=10
MEMPOOL_CHEAP_OP_WEIGHT=1
MEMPOOL_EXECUTOR_INTERVAL_MS=5000
MEMPOOL_VERIFIER_INTERVAL_MS=10000
MEMPOOL_TTL_CHECK_INTERVAL_MS=60000
MEMPOOL_MAX_RETRY_ATTEMPTS=3
EOF

info "Running migrations..."
"$DENO_BIN" task db:migrate

info "Starting provider-platform (background)..."
PROVIDER_LOG="$SCRIPT_DIR/provider.log"
OTEL_DENO=true \
OTEL_SERVICE_NAME=provider-platform \
OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:${JAEGER_OTLP_PORT}" \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
nohup "$DENO_BIN" task serve > "$PROVIDER_LOG" 2>&1 &
PROVIDER_PID=$!
echo "$PROVIDER_PID" > "$SCRIPT_DIR/.provider.pid"
info "Provider running (PID $PROVIDER_PID, log: $PROVIDER_LOG)"

for i in $(seq 1 15); do
  if curl -sf "http://localhost:${PROVIDER_PORT}/api/v1/health" >/dev/null 2>&1; then
    info "Provider is ready on port $PROVIDER_PORT."
    break
  fi
  if [ "$i" -eq 15 ]; then
    warn "Provider may not be ready yet. Check $PROVIDER_LOG"
  fi
  sleep 1
done

# ============================================================
section "6/11  Council Platform (port $COUNCIL_PLATFORM_PORT)"
# ============================================================

cd "$COUNCIL_PLATFORM_PATH"

# Infra-only env. No CHANNEL_AUTH_ID, no COUNCIL_SK, no OPEX_*. With
# multi-council, councils + their keys live in the council-platform DB,
# created via the council-console UI or by setup-c.sh.
cat > .env <<EOF
# Generated by local-dev/up.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
PORT=$COUNCIL_PLATFORM_PORT
MODE=development
LOG_LEVEL=TRACE
SERVICE_DOMAIN=localhost

DATABASE_URL=postgresql://admin:devpass@localhost:${PG_PORT}/council_platform_db

NETWORK=local
STELLAR_RPC_URL=http://localhost:${STELLAR_RPC_PORT}/soroban/rpc
NETWORK_FEE=1000000000

SERVICE_AUTH_SECRET=local-dev-stable-auth-secret
CHALLENGE_TTL=900
SESSION_TTL=21600
EOF

info "Running council-platform migrations..."
"$DENO_BIN" task db:migrate

info "Starting council-platform (background)..."
COUNCIL_PLATFORM_LOG="$SCRIPT_DIR/council-platform.log"
OTEL_DENO=true \
OTEL_SERVICE_NAME=council-platform \
OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:${JAEGER_OTLP_PORT}" \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
nohup "$DENO_BIN" task serve > "$COUNCIL_PLATFORM_LOG" 2>&1 &
COUNCIL_PLATFORM_PID=$!
echo "$COUNCIL_PLATFORM_PID" > "$SCRIPT_DIR/.council-platform.pid"
info "Council Platform running (PID $COUNCIL_PLATFORM_PID, log: $COUNCIL_PLATFORM_LOG)"

for i in $(seq 1 15); do
  if curl -sf "http://localhost:${COUNCIL_PLATFORM_PORT}/api/v1/health" >/dev/null 2>&1; then
    info "Council Platform is ready on port $COUNCIL_PLATFORM_PORT."
    break
  fi
  if [ "$i" -eq 15 ]; then
    warn "Council Platform may not be ready yet. Check $COUNCIL_PLATFORM_LOG"
  fi
  sleep 1
done

# ============================================================
section "7/11  Pay Platform (port $PAY_PLATFORM_PORT)"
# ============================================================

cd "$PAY_PLATFORM_PATH"

# Infra-only env: ports, network bindings, DB URL, JWT secret, admin wallet.
# Notably NOT in here, by design:
#   - no contract IDs (pay-platform doesn't talk to Soroban contracts)
#   - no provider/council keys (pay accounts are unrelated to PP/council ops)
#   - no per-user data (accounts live in pay_platform_db, created via the
#     Moonlight Pay frontend's wallet sign-in flow)
#
# ADMIN_WALLETS: read from .local-dev-keys (generated by setup-keys.sh).
# If setup-keys.sh hasn't run yet, ADMIN_WALLETS is empty and the /admin
# endpoints return 403 until it's configured.
PAY_ADMIN_PK=""
PAY_SERVICE_SK=""
if [ -f "$SCRIPT_DIR/.local-dev-keys" ]; then
  PAY_ADMIN_PK=$(grep "^PAY_ADMIN_PK=" "$SCRIPT_DIR/.local-dev-keys" | cut -d= -f2)
  PAY_SERVICE_SK=$(grep "^PAY_SERVICE_SK=" "$SCRIPT_DIR/.local-dev-keys" | cut -d= -f2)
fi

cat > .env <<EOF
# Generated by local-dev/up.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
PORT=$PAY_PLATFORM_PORT
MODE=development
LOG_LEVEL=TRACE
SERVICE_DOMAIN=localhost

DATABASE_URL=postgresql://admin:devpass@localhost:${PG_PORT}/pay_platform_db

SERVICE_AUTH_SECRET=local-dev-stable-auth-secret
CHALLENGE_TTL=900
SESSION_TTL=21600

ADMIN_WALLETS=$PAY_ADMIN_PK
PAY_SERVICE_SK=$PAY_SERVICE_SK
EOF

info "Running pay-platform migrations..."
"$DENO_BIN" task db:migrate

info "Starting pay-platform (background)..."
PAY_PLATFORM_LOG="$SCRIPT_DIR/pay-platform.log"
OTEL_DENO=true \
OTEL_SERVICE_NAME=pay-platform \
OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:${JAEGER_OTLP_PORT}" \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
nohup "$DENO_BIN" task serve > "$PAY_PLATFORM_LOG" 2>&1 &
PAY_PLATFORM_PID=$!
echo "$PAY_PLATFORM_PID" > "$SCRIPT_DIR/.pay-platform.pid"
info "Pay Platform running (PID $PAY_PLATFORM_PID, log: $PAY_PLATFORM_LOG)"

for i in $(seq 1 15); do
  if curl -sf "http://localhost:${PAY_PLATFORM_PORT}/api/v1/health" >/dev/null 2>&1; then
    info "Pay Platform is ready on port $PAY_PLATFORM_PORT."
    break
  fi
  if [ "$i" -eq 15 ]; then
    warn "Pay Platform may not be ready yet. Check $PAY_PLATFORM_LOG"
  fi
  sleep 1
done

# ============================================================
section "8/11  Provider Console (port $PROVIDER_CONSOLE_PORT)"
# ============================================================

cd "$PROVIDER_CONSOLE_PATH"

cat > public/config.js <<EOF
// Runtime configuration — generated by local-dev/up.sh
window.__CONSOLE_CONFIG__ = {
  apiBaseUrl: "http://localhost:${PROVIDER_PORT}/api/v1",
  stellarNetwork: "standalone",
  environment: "development",
};
EOF

info "Building provider-console..."
"$DENO_BIN" task build

info "Starting provider-console (background)..."
PROVIDER_CONSOLE_LOG="$SCRIPT_DIR/provider-console.log"
PORT=$PROVIDER_CONSOLE_PORT \
API_BASE_URL="http://localhost:${PROVIDER_PORT}" \
nohup "$DENO_BIN" task serve > "$PROVIDER_CONSOLE_LOG" 2>&1 &
PROVIDER_CONSOLE_PID=$!
echo "$PROVIDER_CONSOLE_PID" > "$SCRIPT_DIR/.provider-console.pid"
info "Provider Console running (PID $PROVIDER_CONSOLE_PID, log: $PROVIDER_CONSOLE_LOG)"

for i in $(seq 1 10); do
  if curl -sf "http://localhost:${PROVIDER_CONSOLE_PORT}/" >/dev/null 2>&1; then
    info "Provider Console is ready."
    break
  fi
  if [ "$i" -eq 10 ]; then
    warn "Provider Console may not be ready yet. Check $PROVIDER_CONSOLE_LOG"
  fi
  sleep 1
done

# ============================================================
section "9/11  Council Console (port $COUNCIL_CONSOLE_PORT)"
# ============================================================

cd "$COUNCIL_CONSOLE_PATH"

cat > public/config.js <<EOF
// Runtime configuration — generated by local-dev/up.sh
window.__CONSOLE_CONFIG__ = {
  environment: "development",
  stellarNetwork: "standalone",
  rpcUrl: "http://localhost:${STELLAR_RPC_PORT}/soroban/rpc",
  horizonUrl: "http://localhost:${STELLAR_RPC_PORT}",
  friendbotUrl: "http://localhost:${STELLAR_RPC_PORT}/friendbot",
  platformUrl: "http://localhost:${COUNCIL_PLATFORM_PORT}",
};
EOF

info "Building council-console..."
"$DENO_BIN" task build

info "Starting council-console (background)..."
COUNCIL_CONSOLE_LOG="$SCRIPT_DIR/council-console.log"
MODE=development \
PORT=$COUNCIL_CONSOLE_PORT \
nohup "$DENO_BIN" task serve > "$COUNCIL_CONSOLE_LOG" 2>&1 &
COUNCIL_CONSOLE_PID=$!
echo "$COUNCIL_CONSOLE_PID" > "$SCRIPT_DIR/.council-console.pid"
info "Council Console running (PID $COUNCIL_CONSOLE_PID, log: $COUNCIL_CONSOLE_LOG)"

for i in $(seq 1 10); do
  if curl -sf "http://localhost:${COUNCIL_CONSOLE_PORT}/" >/dev/null 2>&1; then
    info "Council Console is ready."
    break
  fi
  if [ "$i" -eq 10 ]; then
    warn "Council Console may not be ready yet. Check $COUNCIL_CONSOLE_LOG"
  fi
  sleep 1
done

# ============================================================
section "10/11 Moonlight Pay (port $MOONLIGHT_PAY_PORT)"
# ============================================================

cd "$MOONLIGHT_PAY_PATH"

cat > public/config.js <<EOF
// Runtime configuration — generated by local-dev/up.sh
window.__PAY_CONFIG__ = {
  environment: "development",
  stellarNetwork: "standalone",
  payPlatformUrl: "http://localhost:${PAY_PLATFORM_PORT}",
};
EOF

info "Building moonlight-pay..."
"$DENO_BIN" task build

info "Starting moonlight-pay (background)..."
MOONLIGHT_PAY_LOG="$SCRIPT_DIR/moonlight-pay.log"
MODE=development \
PORT=$MOONLIGHT_PAY_PORT \
nohup "$DENO_BIN" task serve > "$MOONLIGHT_PAY_LOG" 2>&1 &
MOONLIGHT_PAY_PID=$!
echo "$MOONLIGHT_PAY_PID" > "$SCRIPT_DIR/.moonlight-pay.pid"
info "Moonlight Pay running (PID $MOONLIGHT_PAY_PID, log: $MOONLIGHT_PAY_LOG)"

for i in $(seq 1 10); do
  if curl -sf "http://localhost:${MOONLIGHT_PAY_PORT}/" >/dev/null 2>&1; then
    info "Moonlight Pay is ready."
    break
  fi
  if [ "$i" -eq 10 ]; then
    warn "Moonlight Pay may not be ready yet. Check $MOONLIGHT_PAY_LOG"
  fi
  sleep 1
done

# ============================================================
section "11/11 Network Dashboard (port $NETWORK_DASHBOARD_PORT)"
# ============================================================

cd "$NETWORK_DASHBOARD_PATH"

cat > public/config.js <<EOF
// Runtime configuration — generated by local-dev/up.sh
window.__DASHBOARD_CONFIG__ = {
  environment: "development",
  stellarNetwork: "standalone",
  rpcUrl: "http://localhost:${STELLAR_RPC_PORT}/soroban/rpc",
  horizonUrl: "http://localhost:${STELLAR_RPC_PORT}",
};
EOF

info "Building network-dashboard..."
"$DENO_BIN" task build

info "Starting network-dashboard (background)..."
NETWORK_DASHBOARD_LOG="$SCRIPT_DIR/network-dashboard.log"
PORT=$NETWORK_DASHBOARD_PORT \
nohup "$DENO_BIN" task serve > "$NETWORK_DASHBOARD_LOG" 2>&1 &
NETWORK_DASHBOARD_PID=$!
echo "$NETWORK_DASHBOARD_PID" > "$SCRIPT_DIR/.network-dashboard.pid"
info "Network Dashboard running (PID $NETWORK_DASHBOARD_PID, log: $NETWORK_DASHBOARD_LOG)"

for i in $(seq 1 10); do
  if curl -sf "http://localhost:${NETWORK_DASHBOARD_PORT}/" >/dev/null 2>&1; then
    info "Network Dashboard is ready."
    break
  fi
  if [ "$i" -eq 10 ]; then
    warn "Network Dashboard may not be ready yet. Check $NETWORK_DASHBOARD_LOG"
  fi
  sleep 1
done

# ============================================================
echo ""
echo "========================================"
echo "  local-dev infra is ready!"
echo "========================================"
echo ""
echo "Services:"
echo "  Provider Platform:  http://localhost:$PROVIDER_PORT (PID $PROVIDER_PID)"
echo "  Council Platform:   http://localhost:$COUNCIL_PLATFORM_PORT (PID $COUNCIL_PLATFORM_PID)"
echo "  Pay Platform:       http://localhost:$PAY_PLATFORM_PORT (PID $PAY_PLATFORM_PID)"
echo "  Provider Console:   http://localhost:$PROVIDER_CONSOLE_PORT (PID $PROVIDER_CONSOLE_PID)"
echo "  Council Console:    http://localhost:$COUNCIL_CONSOLE_PORT (PID $COUNCIL_CONSOLE_PID)"
echo "  Moonlight Pay:      http://localhost:$MOONLIGHT_PAY_PORT (PID $MOONLIGHT_PAY_PID)"
echo "  Network Dashboard:  http://localhost:$NETWORK_DASHBOARD_PORT (PID $NETWORK_DASHBOARD_PID)"
echo "  PostgreSQL:         localhost:$PG_PORT (container: $PG_CONTAINER)"
echo "  Stellar RPC:        http://localhost:$STELLAR_RPC_PORT (shared)"
echo "  Jaeger UI:          http://localhost:16686"
echo ""
echo "Protocol state is empty. To populate:"
echo "  ./setup-c.sh    Deploy contracts + create a council (production-like)"
echo "  ./setup-pp.sh   Register a Privacy Provider in that council"
echo ""
echo "To stop everything:"
echo "  ./down.sh"
echo ""
