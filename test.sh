#!/usr/bin/env bash
set -euo pipefail

# Local E2E Test Runner
#
# Runs test suites in full Docker isolation — each run gets its own Stellar
# node, PostgreSQL, and service instances. Tests use current local repo source
# code (mounted read-only). Does not require up.sh.
#
# Usage:
#   ./test.sh e2e           # Payment flow
#   ./test.sh governance    # UC2 governance flows
#   ./test.sh uc2           # Manual UC2 user flow
#   ./test.sh all           # All three in parallel
#   ./test.sh clean         # Remove all test containers/volumes

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="${BASE_DIR:-$(dirname "$SCRIPT_DIR")}"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.test.yml"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[test]${NC} $*"; }
warn()  { echo -e "${YELLOW}[test]${NC} $*"; }
error() { echo -e "${RED}[test]${NC} $*" >&2; exit 1; }

usage() {
  echo "Usage: $0 <suite>"
  echo ""
  echo "Suites:"
  echo "  e2e           Payment flow (8 steps)"
  echo "  governance    UC2 governance flows (40+ checks)"
  echo "  uc2           Manual UC2 user flow (22 checks)"
  echo "  all           Run all suites in parallel"
  echo "  clean         Remove all test containers and volumes"
  exit 1
}

SUITE="${1:-}"
[ -z "$SUITE" ] && usage

# Ensure WASMs are built
ensure_wasms() {
  WASM_DIR="${WASM_DIR:-${BASE_DIR}/soroban-core/target/wasm32v1-none/release}"
  if [ ! -f "$WASM_DIR/channel_auth_contract.wasm" ] || [ ! -f "$WASM_DIR/privacy_channel.wasm" ]; then
    local soroban_path="${SOROBAN_CORE_PATH:-${BASE_DIR}/soroban-core}"
    [ -d "$soroban_path" ] || error "soroban-core not found at $soroban_path. Set SOROBAN_CORE_PATH or BASE_DIR."
    info "Building contracts..."
    (cd "$soroban_path" && stellar contract build) || error "Contract build failed"
    info "Contracts built."
  fi
  export WASM_DIR
}

# Run a single test suite
run_suite() {
  local suite=$1
  local project_name="moonlight-test-${suite}-$(date +%s | tail -c 5)"

  case "$suite" in
    e2e|governance|uc2) ;;
    *) error "Unknown suite: $suite" ;;
  esac

  info "Running '$suite' (project: $project_name)..."

  # Cleanup on exit or interrupt
  cleanup() {
    info "Cleaning up $project_name..."
    docker compose -f "$COMPOSE_FILE" -p "$project_name" down -v --remove-orphans 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM

  # Start in detached mode (--abort-on-container-exit can't be used with
  # one-shot setup containers — it aborts before the test runner starts)
  TEST_SUITE="$suite" \
  WASM_DIR="${WASM_DIR}" \
  PROVIDER_PLATFORM_PATH="${PROVIDER_PLATFORM_PATH:-${BASE_DIR}/provider-platform}" \
  COUNCIL_PLATFORM_PATH="${COUNCIL_PLATFORM_PATH:-${BASE_DIR}/council-platform}" \
  docker compose -f "$COMPOSE_FILE" -p "$project_name" up -d

  # Stream test-runner logs and wait for it to finish
  info "Waiting for test-runner to complete..."
  docker compose -f "$COMPOSE_FILE" -p "$project_name" logs -f test-runner 2>&1 &
  local logs_pid=$!

  # Wait for the test-runner container to exit
  local container_name="${project_name}-test-runner-1"
  local exit_code=1
  while true; do
    local state
    state=$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || echo "not_found")
    case "$state" in
      exited)
        exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$container_name" 2>/dev/null || echo "1")
        break
        ;;
      not_found|dead)
        break
        ;;
    esac
    sleep 3
  done

  kill "$logs_pid" 2>/dev/null || true
  wait "$logs_pid" 2>/dev/null || true
  cleanup
  trap - EXIT INT TERM

  if [ "$exit_code" -eq 0 ]; then
    info "'$suite' passed."
  else
    error "'$suite' failed (exit $exit_code)."
  fi
  return "$exit_code"
}

# Clean up any lingering test projects
clean_all() {
  info "Cleaning up all test projects..."
  for project in $(docker compose ls --format json 2>/dev/null | grep -o '"moonlight-test-[^"]*"' | tr -d '"'); do
    info "  Removing $project..."
    docker compose -p "$project" down -v --remove-orphans 2>/dev/null || true
  done
  info "Clean."
}

case "$SUITE" in
  e2e|governance|uc2)
    ensure_wasms
    run_suite "$SUITE"
    ;;

  all)
    ensure_wasms
    info "Running all suites in parallel..."
    pids=()
    results=()

    for s in e2e governance uc2; do
      (run_suite "$s") &
      pids+=($!)
    done

    all_passed=true
    for i in "${!pids[@]}"; do
      suite_names=(e2e governance uc2)
      if wait "${pids[$i]}"; then
        results+=("${suite_names[$i]}: passed")
      else
        results+=("${suite_names[$i]}: FAILED")
        all_passed=false
      fi
    done

    echo ""
    info "=== Results ==="
    for r in "${results[@]}"; do
      info "  $r"
    done

    if [ "$all_passed" = true ]; then
      info "All suites passed."
    else
      error "Some suites failed."
    fi
    ;;

  clean)
    clean_all
    ;;

  *)
    usage
    ;;
esac
