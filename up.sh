#!/usr/bin/env bash
set -euo pipefail

# Local Dev — Up
# Spins up a parallel local stack using different ports to avoid collisions
# with the primary local-dev instance. Reuses Stellar network & Jaeger.
#
# Ports: PostgreSQL 5442, Provider 3010, Console 3020
# Shared: Stellar RPC 8000
#
# Usage: ./up.sh

BASE_DIR="${BASE_DIR:-$HOME/repos}"
SOROBAN_CORE_PATH="${SOROBAN_CORE_PATH:-$BASE_DIR/soroban-core}"
PROVIDER_PLATFORM_PATH="${PROVIDER_PLATFORM_PATH:-$BASE_DIR/provider-platform}"
PROVIDER_CONSOLE_PATH="${PROVIDER_CONSOLE_PATH:-$BASE_DIR/provider-console}"
COUNCIL_CONSOLE_PATH="${COUNCIL_CONSOLE_PATH:-$BASE_DIR/council-console}"
COUNCIL_PLATFORM_PATH="${COUNCIL_PLATFORM_PATH:-$BASE_DIR/council-platform}"
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
NETWORK_DASHBOARD_PORT="${NETWORK_DASHBOARD_PORT:-3040}"

# Container / account names — override to avoid collisions
PG_CONTAINER="${PG_CONTAINER:-provider-platform-db}"
ACCT_ADMIN="${ACCT_ADMIN:-admin}"
ACCT_PROVIDER="${ACCT_PROVIDER:-provider}"
ACCT_TREASURY="${ACCT_TREASURY:-treasury}"

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

if ! command -v cargo >/dev/null 2>&1; then
  info "Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi
rustup target add wasm32v1-none 2>/dev/null || true
info "Rust: $(rustc --version)"

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

[ -d "$SOROBAN_CORE_PATH" ] || error "soroban-core not found at $SOROBAN_CORE_PATH"
[ -d "$PROVIDER_PLATFORM_PATH" ] || error "provider-platform not found at $PROVIDER_PLATFORM_PATH"
[ -d "$PROVIDER_CONSOLE_PATH" ] || error "provider-console not found at $PROVIDER_CONSOLE_PATH"
[ -d "$COUNCIL_CONSOLE_PATH" ] || error "council-console not found at $COUNCIL_CONSOLE_PATH"
[ -d "$COUNCIL_PLATFORM_PATH" ] || error "council-platform not found at $COUNCIL_PLATFORM_PATH"
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
# the quickstart container; Friendbot returns 502 until it is fully ready)
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
section "4/11  Accounts"
# ============================================================

generate_or_reuse() {
  local name=$1
  if stellar keys address "$name" >/dev/null 2>&1; then
    warn "Account '$name' already exists, reusing."
  else
    stellar keys generate "$name" --network local
    info "Created account: $name"
  fi
  local addr
  addr=$(stellar keys address "$name")
  local http_code
  for attempt in $(seq 1 10); do
    http_code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${STELLAR_RPC_PORT}/friendbot?addr=$addr" 2>/dev/null || echo "000")
    if [ "$http_code" = "200" ] || [ "$http_code" = "400" ]; then
      info "Funded: $name"
      return 0
    fi
    if [ "$attempt" -lt 10 ]; then
      warn "Friendbot returned HTTP $http_code for $name, retrying ($attempt/10)..."
      sleep 3
    fi
  done
  error "Could not fund $name after 10 attempts (last HTTP $http_code)"
}

generate_or_reuse "$ACCT_ADMIN"
generate_or_reuse "$ACCT_PROVIDER"
generate_or_reuse "$ACCT_TREASURY"

ADMIN_PK=$(stellar keys address "$ACCT_ADMIN")
ADMIN_SK=$(stellar keys show "$ACCT_ADMIN")
PROVIDER_PK=$(stellar keys address "$ACCT_PROVIDER")
PROVIDER_SK=$(stellar keys show "$ACCT_PROVIDER")
TREASURY_PK=$(stellar keys address "$ACCT_TREASURY")
TREASURY_SK=$(stellar keys show "$ACCT_TREASURY")

info "Admin:    $ADMIN_PK"
info "Provider: $PROVIDER_PK"
info "Treasury: $TREASURY_PK"

# ============================================================
section "5/11  Build & Deploy Contracts"
# ============================================================

cd "$SOROBAN_CORE_PATH"
info "Building contracts..."
stellar contract build

WASM_DIR="target/wasm32v1-none/release"
[ -f "$WASM_DIR/channel_auth_contract.wasm" ] || error "channel_auth_contract.wasm not found"
[ -f "$WASM_DIR/privacy_channel.wasm" ] || error "privacy_channel.wasm not found"

info "Deploying native XLM SAC (Stellar Asset Contract)..."
if TOKEN_ID=$(stellar contract asset deploy \
  --asset native \
  --network local \
  --source-account "$ACCT_ADMIN" 2>/dev/null); then
  info "SAC deployed"
else
  # SAC may already be deployed (shared network) — fetch its ID
  TOKEN_ID=$(stellar contract asset id --asset native --network local)
  warn "SAC already deployed: $TOKEN_ID"
fi
info "XLM SAC:         $TOKEN_ID"

info "Deploying channel-auth contract..."
AUTH_ID=$(stellar contract deploy \
  --wasm "$WASM_DIR/channel_auth_contract.wasm" \
  --network local \
  --source-account "$ACCT_ADMIN" \
  -- \
  --admin "$ADMIN_PK")
info "Channel Auth:    $AUTH_ID"

info "Deploying privacy-channel contract..."
CHANNEL_ID=$(stellar contract deploy \
  --wasm "$WASM_DIR/privacy_channel.wasm" \
  --network local \
  --source-account "$ACCT_ADMIN" \
  -- \
  --admin "$ADMIN_PK" \
  --auth_contract "$AUTH_ID" \
  --asset "$TOKEN_ID")
info "Privacy Channel: $CHANNEL_ID"

info "Registering provider..."
stellar contract invoke \
  --network local \
  --id "$AUTH_ID" \
  --source-account "$ACCT_ADMIN" \
  -- \
  add_provider \
  --provider "$PROVIDER_PK"
info "Provider registered."

# ============================================================
section "6/11  PostgreSQL (port $PG_PORT)"
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

# ============================================================
section "7/11  Provider Platform (port $PROVIDER_PORT)"
# ============================================================

cd "$PROVIDER_PLATFORM_PATH"

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
CHANNEL_CONTRACT_ID=$CHANNEL_ID
CHANNEL_AUTH_ID=$AUTH_ID
CHANNEL_ASSET_CODE=XLM
CHANNEL_ASSET_CONTRACT_ID=$TOKEN_ID

PROVIDER_SK=$PROVIDER_SK
OPEX_PUBLIC=$TREASURY_PK
OPEX_SECRET=$TREASURY_SK

SERVICE_AUTH_SECRET=
SERVICE_FEE=100
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

info "Running additional migrations..."
docker exec -i "$PG_CONTAINER" psql -U admin -d provider_platform_db \
  < "$PROVIDER_PLATFORM_PATH/src/persistence/drizzle/migration/0007_council_memberships.sql"

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
  if curl -sf "http://localhost:${PROVIDER_PORT}/api/v1/stellar/auth?account=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" >/dev/null 2>&1; then
    info "Provider is ready on port $PROVIDER_PORT."
    break
  fi
  if [ "$i" -eq 15 ]; then
    warn "Provider may not be ready yet. Check $PROVIDER_LOG"
  fi
  sleep 1
done

# ============================================================
section "8/11  Council Platform (port $COUNCIL_PLATFORM_PORT)"
# ============================================================

cd "$COUNCIL_PLATFORM_PATH"

# Create council_platform_db if it doesn't exist
docker exec "$PG_CONTAINER" psql -U admin -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname = 'council_platform_db'" \
  | grep -q 1 || \
  docker exec "$PG_CONTAINER" psql -U admin -d postgres -c \
  "CREATE DATABASE council_platform_db"

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
CHANNEL_AUTH_ID=$AUTH_ID

COUNCIL_SK=$ADMIN_SK
OPEX_PUBLIC=$TREASURY_PK
OPEX_SECRET=$TREASURY_SK

SERVICE_AUTH_SECRET=local-dev-stable-auth-secret
CHALLENGE_TTL=900
SESSION_TTL=21600
EOF

info "Running council-platform migrations..."
for migration in "$COUNCIL_PLATFORM_PATH"/src/persistence/drizzle/migration/*.sql; do
  info "  Applying $(basename "$migration")..."
  docker exec -i "$PG_CONTAINER" psql -U admin -d council_platform_db < "$migration"
done

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
section "9/11  Provider Console (port $PROVIDER_CONSOLE_PORT)"
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
section "10/11  Council Console (port $COUNCIL_CONSOLE_PORT)"
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
section "11/11  Network Dashboard (port $NETWORK_DASHBOARD_PORT)"
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
# Generate E2E config
# ============================================================

cat > "$SCRIPT_DIR/e2e/.env" <<EOF
# Generated by local-dev/up.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
CHANNEL_CONTRACT_ID=$CHANNEL_ID
CHANNEL_AUTH_ID=$AUTH_ID
CHANNEL_ASSET_CONTRACT_ID=$TOKEN_ID
PROVIDER_URL=http://localhost:$PROVIDER_PORT
PROVIDER_SK=$PROVIDER_SK
STELLAR_RPC_URL=http://localhost:${STELLAR_RPC_PORT}/soroban/rpc
EOF
info "E2E config written to e2e/.env"

# ============================================================
echo ""
echo "========================================"
echo "  local-dev is ready!"
echo "========================================"
echo ""
echo "Contract IDs:"
echo "  XLM SAC:         $TOKEN_ID"
echo "  Channel Auth:    $AUTH_ID"
echo "  Privacy Channel: $CHANNEL_ID"
echo ""
echo "Services:"
echo "  Provider Platform:  http://localhost:$PROVIDER_PORT (PID $PROVIDER_PID)"
echo "  Council Platform:   http://localhost:$COUNCIL_PLATFORM_PORT (PID $COUNCIL_PLATFORM_PID)"
echo "  Provider Console:   http://localhost:$PROVIDER_CONSOLE_PORT (PID $PROVIDER_CONSOLE_PID)"
echo "  Council Console:    http://localhost:$COUNCIL_CONSOLE_PORT (PID $COUNCIL_CONSOLE_PID)"
echo "  Network Dashboard:  http://localhost:$NETWORK_DASHBOARD_PORT (PID $NETWORK_DASHBOARD_PID)"
echo "  PostgreSQL:         localhost:$PG_PORT (container: $PG_CONTAINER)"
echo "  Stellar RPC:        http://localhost:$STELLAR_RPC_PORT (shared)"
echo "  Jaeger UI:          http://localhost:16686"
echo ""
echo "To stop everything:"
echo "  ./down.sh"
echo ""
