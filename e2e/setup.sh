#!/bin/bash
set -euo pipefail

# E2E Setup — runs inside the stellar-cli container.
# Generates accounts, deploys contracts, writes config for other services.
#
# Expects:
#   - STELLAR_RPC_URL, STELLAR_NETWORK_PASSPHRASE, FRIENDBOT_URL as env vars
#   - /wasms/ mounted with pre-built contract wasms
#   - /config/ mounted as shared volume for output

CONFIG_DIR="/config"

info()  { echo "[setup] $*"; }
error() { echo "[setup] ERROR: $*" >&2; exit 1; }

# Configure stellar CLI for the local network
stellar network add local \
  --rpc-url "$STELLAR_RPC_URL" \
  --network-passphrase "$STELLAR_NETWORK_PASSPHRASE"

# --- Wait for Friendbot ---
info "Waiting for Friendbot..."
for i in $(seq 1 180); do
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    "${FRIENDBOT_URL}?addr=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" 2>/dev/null || echo "000")
  if [ "$code" = "200" ] || [ "$code" = "400" ]; then
    info "Friendbot is ready."
    break
  fi
  if [ "$i" -eq 180 ]; then
    error "Friendbot did not become ready after 180s"
  fi
  sleep 1
done

# --- Generate & fund accounts ---
info "Generating accounts..."
for name in admin provider treasury; do
  stellar keys generate "$name" --network local
  addr=$(stellar keys address "$name")
  curl -s "${FRIENDBOT_URL}?addr=$addr" >/dev/null 2>&1 || true
  info "Created and funded: $name ($addr)"
done

ADMIN_PK=$(stellar keys address admin)
PROVIDER_PK=$(stellar keys address provider)
PROVIDER_SK=$(stellar keys show provider)
TREASURY_PK=$(stellar keys address treasury)
TREASURY_SK=$(stellar keys show treasury)

# --- Deploy contracts ---
info "Deploying native XLM SAC..."
TOKEN_ID=$(stellar contract asset deploy \
  --asset native \
  --network local \
  --source-account admin)
info "XLM SAC: $TOKEN_ID"

# Check for pre-built wasms
[ -f /wasms/channel_auth_contract.wasm ] || error "channel_auth_contract.wasm not found in /wasms/"
[ -f /wasms/privacy_channel.wasm ] || error "privacy_channel.wasm not found in /wasms/"

info "Deploying channel-auth contract..."
AUTH_ID=$(stellar contract deploy \
  --wasm /wasms/channel_auth_contract.wasm \
  --network local \
  --source-account admin \
  -- \
  --admin "$ADMIN_PK")
info "Channel Auth: $AUTH_ID"

info "Deploying privacy-channel contract..."
CHANNEL_ID=$(stellar contract deploy \
  --wasm /wasms/privacy_channel.wasm \
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

# --- Write provider env ---
# Note: DATABASE_URL is set as an env var on the provider container in docker-compose,
# not here, because it depends on the db service hostname.
cat > "$CONFIG_DIR/provider.env" <<EOF
PORT=3000
MODE=development
LOG_LEVEL=TRACE
SERVICE_DOMAIN=localhost

STELLAR_RPC_URL=$STELLAR_RPC_URL
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

# --- Write shared config for test runner ---
# Uses the same key names as provider.env and up.sh
cat > "$CONFIG_DIR/contracts.env" <<EOF
CHANNEL_CONTRACT_ID=$CHANNEL_ID
CHANNEL_AUTH_ID=$AUTH_ID
CHANNEL_ASSET_CONTRACT_ID=$TOKEN_ID
PROVIDER_PK=$PROVIDER_PK
PROVIDER_SK=$PROVIDER_SK
TREASURY_PK=$TREASURY_PK
EOF

info "Config written to $CONFIG_DIR/"
info "Setup complete."
