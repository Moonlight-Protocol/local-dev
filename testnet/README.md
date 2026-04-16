# Testnet Verification Scripts

Scripts to verify that the deployed Moonlight testnet infrastructure works end-to-end. Each run is fully self-contained — generates ephemeral accounts, deploys fresh contracts, and exercises the full flow. No pre-existing state required.

## Prerequisites

- Deno installed
- Contract WASMs available at `../e2e/wasms/` (build with `stellar contract build` in soroban-core, or copy from a release)
- For OTEL verification: `TEMPO_URL`, `TEMPO_AUTH`, `PROVIDER_SERVICE_NAME`, `SDK_SERVICE_NAME` env vars set

## Test Suites

### 1. Payment Flow (`testnet/main.ts`)

Quick end-to-end payment test. Deploys contracts, registers a PP, then runs deposit → send → withdraw. Exports OTEL traces.

```bash
cd testnet && deno task e2e
```

**What it tests:** Contract deployment, council + PP registration through both platforms, bundle submission and execution (deposit, send, withdraw). Fails early if platform registration is broken — isolates bugs to the bundle/execution pipeline.

### 2. OTEL Verification — Payment (`testnet/verify-otel.ts`)

Verifies that suite 1 produced traces in Grafana Tempo. Run after suite 1 with a 60s wait for trace ingestion.

```bash
sleep 60 && deno run --allow-all testnet/verify-otel.ts
```

### 3. Lifecycle Flow (`lifecycle/testnet-verify.ts`)

Comprehensive lifecycle test. Full UC2 governance flow — admin creates council, adds channel, PP operator registers and submits a join request, admin approves, on-chain `add_provider`, event watcher activates membership, then deposit → send → withdraw. Exports OTEL traces.

```bash
cd .. && deno run --allow-all lifecycle/testnet-verify.ts
```

**What it tests:** Everything in the payment flow plus the complete PP-joins-council governance flow with both council-platform and provider-platform cooperating.

### 4. OTEL Verification — Lifecycle (`lifecycle/verify-otel.ts`)

Verifies that suite 3 produced traces in Grafana Tempo. Run after suite 3 with a 60s wait for trace ingestion.

```bash
sleep 60 && deno run --allow-all lifecycle/verify-otel.ts
```

## Environment Variables

All scripts use sensible testnet defaults. Override via env vars when needed:

| Variable | Default | Used by |
|---|---|---|
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | Suites 1, 3 |
| `FRIENDBOT_URL` | `https://friendbot.stellar.org` | Suites 1, 3 |
| `COUNCIL_URL` | `https://council-api-testnet.moonlightprotocol.io` | Suites 1, 3 |
| `PROVIDER_URL` | `https://provider-api-testnet.moonlightprotocol.io` | Suites 1, 3 |
| `CHANNEL_AUTH_WASM` | `../e2e/wasms/channel_auth_contract.wasm` | Suites 1, 3 |
| `PRIVACY_CHANNEL_WASM` | `../e2e/wasms/privacy_channel.wasm` | Suites 1, 3 |
| `MASTER_SECRET` | (none — random keys) | Suites 1, 3 |
| `TEMPO_URL` | (none) | Suites 2, 4 |
| `TEMPO_AUTH` | (none) | Suites 2, 4 |
| `PROVIDER_SERVICE_NAME` | (none) | Suites 2, 4 |
| `SDK_SERVICE_NAME` | (none) | Suites 2, 4 |
| `TRACE_POLL_TIMEOUT_MS` | `30000` | Suites 2, 4 |

## Run Order

```bash
# Suite 1: Payment flow (~5 min)
cd testnet && deno task e2e

# Suite 2: OTEL verification for suite 1 (wait 60s for ingestion)
sleep 60 && deno run --allow-all verify-otel.ts

# Suite 3: Lifecycle flow (~5 min)
cd .. && deno run --allow-all lifecycle/testnet-verify.ts

# Suite 4: OTEL verification for suite 3 (wait 60s for ingestion)
sleep 60 && deno run --allow-all lifecycle/verify-otel.ts
```

Flow scripts (1, 3) export traces and write trace IDs. Verify scripts (2, 4) read those trace IDs and check Tempo. Suites 1 and 3 can run independently — they each deploy fresh contracts.
