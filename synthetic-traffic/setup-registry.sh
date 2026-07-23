#!/usr/bin/env bash
#
# Deploy the Stellar Registry contract to the LOCAL network (local-first
# registry adoption: everything else deploys through `stellar registry`, but
# the registry itself needs one raw deploy — the documented bootstrap
# exception).
#
# Builds the registry wasm from a throwaway clone of
# stellar-registry/contracts, deploys it with constructor
# (admin, manager=admin, root=None) — a root registry, which auto-deploys the
# `unverified` subregistry the engine publishes under — and prints the
# STELLAR_REGISTRY_CONTRACT_ID to export.
#
# Prereqs: stellar CLI, stellar-registry-cli plugin, cargo + wasm32v1-none
# target, local stack up (./up.sh).
#
# Usage:
#   ./synthetic-traffic/setup-registry.sh
#   export STELLAR_REGISTRY_CONTRACT_ID=<printed id>

set -euo pipefail

RPC_URL="${STELLAR_RPC_URL:-http://localhost:8000/soroban/rpc}"
NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Standalone Network ; February 2017}"
FRIENDBOT_URL="${FRIENDBOT_URL:-http://localhost:8000/friendbot}"
WORK_DIR="${REGISTRY_WORK_DIR:-$(mktemp -d)}"
REGISTRY_REPO="https://github.com/stellar-registry/contracts.git"

if [[ "$NETWORK_PASSPHRASE" == "Public Global Stellar Network ; September 2015" ]]; then
  echo "REFUSING: mainnet passphrase — synthetic-traffic is testnet/local only." >&2
  exit 1
fi

if [[ ! -d "$WORK_DIR/contracts" ]]; then
  echo "[setup-registry] cloning $REGISTRY_REPO → $WORK_DIR"
  git clone --depth 1 "$REGISTRY_REPO" "$WORK_DIR/contracts"
fi

echo "[setup-registry] building registry wasm (profile contracts)"
(cd "$WORK_DIR/contracts" && stellar contract build --profile contracts)

WASM="$(find "$WORK_DIR/contracts/target" -name 'registry*.wasm' -path '*release*' | head -1)"
if [[ -z "$WASM" ]]; then
  # newer cargo layouts put profile output under the profile name
  WASM="$(find "$WORK_DIR/contracts/target" -name 'registry*.wasm' | head -1)"
fi
if [[ -z "$WASM" ]]; then
  echo "[setup-registry] could not find built registry wasm under $WORK_DIR/contracts/target" >&2
  exit 1
fi
echo "[setup-registry] wasm: $WASM"

# Deterministic local admin for the registry deploy.
ADMIN_SECRET="${REGISTRY_ADMIN_SECRET:-SAQCGLJ2JISI67QGG457IBN2DY6YW5GGS2OMQU5KNLXB3TWVUIR2RD74}"
ADMIN_PUBLIC="$(stellar keys address --secret-key 2>/dev/null <<<"$ADMIN_SECRET" || true)"
if [[ -z "$ADMIN_PUBLIC" ]]; then
  ADMIN_PUBLIC="$(deno eval 'import {Keypair} from "npm:@stellar/stellar-sdk@15.1.0"; console.log(Keypair.fromSecret(Deno.args[0]).publicKey())' "$ADMIN_SECRET")"
fi

echo "[setup-registry] funding admin $ADMIN_PUBLIC"
curl -sf "$FRIENDBOT_URL?addr=$ADMIN_PUBLIC" > /dev/null || true

echo "[setup-registry] deploying registry (root, manager=admin)"
CONTRACT_ID="$(
  stellar contract deploy \
    --wasm "$WASM" \
    --source-account "$ADMIN_SECRET" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" \
    -- \
    --admin "$ADMIN_PUBLIC" \
    --manager "$ADMIN_PUBLIC"
)"

echo
echo "[setup-registry] done."
echo "export STELLAR_REGISTRY_CONTRACT_ID=$CONTRACT_ID"
