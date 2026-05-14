#!/usr/bin/env bash
# verify-deploy.sh — single-shot deploy-tag-drift checker.
#
# Probes 14 deployed endpoints (6 backend /api/v1/health, 8 frontend /health.json,
# testnet + mainnet for each app), reads each originating repo's latest git tag,
# and prints one row per endpoint. Exits 0 if every deployed version matches the
# latest tag, 1 if any drift is detected, 2 if any endpoint is unreachable or
# returns invalid JSON.
#
# Requires: bash, curl, jq, gh (only for `gh api repos/.../tags`).

set -uo pipefail

# app|env|url|repo
ENDPOINTS=(
  "council-platform|mainnet|https://council-api.moonlightprotocol.io/api/v1/health|council-platform"
  "council-platform|testnet|https://council-api-testnet.moonlightprotocol.io/api/v1/health|council-platform"
  "pay-platform|mainnet|https://pay-api.moonlightprotocol.io/api/v1/health|pay-platform"
  "pay-platform|testnet|https://pay-api-testnet.moonlightprotocol.io/api/v1/health|pay-platform"
  "provider-platform|mainnet|https://provider-api.moonlightprotocol.io/api/v1/health|provider-platform"
  "provider-platform|testnet|https://provider-api-testnet.moonlightprotocol.io/api/v1/health|provider-platform"
  "council-console|mainnet|https://council.moonlightprotocol.io/health.json|council-console"
  "council-console|testnet|https://council-testnet.moonlightprotocol.io/health.json|council-console"
  "provider-console|mainnet|https://provider.moonlightprotocol.io/health.json|provider-console"
  "provider-console|testnet|https://provider-testnet.moonlightprotocol.io/health.json|provider-console"
  "network-dashboard|mainnet|https://dashboard.moonlightprotocol.io/health.json|network-dashboard"
  "network-dashboard|testnet|https://dashboard-testnet.moonlightprotocol.io/health.json|network-dashboard"
  "moonlight-pay|mainnet|https://pay.moonlightprotocol.io/health.json|moonlight-pay"
  "moonlight-pay|testnet|https://pay-testnet.moonlightprotocol.io/health.json|moonlight-pay"
)

OWNER="${MOONLIGHT_OWNER:-Moonlight-Protocol}"
TIMEOUT="${VERIFY_TIMEOUT:-10}"
# Override the tag-fetch index for drift simulation (e.g. TAG_INDEX=1 ⇒ second-latest tag).
TAG_INDEX="${TAG_INDEX:-0}"

fetch_latest_tag() {
  local repo="$1" tag
  tag=$(gh api "repos/${OWNER}/${repo}/tags" --jq ".[${TAG_INDEX}].name" 2>/dev/null || true)
  printf '%s' "${tag:-?}"
}

# Echoes "deployed_version|STATUS" (STATUS in OK|DRIFT|UNREACHABLE).
probe() {
  local url="$1" expected_tag="$2"
  local body version
  body=$(curl -fsS --max-time "$TIMEOUT" "$url" 2>/dev/null || true)
  [ -z "$body" ] && { printf '?|UNREACHABLE'; return; }
  version=$(jq -r '.version // empty' <<<"$body" 2>/dev/null || true)
  [ -z "$version" ] && { printf '?|UNREACHABLE'; return; }
  if [ "v${version}" = "${expected_tag}" ]; then
    printf '%s|OK' "$version"
  else
    printf '%s|DRIFT' "$version"
  fi
}

worst=0  # 0 = all OK, 1 = drift, 2 = unreachable
bump_worst() {
  case "$1" in
    DRIFT) [ "$worst" -lt 1 ] && worst=1 ;;
    UNREACHABLE) worst=2 ;;
  esac
}

printf '%-20s %-9s %-12s %-13s %s\n' "APP" "ENV" "DEPLOYED" "LATEST_TAG" "STATUS"
for row in "${ENDPOINTS[@]}"; do
  IFS='|' read -r app env url repo <<<"$row"
  tag=$(fetch_latest_tag "$repo")
  IFS='|' read -r ver status <<<"$(probe "$url" "$tag")"
  printf '%-20s %-9s %-12s %-13s %s\n' "$app" "$env" "$ver" "$tag" "$status"
  bump_worst "$status"
done

exit "$worst"
