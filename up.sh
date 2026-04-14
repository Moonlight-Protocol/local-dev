#!/usr/bin/env bash
set -euo pipefail

# Local Dev — Up
#
# Single entry point for bringing up the full Moonlight local-dev stack.
# Generates deterministic keypairs, then starts all infrastructure.
#
# Usage:
#   ./up.sh
#
# To stop everything:
#   ./down.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 1. Generate deterministic keypairs (idempotent — safe to re-run)
"$SCRIPT_DIR/setup-keys.sh"

# 2. Start all infrastructure
exec "$SCRIPT_DIR/infra-up.sh" "$@"
