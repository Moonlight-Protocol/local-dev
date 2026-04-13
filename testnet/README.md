# Testnet Verification Scripts

Scripts to verify that the deployed Moonlight testnet infrastructure works end-to-end. Each run is fully self-contained — generates ephemeral accounts, deploys fresh contracts, and exercises the full flow. No pre-existing state required.

## Prerequisites

- Deno installed
- Contract WASMs available at `../e2e/wasms/` (build with `stellar contract build` in soroban-core, or copy from a release)
- For OTEL verification: `TEMPO_URL` and `TEMPO_AUTH` env vars set (Grafana Cloud credentials)

## Test Suites

### 1. Payment Flow (`testnet/main.ts`)

Quick end-to-end payment test. Deploys contracts, registers a PP, then runs deposit → send → withdraw.

```bash
cd testnet && deno task e2e
```

**What it tests:** Contract deployment, council + PP registration through both platforms, bundle submission and execution (deposit, send, withdraw). Fails early if platform registration is broken — isolates bugs to the bundle/execution pipeline.

**Default endpoints:** `provider-api-testnet.moonlightprotocol.io`, `council-api-testnet.moonlightprotocol.io`

### 2. OTEL Trace Verification (`testnet/verify-otel.ts`)

Verifies that the E2E test produced traces in Grafana Tempo. Run after the payment flow test.

```bash
TEMPO_URL=https://aha.grafana.net TEMPO_AUTH="Basic ..." deno run --allow-all testnet/verify-otel.ts
```

**Prerequisite:** Payment flow test must have completed with `OTEL_DENO=true` (the `deno task e2e` command sets this automatically). The test writes trace IDs to `e2e-trace-ids.json`.

### 3. Full Lifecycle Verification (`lifecycle/testnet-verify.ts`)

Comprehensive lifecycle test. Same as the payment flow but with the full UC2 governance flow — admin creates council, adds channel, PP operator registers and submits a join request, admin approves, on-chain `add_provider`, event watcher activates membership, then deposit → send → withdraw.

```bash
deno run --allow-all lifecycle/testnet-verify.ts
```

**What it tests:** Everything in the payment flow plus the complete PP-joins-council governance flow with both council-platform and provider-platform cooperating. This is the closest to a real user flow.

**OTEL:** If `TEMPO_URL` and `TEMPO_AUTH` are set, also verifies traces in Grafana Tempo after the flow completes. If not set, OTEL verification is skipped (the flow itself still runs).

### 4. Full Lifecycle + OTEL (`lifecycle/testnet-verify.ts` with Tempo credentials)

Same as #3 but with OTEL trace verification enabled.

```bash
TEMPO_URL=https://aha.grafana.net \
TEMPO_AUTH="Basic ..." \
deno run --allow-all lifecycle/testnet-verify.ts
```

**What it adds over #3:** After the lifecycle flow completes, queries Grafana Tempo to verify that traces from the test run were ingested and contain the expected spans.

## Environment Variables

All scripts use sensible testnet defaults. Override via env vars when needed:

| Variable | Default | Used by |
|---|---|---|
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | All |
| `FRIENDBOT_URL` | `https://friendbot.stellar.org` | All |
| `COUNCIL_URL` | `https://council-api-testnet.moonlightprotocol.io` | All |
| `PROVIDER_URL` | `https://provider-api-testnet.moonlightprotocol.io` | All |
| `CHANNEL_AUTH_WASM` | `../e2e/wasms/channel_auth_contract.wasm` | Payment flow, Lifecycle |
| `PRIVACY_CHANNEL_WASM` | `../e2e/wasms/privacy_channel.wasm` | Payment flow, Lifecycle |
| `TEMPO_URL` | (none) | OTEL verification |
| `TEMPO_AUTH` | (none) | OTEL verification |

## Run Order

For a complete testnet verification:

```bash
# 1. Payment flow (fast, ~3 min)
cd testnet && deno task e2e

# 2. OTEL trace check (requires Grafana credentials)
TEMPO_URL=... TEMPO_AUTH=... deno run --allow-all verify-otel.ts
cd ..

# 3. Full lifecycle (comprehensive, ~3.5 min)
TEMPO_URL=... TEMPO_AUTH=... deno run --allow-all lifecycle/testnet-verify.ts
```

Suites 1 and 3 can run independently — they each deploy fresh contracts.
