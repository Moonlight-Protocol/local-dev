#!/usr/bin/env bash
set -euo pipefail

# run-tempo.sh — runs the testnet/main.ts e2e suite against a remote OTLP
# collector (Grafana Cloud Tempo, in practice).
#
# The underlying `deno task e2e` (testnet/deno.json) sets OTEL_DENO,
# OTEL_SERVICE_NAME, and OTEL_EXPORTER_OTLP_PROTOCOL but deliberately leaves
# OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS for the caller —
# they vary by environment and the headers are a secret. Deno OTEL silent-fails
# when those are unset against a remote collector, producing zero SDK spans
# with no error. This wrapper enforces both are set before invoking the task.
#
# For local Jaeger runs use ./run-local.sh — it exports
# OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 and skips _HEADERS (Jaeger
# doesn't need auth).
#
# Usage:
#   OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway.../otlp/v1/traces \
#     OTEL_EXPORTER_OTLP_HEADERS='authorization=Basic ...' \
#     ./testnet/run-tempo.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DENO_BIN="${DENO_BIN:-$(command -v deno 2>/dev/null || echo "$HOME/.deno/bin/deno")}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
info() { echo -e "${GREEN}[run-tempo]${NC} $*"; }
fail() { echo -e "${RED}[run-tempo]${NC} $*" >&2; }

missing=()
[[ -z "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]] && missing+=("OTEL_EXPORTER_OTLP_ENDPOINT")
[[ -z "${OTEL_EXPORTER_OTLP_HEADERS:-}" ]] && missing+=("OTEL_EXPORTER_OTLP_HEADERS")

if (( ${#missing[@]} > 0 )); then
  fail "Missing required env var(s): ${missing[*]}"
  fail "Both OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS must be set."
  fail "See testnet/README.md for the deployed-Tempo run instructions."
  exit 1
fi

info "Suite 1: testnet payment flow → ${OTEL_EXPORTER_OTLP_ENDPOINT}"
cd "$SCRIPT_DIR"
exec "$DENO_BIN" task e2e
