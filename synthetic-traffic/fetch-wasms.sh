#!/usr/bin/env bash
#
# Download the released contract WASMs the engine publishes to the registry.
# Same rule as e2e/wasms: released artifacts only, never local builds — the
# registry entries must reference the exact bytes shipped in the soroban-core
# release.
#
# Usage: ./synthetic-traffic/fetch-wasms.sh [version]   # default 0.5.0

set -euo pipefail

VERSION="${1:-${SYNTRAF_CONTRACTS_VERSION:-0.5.0}}"
DIR="$(cd "$(dirname "$0")" && pwd)/wasms"
mkdir -p "$DIR"

for wasm in channel_auth_contract.wasm privacy_channel.wasm; do
  if [[ -f "$DIR/$wasm" ]]; then
    echo "[fetch-wasms] $wasm already present"
    continue
  fi
  echo "[fetch-wasms] downloading $wasm (v$VERSION)"
  gh release download "v$VERSION" \
    --repo Moonlight-Protocol/soroban-core \
    --pattern "$wasm" \
    --dir "$DIR"
done

echo "[fetch-wasms] done → $DIR"
