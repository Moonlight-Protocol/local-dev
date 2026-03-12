#!/usr/bin/env bash
set -euo pipefail

# Local E2E — Up
# Installs dependencies, deploys contracts, starts all services, and builds
# wallet extensions. One command to get everything running.
#
# Usage: ./up.sh

SOROBAN_CORE_PATH="${SOROBAN_CORE_PATH:-$HOME/repos/soroban-core}"
PROVIDER_PLATFORM_PATH="${PROVIDER_PLATFORM_PATH:-$HOME/repos/provider-platform}"
WALLET_PATH="${WALLET_PATH:-$HOME/repos/browser-wallet}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

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
section "1/8  Prerequisites"
# ============================================================

# --- Docker ---
command -v docker >/dev/null 2>&1 || error "Docker not found. Install from https://docs.docker.com/get-docker/"
info "Docker: $(docker --version)"

# --- Rust / Cargo ---
if ! command -v cargo >/dev/null 2>&1; then
  info "Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi
rustup target add wasm32v1-none 2>/dev/null || true
info "Rust: $(rustc --version)"

# --- Stellar CLI ---
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
if ! command -v stellar >/dev/null 2>&1; then
  info "Installing Stellar CLI..."
  curl -fsSL https://raw.githubusercontent.com/stellar/stellar-cli/main/install.sh | sh
fi
info "Stellar CLI: $(stellar version)"

# --- Deno ---
DENO_BIN="${DENO_BIN:-deno}"
command -v "$DENO_BIN" >/dev/null 2>&1 || DENO_BIN="$HOME/.deno/bin/deno"
if ! command -v "$DENO_BIN" >/dev/null 2>&1; then
  info "Installing Deno..."
  curl -fsSL https://deno.land/install.sh | sh
  DENO_BIN="$HOME/.deno/bin/deno"
fi
info "Deno: $($DENO_BIN --version | head -1)"

# --- Repos ---
[ -d "$SOROBAN_CORE_PATH" ] || error "soroban-core not found at $SOROBAN_CORE_PATH"
[ -d "$PROVIDER_PLATFORM_PATH" ] || error "provider-platform not found at $PROVIDER_PLATFORM_PATH"
[ -d "$WALLET_PATH" ] || error "browser-wallet not found at $WALLET_PATH"

# ============================================================
section "2/8  Jaeger (Tracing)"
# ============================================================

JAEGER_CONTAINER="jaeger-local"
if docker ps --format '{{.Names}}' | grep -q "^${JAEGER_CONTAINER}$"; then
  warn "Jaeger already running"
else
  docker rm -f "$JAEGER_CONTAINER" 2>/dev/null || true
  docker run -d --name "$JAEGER_CONTAINER" \
    -p 16686:16686 \
    -p 4317:4317 \
    -p 4318:4318 \
    -e COLLECTOR_OTLP_ENABLED=true \
    jaegertracing/jaeger:latest > "$SCRIPT_DIR/jaeger.log" 2>&1
  info "Jaeger started (UI: http://localhost:16686, log: $SCRIPT_DIR/jaeger.log)"
fi

info "Waiting for Jaeger to be ready..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:16686/api/services >/dev/null 2>&1; then
    info "Jaeger is ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    warn "Jaeger may not be ready yet. Check: docker logs $JAEGER_CONTAINER"
  fi
  sleep 1
done

# ============================================================
section "3/8  Local Stellar Network"
# ============================================================

stellar container start local 2>/dev/null || warn "Local network may already be running"

info "Waiting for Stellar RPC to be ready..."
for i in $(seq 1 60); do
  if curl -sf http://localhost:8000/soroban/rpc -X POST \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q "healthy"; then
    info "RPC is ready."
    break
  fi
  if [ "$i" -eq 60 ]; then
    error "RPC did not become ready after 60s. Check: docker logs stellar-local"
  fi
  sleep 1
done

info "Waiting for Friendbot to be ready (this can take a few minutes on first start)..."
for i in $(seq 1 180); do
  # Use a dummy address to check if friendbot is responding (expect 400 = already funded, or 200)
  local_code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8000/friendbot?addr=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" 2>/dev/null || echo "000")
  if [ "$local_code" = "200" ] || [ "$local_code" = "400" ]; then
    info "Friendbot is ready."
    break
  fi
  if [ "$i" -eq 180 ]; then
    error "Friendbot did not become ready after 180s. Check: docker logs stellar-local"
  fi
  sleep 1
done

# ============================================================
section "4/8  Accounts"
# ============================================================

generate_or_reuse() {
  local name=$1
  if stellar keys address "$name" >/dev/null 2>&1; then
    warn "Account '$name' already exists, reusing."
  else
    stellar keys generate "$name" --network local
    info "Created account: $name"
  fi
  # Always fund via friendbot
  local addr
  addr=$(stellar keys address "$name")
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8000/friendbot?addr=$addr" 2>/dev/null || echo "000")
  if [ "$http_code" = "200" ] || [ "$http_code" = "400" ]; then
    info "Funded: $name"
  else
    error "Could not fund $name (HTTP $http_code) — is the local network running?"
  fi
}

generate_or_reuse admin
generate_or_reuse provider
generate_or_reuse treasury

ADMIN_PK=$(stellar keys address admin)
PROVIDER_PK=$(stellar keys address provider)
PROVIDER_SK=$(stellar keys show provider)
TREASURY_PK=$(stellar keys address treasury)
TREASURY_SK=$(stellar keys show treasury)

info "Admin:    $ADMIN_PK"
info "Provider: $PROVIDER_PK"
info "Treasury: $TREASURY_PK"

# ============================================================
section "5/8  Build & Deploy Contracts"
# ============================================================

cd "$SOROBAN_CORE_PATH"
info "Building contracts..."
stellar contract build

WASM_DIR="target/wasm32v1-none/release"
[ -f "$WASM_DIR/channel_auth_contract.wasm" ] || error "channel_auth_contract.wasm not found"
[ -f "$WASM_DIR/privacy_channel.wasm" ] || error "privacy_channel.wasm not found"

info "Deploying native XLM SAC (Stellar Asset Contract)..."
TOKEN_ID=$(stellar contract asset deploy \
  --asset native \
  --network local \
  --source-account admin)
info "XLM SAC:         $TOKEN_ID"

info "Deploying channel-auth contract..."
AUTH_ID=$(stellar contract deploy \
  --wasm "$WASM_DIR/channel_auth_contract.wasm" \
  --network local \
  --source-account admin \
  -- \
  --admin "$ADMIN_PK")
info "Channel Auth:    $AUTH_ID"

info "Deploying privacy-channel contract..."
CHANNEL_ID=$(stellar contract deploy \
  --wasm "$WASM_DIR/privacy_channel.wasm" \
  --network local \
  --source-account admin \
  -- \
  --admin "$ADMIN_PK" \
  --auth_contract "$AUTH_ID" \
  --asset "$TOKEN_ID")
info "Privacy Channel: $CHANNEL_ID"

info "Registering provider..."
stellar contract invoke \
  --network local \
  --id "$AUTH_ID" \
  --source-account admin \
  -- \
  add_provider \
  --provider "$PROVIDER_PK"
info "Provider registered."

# ============================================================
section "6/8  Provider Platform"
# ============================================================

cd "$PROVIDER_PLATFORM_PATH"

# Write .env
cat > .env <<EOF
# Generated by local-e2e/up.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
PORT=3000
MODE=development
LOG_LEVEL=TRACE
SERVICE_DOMAIN=localhost

DATABASE_URL=postgresql://admin:devpass@localhost:5432/provider_platform_db

NETWORK=local
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
EOF

info "Starting PostgreSQL..."
docker compose up -d db

info "Running migrations..."
"$DENO_BIN" task db:migrate

info "Starting provider-platform (background)..."
PROVIDER_LOG="$SCRIPT_DIR/provider.log"
OTEL_DENO=true \
OTEL_SERVICE_NAME=provider-platform \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
nohup "$DENO_BIN" task serve > "$PROVIDER_LOG" 2>&1 &
PROVIDER_PID=$!
echo "$PROVIDER_PID" > "$SCRIPT_DIR/.provider.pid"
info "Provider running (PID $PROVIDER_PID, log: $PROVIDER_LOG)"

# Wait for provider to be ready
for i in $(seq 1 15); do
  if curl -sf http://localhost:3000/api/v1/stellar/auth?account=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF >/dev/null 2>&1; then
    info "Provider is ready."
    break
  fi
  if [ "$i" -eq 15 ]; then
    warn "Provider may not be ready yet. Check $PROVIDER_LOG"
  fi
  sleep 1
done

# ============================================================
section "7/8  Wallet Extensions"
# ============================================================

cd "$WALLET_PATH"

info "Generating mnemonics..."
generate_mnemonic() {
  "$DENO_BIN" eval "import bip39 from 'npm:bip39@3.1.0'; console.log(bip39.generateMnemonic());"
}
MNEMONIC_CHROME=$(generate_mnemonic)
MNEMONIC_BRAVE=$(generate_mnemonic)

cat > .env.seed.local <<EOF
SEED_PASSWORD=localdev
SEED_MNEMONIC=$MNEMONIC_CHROME
SEED_NETWORK=custom
SEED_CHANNEL_CONTRACT_ID=$CHANNEL_ID
SEED_CHANNEL_NAME=Local Channel
SEED_ASSET_CODE=XLM
SEED_ASSET_ISSUER=
SEED_PROVIDERS=Local Provider=http://localhost:3000
EOF

cat > .env.seed.local.brave <<EOF
SEED_PASSWORD=localdev
SEED_MNEMONIC=$MNEMONIC_BRAVE
SEED_NETWORK=custom
SEED_CHANNEL_CONTRACT_ID=$CHANNEL_ID
SEED_CHANNEL_NAME=Local Channel
SEED_ASSET_CODE=XLM
SEED_ASSET_ISSUER=
SEED_PROVIDERS=Local Provider=http://localhost:3000
EOF

info "Building Chrome extension (dist/chrome/)..."
SEED_FILE=.env.seed.local BUILD_DIR=dist/chrome "$DENO_BIN" task build

info "Building Brave extension (dist/brave/)..."
SEED_FILE=.env.seed.local.brave BUILD_DIR=dist/brave "$DENO_BIN" task build

info "Deriving wallet addresses and funding via Friendbot..."
derive_address() {
  local mnemonic="$1"
  "$DENO_BIN" eval "
    import { Keypair } from 'npm:@stellar/stellar-sdk@13';
    import * as bip39 from 'npm:bip39@3.1.0';
    import { derivePath } from 'npm:ed25519-hd-key@1.3.0';
    const seed = bip39.mnemonicToSeedSync('$mnemonic');
    const { key } = derivePath(\"m/44'/148'/0'\", seed.toString('hex'));
    const kp = Keypair.fromRawEd25519Seed(key);
    console.log(kp.publicKey());
  "
}

CHROME_ADDR=$(derive_address "$MNEMONIC_CHROME")
BRAVE_ADDR=$(derive_address "$MNEMONIC_BRAVE")
info "Chrome wallet: $CHROME_ADDR"
info "Brave wallet:  $BRAVE_ADDR"

for WALLET_ADDR in "$CHROME_ADDR" "$BRAVE_ADDR"; do
  curl -s "http://localhost:8000/friendbot?addr=$WALLET_ADDR" >/dev/null 2>&1 || true
  info "Funded $WALLET_ADDR via Friendbot"
done

# ============================================================
section "8/8  Done"
# ============================================================

echo ""
echo "Contract IDs:"
echo "  XLM SAC:         $TOKEN_ID"
echo "  Channel Auth:    $AUTH_ID"
echo "  Privacy Channel: $CHANNEL_ID"
echo ""
echo "Provider running at http://localhost:3000 (PID $PROVIDER_PID)"
echo "Jaeger UI at http://localhost:16686"
echo ""
echo "Load extensions:"
echo "  Chrome: chrome://extensions  → Load unpacked → $WALLET_PATH/dist/chrome/"
echo "  Brave:  brave://extensions   → Load unpacked → $WALLET_PATH/dist/brave/"
echo ""
echo "To stop everything:"
echo "  ./down.sh"
echo ""
