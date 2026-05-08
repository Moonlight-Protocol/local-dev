#!/usr/bin/env bash
set -euo pipefail

# Vendor the Freighter browser extension into playwright/freighter-extension/.
#
# Used by:
#   - test.sh playwright/invite-gate (docker-isolated runs)
#   - the "up.sh + npx playwright test --headed" workflow in playwright/README.md
#
# The directory is gitignored and the README previously asked devs to copy the
# extension out of their local Chrome install. CI builds it from source at a
# pinned tag (.github/workflows/invite-gate-reusable.yml). This script does the
# same so local runs match CI byte-for-byte. Idempotent — exits early if the
# extension is already vendored.
#
# To bump the pin: change FREIGHTER_TAG below.

FREIGHTER_TAG="5.39.0"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$SCRIPT_DIR/playwright/freighter-extension"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
info()  { echo -e "${GREEN}[setup-freighter]${NC} $*"; }
error() { echo -e "${RED}[setup-freighter]${NC} $*" >&2; exit 1; }

if [ -f "$DEST/manifest.json" ]; then
  info "Freighter extension already present at playwright/freighter-extension."
  info "Delete the directory and re-run to refresh."
  exit 0
fi

command -v docker >/dev/null \
  || error "docker not on PATH (build runs in a node:20 container)."

info "Building Freighter extension from stellar/freighter@${FREIGHTER_TAG}..."
mkdir -p "$DEST"

# Build inside node:20 to match CI's setup-node node-version: "20" and to
# avoid depending on host yarn/corepack. CI=true bypasses the
# INDEXER_URL/INDEXER_V2_URL check in webpack.extension.js.
docker run --rm \
  -v "$DEST:/out" \
  -e CI=true \
  -e FREIGHTER_TAG="$FREIGHTER_TAG" \
  node:20 \
  bash -c '
    set -e
    git clone --depth 1 --branch "$FREIGHTER_TAG" \
      https://github.com/stellar/freighter.git /tmp/freighter
    cd /tmp/freighter
    corepack enable
    yarn install --immutable
    yarn build:freighter-api
    yarn build:extension:production
    cp -r extension/build/. /out/
  ' || { rm -rf "$DEST"; error "Freighter build failed."; }

info "Freighter extension installed at playwright/freighter-extension."
