#!/usr/bin/env bash
set -euo pipefail

# run-local.sh — runs the testnet/lifecycle suites against the LOCAL stack.
#
# The same scripts that target deployed testnet by default work against the
# local stack with a different set of URLs and the standalone Stellar network
# passphrase. This wrapper sets those env vars and invokes the suites.
#
# Prerequisites: local stack already running (./up.sh && ./setup-*.sh) with
# provider on :3010, council on :3015, pay on :3025, stellar on :8000, jaeger
# on :16686.
#
# Usage:
#   ./testnet/run-local.sh            # all 4 suites
#   ./testnet/run-local.sh 1          # payment flow only
#   ./testnet/run-local.sh 2          # OTEL verify (payment) only — needs prior suite 1
#   ./testnet/run-local.sh 3          # lifecycle only
#   ./testnet/run-local.sh 4          # OTEL verify (lifecycle) only — needs prior suite 3
#   ./testnet/run-local.sh payment    # alias for: 1 then 2
#   ./testnet/run-local.sh lifecycle  # alias for: 3 then 4

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_DEV_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DENO_BIN="${DENO_BIN:-$(command -v deno 2>/dev/null || echo "$HOME/.deno/bin/deno")}"

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'
info() { echo -e "${GREEN}[run-local]${NC} $*"; }
warn() { echo -e "${YELLOW}[run-local]${NC} $*"; }

# Local-stack overrides for the testnet/lifecycle scripts. Each is read by
# the underlying script via Deno.env.get() with a testnet default.
export STELLAR_RPC_URL="${STELLAR_RPC_URL:-http://localhost:8000/soroban/rpc}"
export FRIENDBOT_URL="${FRIENDBOT_URL:-http://localhost:8000/friendbot}"
export STELLAR_NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Standalone Network ; February 2017}"
export COUNCIL_URL="${COUNCIL_URL:-http://localhost:3015}"
export PROVIDER_URL="${PROVIDER_URL:-http://localhost:3010}"

# OTEL: send to local OTLP collector (Jaeger), not Grafana Cloud.
export OTEL_DENO=true
export OTEL_SERVICE_NAME="${OTEL_SERVICE_NAME:-moonlight-e2e}"
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}"

# OTEL verifier: read from local Jaeger instead of Tempo.
export JAEGER_URL="${JAEGER_URL:-http://localhost:16686}"
export PROVIDER_SERVICE_NAME="${PROVIDER_SERVICE_NAME:-provider-platform}"
export SDK_SERVICE_NAME="${SDK_SERVICE_NAME:-moonlight-e2e}"
export COUNCIL_SERVICE_NAME="${COUNCIL_SERVICE_NAME:-council-platform}"

run_payment() {
  info "Suite 1: testnet payment flow → localhost"
  cd "$SCRIPT_DIR"
  "$DENO_BIN" run --allow-all main.ts
}

run_verify_payment() {
  info "Suite 2: OTEL verify (payment) ← Jaeger"
  cd "$SCRIPT_DIR"
  "$DENO_BIN" run --allow-all verify-otel-local.ts
}

run_lifecycle() {
  info "Suite 3: lifecycle flow → localhost"
  cd "$LOCAL_DEV_DIR"
  "$DENO_BIN" run --allow-all lifecycle/testnet-verify.ts
}

run_verify_lifecycle() {
  info "Suite 4: OTEL verify (lifecycle) ← Jaeger"
  cd "$LOCAL_DEV_DIR"
  "$DENO_BIN" run --allow-all lifecycle/verify-otel-local.ts
}

target="${1:-all}"

case "$target" in
  1)         run_payment ;;
  2)         run_verify_payment ;;
  3)         run_lifecycle ;;
  4)         run_verify_lifecycle ;;
  payment)   run_payment; run_verify_payment ;;
  lifecycle) run_lifecycle; run_verify_lifecycle ;;
  all)       run_payment; run_verify_payment; run_lifecycle; run_verify_lifecycle ;;
  *)
    warn "Unknown target: $target"
    echo "Usage: $0 [1|2|3|4|payment|lifecycle|all]" >&2
    exit 2
    ;;
esac

info "Done."
