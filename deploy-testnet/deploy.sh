#!/usr/bin/env bash
set -euo pipefail

# Deploy contracts to Stellar testnet.
#
# Usage: ./deploy.sh [--dry-run] <provider-public-key>
#
# Generates a fresh admin account via Friendbot, deploys the XLM SAC,
# channel-auth, and privacy-channel contracts, then registers the
# provider. Outputs contract IDs to console and writes a log file.
#
# Options:
#   --dry-run  Validate prerequisites and connectivity without deploying
#
# Prerequisites:
#   - stellar CLI installed
#   - Pre-built WASMs in soroban-core (or SOROBAN_CORE_PATH set)
#   - Provider public key (G... address)

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
SOROBAN_CORE_PATH="${SOROBAN_CORE_PATH:-$HOME/repos/soroban-core}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WASM_PATH="$SOROBAN_CORE_PATH/target/wasm32v1-none/release"
NETWORK=testnet
RPC_URL="https://soroban-testnet.stellar.org"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
FRIENDBOT_URL="https://friendbot.stellar.org"
LOG_FILE="$SCRIPT_DIR/deploy-$(date -u +%Y%m%d-%H%M%S).log"
DRY_RUN=false

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()     { echo -e "$*" | tee -a "$LOG_FILE"; }
info()    { log "${GREEN}[INFO]${NC} $*"; }
warn()    { log "${YELLOW}[WARN]${NC} $*"; }
error()   { log "${RED}[ERROR]${NC} $*"; exit 1; }
section() { log "\n${BLUE}=== $* ===${NC}"; }

# --- Parse args ---
PROVIDER_PK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h) PROVIDER_PK=""; break ;;
    *) PROVIDER_PK="$1"; shift ;;
  esac
done

if [ -z "$PROVIDER_PK" ]; then
  echo "Usage: $0 [--dry-run] <provider-public-key>"
  echo ""
  echo "  provider-public-key  Stellar G-address of the provider account"
  echo ""
  echo "Options:"
  echo "  --dry-run            Validate prerequisites and connectivity only"
  echo ""
  echo "Environment variables:"
  echo "  SOROBAN_CORE_PATH    Path to soroban-core repo (default: ~/repos/soroban-core)"
  exit 1
fi

# Validate provider public key format
if [[ ! "$PROVIDER_PK" =~ ^G[A-Z0-9]{55}$ ]]; then
  error "Invalid provider public key: $PROVIDER_PK (expected G-address, 56 chars)"
fi

# --- Start log ---
if $DRY_RUN; then
  log "# DRY RUN — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
else
  log "# Deploy to testnet — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
log "# Log file: $LOG_FILE"

# ============================================================
section "1/5  Prerequisites"
# ============================================================

command -v stellar >/dev/null 2>&1 || error "Stellar CLI not found. Install from https://github.com/stellar/stellar-cli"
info "Stellar CLI: $(stellar version)"

[ -f "$WASM_PATH/channel_auth_contract.wasm" ] || error "channel_auth_contract.wasm not found at $WASM_PATH — run 'stellar contract build' in soroban-core first"
[ -f "$WASM_PATH/privacy_channel.wasm" ] || error "privacy_channel.wasm not found at $WASM_PATH — run 'stellar contract build' in soroban-core first"

AUTH_SIZE=$(wc -c < "$WASM_PATH/channel_auth_contract.wasm" | tr -d ' ')
CHANNEL_SIZE=$(wc -c < "$WASM_PATH/privacy_channel.wasm" | tr -d ' ')
info "channel_auth_contract.wasm  $(( AUTH_SIZE / 1024 )) KB"
info "privacy_channel.wasm        $(( CHANNEL_SIZE / 1024 )) KB"
info "Provider: $PROVIDER_PK"

# ============================================================
section "2/5  Connectivity checks"
# ============================================================

info "Checking testnet RPC..."
RPC_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "$RPC_URL" \
  -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || echo "000")
if [ "$RPC_STATUS" = "200" ]; then
  info "Testnet RPC: reachable"
else
  error "Testnet RPC unreachable (HTTP $RPC_STATUS) at $RPC_URL"
fi

info "Checking Friendbot..."
FB_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "${FRIENDBOT_URL}?addr=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" 2>/dev/null || echo "000")
if [ "$FB_STATUS" = "200" ] || [ "$FB_STATUS" = "400" ]; then
  info "Friendbot: reachable"
else
  error "Friendbot unreachable (HTTP $FB_STATUS) at $FRIENDBOT_URL"
fi

if $DRY_RUN; then
  log ""
  log "${GREEN}========================================${NC}"
  log "${GREEN}  Dry run passed${NC}"
  log "${GREEN}========================================${NC}"
  log ""
  log "  All prerequisites met. Ready to deploy."
  log "  Run without --dry-run to deploy contracts."
  log ""
  log "  What will happen:"
  log "    1. Generate ephemeral admin account, fund via Friendbot"
  log "    2. Deploy native XLM SAC"
  log "    3. Deploy channel_auth_contract.wasm"
  log "    4. Deploy privacy_channel.wasm"
  log "    5. Register provider $PROVIDER_PK on auth contract"
  log "    6. Output contract IDs"
  log ""
  log "  Log: $LOG_FILE"
  exit 0
fi

# ============================================================
section "3/5  Generate & fund admin account"
# ============================================================

# Ensure testnet network is configured
stellar network add testnet \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" 2>/dev/null || true

# Generate ephemeral admin account
ADMIN_NAME="deploy-admin-$$"
stellar keys generate "$ADMIN_NAME" --network "$NETWORK"
ADMIN_PK=$(stellar keys address "$ADMIN_NAME")
info "Admin account: $ADMIN_PK"

# Fund via Friendbot
info "Funding admin via Friendbot..."
FUND_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${FRIENDBOT_URL}?addr=$ADMIN_PK")
if [ "$FUND_STATUS" != "200" ]; then
  stellar keys rm "$ADMIN_NAME" 2>/dev/null || true
  error "Friendbot funding failed (HTTP $FUND_STATUS)"
fi
info "Admin funded"

# ============================================================
section "4/5  Deploy contracts & register provider"
# ============================================================

info "Deploying native XLM SAC..."
TOKEN_ID=$(stellar contract asset deploy \
  --asset native \
  --network "$NETWORK" \
  --source-account "$ADMIN_NAME")
info "XLM SAC: $TOKEN_ID"

info "Deploying channel-auth contract..."
AUTH_ID=$(stellar contract deploy \
  --wasm "$WASM_PATH/channel_auth_contract.wasm" \
  --network "$NETWORK" \
  --source-account "$ADMIN_NAME" \
  -- \
  --admin "$ADMIN_PK")
info "Channel Auth: $AUTH_ID"

info "Deploying privacy-channel contract..."
CHANNEL_ID=$(stellar contract deploy \
  --wasm "$WASM_PATH/privacy_channel.wasm" \
  --network "$NETWORK" \
  --source-account "$ADMIN_NAME" \
  -- \
  --admin "$ADMIN_PK" \
  --auth_contract "$AUTH_ID" \
  --asset "$TOKEN_ID")
info "Privacy Channel: $CHANNEL_ID"

info "Registering provider on auth contract..."
stellar contract invoke \
  --network "$NETWORK" \
  --id "$AUTH_ID" \
  --source-account "$ADMIN_NAME" \
  -- \
  add_provider \
  --provider "$PROVIDER_PK"
info "Provider registered"

# ============================================================
section "5/5  Cleanup & summary"
# ============================================================

# Remove ephemeral admin key
stellar keys rm "$ADMIN_NAME" 2>/dev/null || true
info "Ephemeral admin key removed"

# --- Output summary ---
log ""
log "${GREEN}========================================${NC}"
log "${GREEN}  Testnet deploy complete${NC}"
log "${GREEN}========================================${NC}"
log ""
log "  XLM SAC (asset):     $TOKEN_ID"
log "  Channel Auth:        $AUTH_ID"
log "  Privacy Channel:     $CHANNEL_ID"
log "  Provider:            $PROVIDER_PK"
log ""
log "  Update provider-platform (copy & paste):"
log ""
log "    cd ~/repos/provider-platform && fly secrets set CHANNEL_CONTRACT_ID=$CHANNEL_ID CHANNEL_AUTH_ID=$AUTH_ID CHANNEL_ASSET_CONTRACT_ID=$TOKEN_ID"
log ""
log "  Verify deployment:"
log ""
log "    ./deploy-testnet/verify.sh $CHANNEL_ID $AUTH_ID $TOKEN_ID"
log ""
log "  Log: $LOG_FILE"
