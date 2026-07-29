#!/usr/bin/env bash
#
# Install the generator's signing key as the MANAGER of a registry, signed by
# the registry's ADMIN key. Run once per registry (e.g. the moonlight
# sub-registry when its contract id arrives) — after this, the admin key goes
# back to rest and the generator signs day-to-day writes with the manager key.
#
# Env:
#   STELLAR_REGISTRY_CONTRACT_ID   the registry to modify (required)
#   REGISTRY_ADMIN_SECRET          admin SK (required; from Infisical)
#   REGISTRY_MANAGER_PUBLIC        manager pubkey to install (required)
#   STELLAR_RPC_URL / STELLAR_NETWORK_PASSPHRASE  network (default: local)

set -euo pipefail

RPC_URL="${STELLAR_RPC_URL:-http://localhost:8000/soroban/rpc}"
NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Standalone Network ; February 2017}"

if [[ "$NETWORK_PASSPHRASE" == "Public Global Stellar Network ; September 2015" ]]; then
  echo "REFUSING: mainnet passphrase — synthetic-traffic tooling is testnet/local only." >&2
  exit 1
fi

: "${STELLAR_REGISTRY_CONTRACT_ID:?required}"
: "${REGISTRY_ADMIN_SECRET:?required}"
: "${REGISTRY_MANAGER_PUBLIC:?required}"

echo "[set-manager] installing manager $REGISTRY_MANAGER_PUBLIC on $STELLAR_REGISTRY_CONTRACT_ID"
stellar contract invoke \
  --id "$STELLAR_REGISTRY_CONTRACT_ID" \
  --source-account "$REGISTRY_ADMIN_SECRET" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- \
  set_manager \
  --new_manager "$REGISTRY_MANAGER_PUBLIC"

echo "[set-manager] verifying"
stellar contract invoke \
  --id "$STELLAR_REGISTRY_CONTRACT_ID" \
  --source-account "$REGISTRY_ADMIN_SECRET" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- \
  manager
