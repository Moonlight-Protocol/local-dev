# Testnet Verification Scripts

Scripts to verify that the deployed Moonlight testnet infrastructure works end-to-end. Each run is fully self-contained — generates ephemeral accounts, deploys fresh contracts, and exercises the full flow. No pre-existing state required.

## Prerequisites

- Deno installed
- Contract WASMs available at `../e2e/wasms/` (build with `stellar contract build` in soroban-core, or copy from a release)
- For OTEL verification against deployed testnet: `TEMPO_URL`, `TEMPO_AUTH`, `PROVIDER_SERVICE_NAME`, `SDK_SERVICE_NAME`, `COUNCIL_SERVICE_NAME` env vars set
- For OTEL verification against local stack: nothing extra — see [Run against the local stack](#run-against-the-local-stack) below

## Test Suites

### 1. Payment Flow (`testnet/main.ts`)

Quick end-to-end payment test. Deploys contracts, registers a PP, then runs deposit → send → withdraw. Exports OTEL traces.

```bash
cd testnet && deno task e2e
```

**What it tests:** Contract deployment, council + PP registration through both platforms, bundle submission and execution (deposit, send, withdraw). Fails early if platform registration is broken — isolates bugs to the bundle/execution pipeline.

### 2. OTEL Verification — Payment (`testnet/verify-otel.ts` / `testnet/verify-otel-local.ts`)

Verifies that suite 1 produced traces. Run after suite 1 with a 60s wait for trace ingestion.

- Deployed testnet → reads from Grafana Cloud Tempo:
  ```bash
  sleep 60 && deno run --allow-all testnet/verify-otel.ts
  ```
- Local stack → reads from local Jaeger (no Tempo credentials needed):
  ```bash
  deno run --allow-all testnet/verify-otel-local.ts
  ```

### 3. Lifecycle Flow (`lifecycle/testnet-verify.ts`)

Comprehensive lifecycle test. Full UC2 governance flow — admin creates council, adds channel, PP operator registers and submits a join request, admin approves, on-chain `add_provider`, event watcher activates membership, then deposit → send → withdraw. Exports OTEL traces.

```bash
cd .. && deno run --allow-all lifecycle/testnet-verify.ts
```

**What it tests:** Everything in the payment flow plus the complete PP-joins-council governance flow with both council-platform and provider-platform cooperating.

### 4. OTEL Verification — Lifecycle (`lifecycle/verify-otel.ts` / `lifecycle/verify-otel-local.ts`)

Verifies that suite 3 produced traces. Run after suite 3 with a 60s wait for trace ingestion.

- Deployed testnet → reads from Grafana Cloud Tempo:
  ```bash
  sleep 60 && deno run --allow-all lifecycle/verify-otel.ts
  ```
- Local stack → reads from local Jaeger (no Tempo credentials needed):
  ```bash
  deno run --allow-all lifecycle/verify-otel-local.ts
  ```

## Environment Variables

All scripts use sensible testnet defaults. Override via env vars when needed:

| Variable | Default | Used by |
|---|---|---|
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | Suites 1, 3 |
| `FRIENDBOT_URL` | `https://friendbot.stellar.org` | Suites 1, 3 |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Suites 1, 3 |
| `COUNCIL_URL` | `https://council-api-testnet.moonlightprotocol.io` | Suites 1, 3 |
| `PROVIDER_URL` | `https://provider-api-testnet.moonlightprotocol.io` | Suites 1, 3 |
| `CHANNEL_AUTH_WASM` | `../e2e/wasms/channel_auth_contract.wasm` | Suites 1, 3 |
| `PRIVACY_CHANNEL_WASM` | `../e2e/wasms/privacy_channel.wasm` | Suites 1, 3 |
| `MASTER_SECRET` | (none — random keys) | Suites 1, 3 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (Grafana Cloud OTLP) | Suites 1, 3 |
| `TEMPO_URL` | (none) | Suites 2, 4 (Tempo) |
| `TEMPO_AUTH` | (none) | Suites 2, 4 (Tempo) |
| `JAEGER_URL` | `http://localhost:16686` | Suites 2, 4 (local) |
| `PROVIDER_SERVICE_NAME` | (none) | Suites 2, 4 |
| `SDK_SERVICE_NAME` | (none) | Suites 2, 4 |
| `COUNCIL_SERVICE_NAME` | (none) | Suites 2, 4 (cp#28 spans + sdk↔cp continuity) |
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

Flow scripts (1, 3) export traces and write trace IDs. Verify scripts (2, 4) read those trace IDs and check Tempo (or Jaeger, locally). Suites 1 and 3 can run independently — they each deploy fresh contracts.

## Run against the local stack

The same suites can be pointed at the local stack started by `up.sh` — useful for debugging when something fails on deployed testnet (or just to avoid burning testnet airdrops). Trace verification uses the local Jaeger instance instead of Grafana Cloud Tempo via the `verify-otel-local.ts` companions.

### Quickest path: wrapper script

```bash
./testnet/run-local.sh            # runs all 4 suites
./testnet/run-local.sh payment    # suite 1 + suite 2
./testnet/run-local.sh lifecycle  # suite 3 + suite 4
./testnet/run-local.sh 1          # individual suite
```

The wrapper exports the env vars in the table below, then invokes the underlying Deno scripts. Override any variable by exporting it before running the wrapper (e.g. `JAEGER_URL=http://my-jaeger:16686 ./testnet/run-local.sh 2`).

### Manual invocation

If you'd rather invoke the scripts directly, export the local-stack env block first:

```bash
export STELLAR_RPC_URL=http://localhost:8000/soroban/rpc
export FRIENDBOT_URL=http://localhost:8000/friendbot
export STELLAR_NETWORK_PASSPHRASE="Standalone Network ; February 2017"
export COUNCIL_URL=http://localhost:3015
export PROVIDER_URL=http://localhost:3010
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_DENO=true
export OTEL_SERVICE_NAME=moonlight-e2e
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
# verifier-only:
export JAEGER_URL=http://localhost:16686  # optional — this is the default
export PROVIDER_SERVICE_NAME=provider-platform
export SDK_SERVICE_NAME=moonlight-e2e
export COUNCIL_SERVICE_NAME=council-platform

cd testnet && deno run --allow-all main.ts                # suite 1
deno run --allow-all verify-otel-local.ts                 # suite 2 (Jaeger)
cd .. && deno run --allow-all lifecycle/testnet-verify.ts # suite 3
deno run --allow-all lifecycle/verify-otel-local.ts       # suite 4 (Jaeger)
```

The non-obvious bit: the local Stellar quickstart uses the **`Standalone Network ; February 2017`** passphrase, not the testnet passphrase. Without overriding, transactions fail with `txBadAuth`.

The verifier scripts (`verify-otel-local.ts`) read from local Jaeger, not Grafana Cloud, so no `TEMPO_URL`/`TEMPO_AUTH` are needed.
