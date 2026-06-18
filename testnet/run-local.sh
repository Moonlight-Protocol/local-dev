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

# OTEL verifier: read from local Jaeger instead of Tempo. The verify-otel-local.ts
# wrappers are hardcoded to network=local, so they emit unsuffixed service names
# (provider-platform, council-platform) regardless of what's exported here.
export JAEGER_URL="${JAEGER_URL:-http://localhost:16686}"

# Pin the trace-IDs hand-off path so suites 3 and 4 agree on it. Suite 3 runs
# from $LOCAL_DEV_DIR and would otherwise write to ./e2e-trace-ids.json; suite
# 4's verifier looks under e2e/. Matches the same export in run-all.sh.
export E2E_TRACE_IDS_PATH="$LOCAL_DEV_DIR/e2e/e2e-trace-ids.json"

# Events-capture: assert each flow script's inlined EXPECTED_EVENTS against
# the per-PP + network-wide WS streams.
#
#   PROVIDER_URL is already set above (line 39).
#   NETWORK_DASHBOARD_PLATFORM_URL defaults to localhost:3035 — the harness
#   reads it via env when the --network-dashboard-url flag is absent.
#   MASTER_SECRET makes the alice/bob/PP keypairs deterministic and lets the
#   harness derive the same values the scripts derive internally.
export NETWORK_DASHBOARD_PLATFORM_URL="${NETWORK_DASHBOARD_PLATFORM_URL:-http://localhost:3035}"
export MASTER_SECRET="${MASTER_SECRET:-SAQCGLJ2JISI67QGG457IBN2DY6YW5GGS2OMQU5KNLXB3TWVUIR2RD74}"

run_payment() {
  info "Suite 1: testnet payment flow → localhost (events-capture harness)"
  "$DENO_BIN" run --allow-all "$SCRIPT_DIR/events-capture/harness.ts" \
    --script testnet-main
}

run_verify_payment() {
  info "Suite 2: OTEL verify (payment) ← Jaeger"
  cd "$SCRIPT_DIR"
  "$DENO_BIN" run --allow-all verify-otel-local.ts
}

run_lifecycle() {
  info "Suite 3: lifecycle flow → localhost (events-capture harness)"
  "$DENO_BIN" run --allow-all "$SCRIPT_DIR/events-capture/harness.ts" \
    --script lifecycle-testnet-verify
}

run_verify_lifecycle() {
  info "Suite 4: OTEL verify (lifecycle) ← Jaeger"
  cd "$LOCAL_DEV_DIR"
  "$DENO_BIN" run --allow-all lifecycle/verify-otel-local.ts
}

run_standin_lifecycle() {
  info "Suite 5: lifecycle flow → standin (events-capture harness)"
  # Standin runs on :3011 by default (infra-up.sh section 5b); harness
  # subscribes to its WS at /provider/events/ws and runs lifecycle/standin-verify.ts.
  PROVIDER_URL="${STANDIN_URL:-http://localhost:3011}" \
    "$DENO_BIN" run --allow-all "$SCRIPT_DIR/events-capture/harness.ts" \
    --script lifecycle-standin-verify
}

run_verify_standin_lifecycle() {
  info "Suite 6: OTEL verify (standin lifecycle) ← Jaeger"
  cd "$LOCAL_DEV_DIR"
  "$DENO_BIN" run --allow-all lifecycle/standin-verify-otel-local.ts
}

target="${1:-all}"

case "$target" in
  1)         run_payment ;;
  2)         run_verify_payment ;;
  3)         run_lifecycle ;;
  4)         run_verify_lifecycle ;;
  5)         run_standin_lifecycle ;;
  6)         run_verify_standin_lifecycle ;;
  payment)   run_payment; run_verify_payment ;;
  lifecycle) run_lifecycle; run_verify_lifecycle ;;
  standin)   run_standin_lifecycle; run_verify_standin_lifecycle ;;
  all)
    run_payment; run_verify_payment
    run_lifecycle; run_verify_lifecycle
    run_standin_lifecycle; run_verify_standin_lifecycle
    ;;
  *)
    warn "Unknown target: $target"
    echo "Usage: $0 [1|2|3|4|5|6|payment|lifecycle|standin|all]" >&2
    exit 2
    ;;
esac

info "Done."
