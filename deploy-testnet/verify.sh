#!/usr/bin/env bash
set -euo pipefail

# Post-deploy E2E verification against testnet.
#
# Runs the same e2e test suite used locally, but pointed at testnet
# infrastructure. Requires that contracts are deployed and the
# provider-platform is running with the correct contract IDs.
#
# Usage: ./verify.sh <channel-contract-id> <auth-contract-id> <asset-contract-id> [provider-url]
#
# Prerequisites:
#   - Contracts deployed to testnet (via deploy.sh)
#   - Provider-platform running on testnet with matching contract IDs
#   - deno installed

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E_DIR="$SCRIPT_DIR/../e2e"

TESTNET_RPC="https://soroban-testnet.stellar.org"
TESTNET_PASSPHRASE="Test SDF Network ; September 2015"
TESTNET_FRIENDBOT="https://friendbot.stellar.org"
DEFAULT_PROVIDER="https://moonlight-beta-privacy-provider-a.fly.dev"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

if [ $# -lt 3 ]; then
  echo "Usage: $0 <channel-contract-id> <auth-contract-id> <asset-contract-id> [provider-url]"
  echo ""
  echo "  channel-contract-id  Privacy channel contract (C... address)"
  echo "  auth-contract-id     Channel auth contract (C... address)"
  echo "  asset-contract-id    XLM SAC contract (C... address)"
  echo "  provider-url         Provider platform URL (default: $DEFAULT_PROVIDER)"
  echo ""
  echo "Example:"
  echo "  $0 CDXYZ... CABC... CDEF..."
  echo "  $0 CDXYZ... CABC... CDEF... https://my-provider.fly.dev"
  exit 1
fi

CHANNEL_CONTRACT_ID="$1"
CHANNEL_AUTH_ID="$2"
CHANNEL_ASSET_CONTRACT_ID="$3"
PROVIDER_URL="${4:-$DEFAULT_PROVIDER}"

echo -e "${GREEN}[verify]${NC} Running E2E test against testnet"
echo -e "${GREEN}[verify]${NC} Channel:  $CHANNEL_CONTRACT_ID"
echo -e "${GREEN}[verify]${NC} Auth:     $CHANNEL_AUTH_ID"
echo -e "${GREEN}[verify]${NC} Asset:    $CHANNEL_ASSET_CONTRACT_ID"
echo -e "${GREEN}[verify]${NC} Provider: $PROVIDER_URL"
echo ""

# Warmup — Fly.io auto-scales to 0, first request wakes the machine
echo -e "${GREEN}[verify]${NC} Warming up provider..."
for i in $(seq 1 30); do
  if curl -sf -o /dev/null "$PROVIDER_URL" 2>/dev/null; then
    echo -e "${GREEN}[verify]${NC} Provider is ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo -e "${RED}[verify]${NC} Provider not reachable after 60s at $PROVIDER_URL"
    exit 1
  fi
  sleep 2
done

cd "$E2E_DIR"

STELLAR_RPC_URL="$TESTNET_RPC" \
STELLAR_NETWORK_PASSPHRASE="$TESTNET_PASSPHRASE" \
FRIENDBOT_URL="$TESTNET_FRIENDBOT" \
PROVIDER_URL="$PROVIDER_URL" \
CHANNEL_CONTRACT_ID="$CHANNEL_CONTRACT_ID" \
CHANNEL_AUTH_ID="$CHANNEL_AUTH_ID" \
CHANNEL_ASSET_CONTRACT_ID="$CHANNEL_ASSET_CONTRACT_ID" \
deno task e2e
