#!/usr/bin/env bash
set -euo pipefail

# run-all.sh — Single-command runner for the 4 testnet verification suites
# against deployed Tempo. Sets every OTEL/path env var the suites need so
# the caller only supplies the four secrets/endpoints below.
#
# Caller must export, before invoking:
#   - OTEL_EXPORTER_OTLP_ENDPOINT  (Grafana Cloud OTLP gateway URL)
#   - OTEL_EXPORTER_OTLP_HEADERS   (e.g. "Authorization=Basic <base64>")
#   - TEMPO_URL                    (e.g. https://tempo-prod-13-prod-ca-east-0.grafana.net/tempo)
#   - TEMPO_AUTH                   (full header value, e.g. "Basic <base64>")
#
# Everything else (OTEL_DENO, OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_PROTOCOL,
# MOONLIGHT_NETWORK, E2E_TRACE_IDS_PATH, deno tasks, paths, 60s waits) is
# set here so the suites are invoked the one correct way every time.
#
# WASMs must already be present at e2e/wasms/*.wasm — fetch from the
# Moonlight-Protocol/soroban-core GitHub releases page (see top-level README).
#
# Usage:
#   OTEL_EXPORTER_OTLP_ENDPOINT=... \
#   OTEL_EXPORTER_OTLP_HEADERS=... \
#   TEMPO_URL=... \
#   TEMPO_AUTH=... \
#     ./testnet/run-all.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DENO_BIN="${DENO_BIN:-$(command -v deno 2>/dev/null || echo "$HOME/.deno/bin/deno")}"

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'
info() { echo -e "${BLUE}[run-all]${NC} $*"; }
ok()   { echo -e "${GREEN}[run-all]${NC} $*"; }
fail() { echo -e "${RED}[run-all]${NC} $*" >&2; }

# Caller-supplied secrets — assert presence (values stay secret; we only check presence).
missing=()
[[ -z "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]] && missing+=("OTEL_EXPORTER_OTLP_ENDPOINT")
[[ -z "${OTEL_EXPORTER_OTLP_HEADERS:-}" ]]  && missing+=("OTEL_EXPORTER_OTLP_HEADERS")
[[ -z "${TEMPO_URL:-}" ]]                   && missing+=("TEMPO_URL")
[[ -z "${TEMPO_AUTH:-}" ]]                  && missing+=("TEMPO_AUTH")
if (( ${#missing[@]} > 0 )); then
  fail "Missing required env var(s): ${missing[*]}"
  fail "All four must be exported before invoking run-all.sh — see header for details."
  exit 1
fi

# WASM presence.
for w in channel_auth_contract.wasm privacy_channel.wasm; do
  if [[ ! -f "$REPO_ROOT/e2e/wasms/$w" ]]; then
    fail "Missing WASM: e2e/wasms/$w"
    fail "Fetch from Moonlight-Protocol/soroban-core releases — see top-level README."
    exit 1
  fi
done

# Deterministic env — set here so the suites are invoked the same way every time.
export OTEL_DENO=true
export OTEL_SERVICE_NAME=moonlight-e2e
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export MOONLIGHT_NETWORK=testnet
export E2E_TRACE_IDS_PATH="$REPO_ROOT/e2e/e2e-trace-ids.json"

cd "$REPO_ROOT"

# Suite 1 — Payment flow (~5 min) through the events-capture harness so
# the per-PP + network-wide WS streams are asserted against the script's
# inlined EXPECTED_EVENTS. The harness skips assert and exits 0 if the
# WS surfaces are unreachable (e.g. against deployed testnet with no
# network-dashboard-platform URL set), so this swap is safe for both
# local-stack and deployed-Tempo invocations.
#
# The wrapper assertions still apply — OTEL_EXPORTER_OTLP_ENDPOINT /
# _HEADERS were already verified above. run-tempo.sh's job (asserting
# those two vars before invoking deno) is preserved by the top-of-file
# checks here.
info "Suite 1: payment flow (events-capture harness)"
"$DENO_BIN" run --allow-all "$SCRIPT_DIR/events-capture/harness.ts" \
  --script testnet-main
ok   "Suite 1 passed"

# Suite 2 — OTEL verify payment (60s wait for Tempo ingestion)
info "Suite 2: OTEL verify (payment) — waiting 60s for Tempo ingestion"
sleep 60
"$DENO_BIN" run --allow-all "$SCRIPT_DIR/verify-otel.ts"
ok   "Suite 2 passed"

# Suite 3 — Lifecycle flow (~5 min) through the events-capture harness.
info "Suite 3: lifecycle flow (events-capture harness)"
"$DENO_BIN" run --allow-all "$SCRIPT_DIR/events-capture/harness.ts" \
  --script lifecycle-testnet-verify
ok   "Suite 3 passed"

# Suite 4 — OTEL verify lifecycle (60s wait for Tempo ingestion)
info "Suite 4: OTEL verify (lifecycle) — waiting 60s for Tempo ingestion"
sleep 60
"$DENO_BIN" run --allow-all "$REPO_ROOT/lifecycle/verify-otel.ts"
ok   "Suite 4 passed"

ok "All 4 suites passed."
