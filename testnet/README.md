# Testnet Verification Scripts

Scripts to verify that the deployed Moonlight testnet infrastructure works
end-to-end. Each run is fully self-contained — generates ephemeral accounts,
deploys fresh contracts, and exercises the full flow. No pre-existing state
required.

## Prerequisites

- Deno installed
- Contract WASMs available at `../e2e/wasms/` (build with
  `stellar contract build` in soroban-core, or copy from a release)
- For OTEL verification against deployed testnet: `TEMPO_URL`, `TEMPO_AUTH`, and
  `MOONLIGHT_NETWORK` env vars set (`MOONLIGHT_NETWORK` defaults to `testnet`;
  valid values: `testnet`, `mainnet`, `local`)
- For OTEL verification against local stack: nothing extra — see
  [Run against the local stack](#run-against-the-local-stack) below

## Test Suites

### 1. Payment Flow (`testnet/main.ts`)

Quick end-to-end payment test. Deploys contracts, registers a PP, then runs
deposit → send → withdraw. Exports OTEL traces.

Use `./testnet/run-tempo.sh` against deployed Tempo; it requires
`OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` to be set and
will fail fast if either is missing. See
[Run against deployed Tempo](#run-against-deployed-tempo) below.

```bash
./testnet/run-tempo.sh
```

**What it tests:** Contract deployment, council + PP registration through both
platforms, bundle submission and execution (deposit, send, withdraw). Fails
early if platform registration is broken — isolates bugs to the bundle/execution
pipeline.

### 2. OTEL Verification — Payment (`testnet/verify-otel.ts` / `testnet/verify-otel-local.ts`)

Verifies that suite 1 produced traces. Run after suite 1 with a 60s wait for
trace ingestion.

- Deployed testnet → reads from Grafana Cloud Tempo:
  ```bash
  sleep 60 && deno run --allow-all testnet/verify-otel.ts
  ```
- Local stack → reads from local Jaeger (no Tempo credentials needed):
  ```bash
  deno run --allow-all testnet/verify-otel-local.ts
  ```

### 3. Lifecycle Flow (`lifecycle/testnet-verify.ts`)

Comprehensive lifecycle test. Full UC2 governance flow — admin creates council,
adds channel, PP operator registers and submits a join request, admin approves,
on-chain `add_provider`, event watcher activates membership, then deposit → send
→ withdraw. Exports OTEL traces.

```bash
cd .. && deno run --allow-all lifecycle/testnet-verify.ts
```

**What it tests:** Everything in the payment flow plus the complete
PP-joins-council governance flow with both council-platform and
provider-platform cooperating.

### 4. OTEL Verification — Lifecycle (`lifecycle/verify-otel.ts` / `lifecycle/verify-otel-local.ts`)

Verifies that suite 3 produced traces. Run after suite 3 with a 60s wait for
trace ingestion.

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

| Variable                      | Default                                             | Used by                                                                               |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `STELLAR_RPC_URL`             | `https://soroban-testnet.stellar.org`               | Suites 1, 3                                                                           |
| `FRIENDBOT_URL`               | `https://friendbot.stellar.org`                     | Suites 1, 3                                                                           |
| `STELLAR_NETWORK_PASSPHRASE`  | `Test SDF Network ; September 2015`                 | Suites 1, 3                                                                           |
| `COUNCIL_URL`                 | `https://council-api-testnet.moonlightprotocol.io`  | Suites 1, 3                                                                           |
| `PROVIDER_URL`                | `https://provider-api-testnet.moonlightprotocol.io` | Suites 1, 3                                                                           |
| `CHANNEL_AUTH_WASM`           | `../e2e/wasms/channel_auth_contract.wasm`           | Suites 1, 3                                                                           |
| `PRIVACY_CHANNEL_WASM`        | `../e2e/wasms/privacy_channel.wasm`                 | Suites 1, 3                                                                           |
| `MASTER_SECRET`               | (none — random keys)                                | Suites 1, 3                                                                           |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (Grafana Cloud OTLP)                                | Suites 1, 3                                                                           |
| `TEMPO_URL`                   | (none)                                              | Suites 2, 4 (Tempo)                                                                   |
| `TEMPO_AUTH`                  | (none)                                              | Suites 2, 4 (Tempo)                                                                   |
| `JAEGER_URL`                  | `http://localhost:16686`                            | Suites 2, 4 (local)                                                                   |
| `MOONLIGHT_NETWORK`           | `testnet`                                           | Suites 2, 4 (Tempo only — derives `<service>-<network>`)                              |
| `TRACE_POLL_TIMEOUT_MS`       | `30000`                                             | Suites 2, 4                                                                           |
| `E2E_TRACE_IDS_PATH`          | `e2e-trace-ids.json` (CWD-relative)                 | Suites 1, 3 (writer); set to `e2e/e2e-trace-ids.json` for suite 3 so suite 4 finds it |

## Run Order

```bash
# Suite 1: Payment flow (~5 min)
./testnet/run-tempo.sh

# Suite 2: OTEL verification for suite 1 (wait 60s for ingestion)
sleep 60 && deno run --allow-all testnet/verify-otel.ts

# Suite 3: Lifecycle flow (~5 min)
E2E_TRACE_IDS_PATH=e2e/e2e-trace-ids.json \
  deno run --allow-all lifecycle/testnet-verify.ts

# Suite 4: OTEL verification for suite 3 (wait 60s for ingestion)
sleep 60 && deno run --allow-all lifecycle/verify-otel.ts
```

`lib/client/tracer.ts` writes the trace IDs to a CWD-relative
`e2e-trace-ids.json` by default, while `lifecycle/verify-otel.ts` reads from
`e2e/e2e-trace-ids.json` (relative to its own file). When suite 3 is invoked
from the local-dev root, the two paths don't line up — suite 4 then reads a
stale file (or fails with "trace not found in Tempo"). Pinning
`E2E_TRACE_IDS_PATH` to `e2e/e2e-trace-ids.json` routes both to the same place.
Suite 1's `run-tempo.sh` wrapper sidesteps this by `cd`-ing into `testnet/`
before `deno task e2e` runs, so the file lands next to `testnet/verify-otel.ts`
where it expects it.

Flow scripts (1, 3) export traces and write trace IDs. Verify scripts (2, 4)
read those trace IDs and check Tempo (or Jaeger, locally). Suites 1 and 3 can
run independently — they each deploy fresh contracts.

## Run against deployed Tempo

The flow scripts produce OTLP spans and need `OTEL_EXPORTER_OTLP_ENDPOINT` and
`OTEL_EXPORTER_OTLP_HEADERS` to ship them. Deno's OTEL exporter silent-fails
when those are unset — the run reports success, but Tempo receives 0 SDK spans.

`./testnet/run-tempo.sh` is the supported entry point: it asserts both vars are
set, errors out naming the missing one(s) if not, and otherwise execs
`deno task e2e`.

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT='https://otlp-gateway-prod-...grafana.net/otlp'
export OTEL_EXPORTER_OTLP_HEADERS='authorization=Basic <token>'
./testnet/run-tempo.sh
```

The endpoint is the **base** path (`/otlp`), not `/otlp/v1/traces`. Deno's
HTTP/protobuf OTLP exporter appends `/v1/traces` itself; if you include it in
the env value the SDK ships to `.../otlp/v1/traces/v1/traces`, which Grafana
silently returns as a 404 — the run reports success and Tempo receives 0 SDK
spans. Suite 2/4 will then fail with `E2E step spans (e2e.*): 0 (expected >= 6)`
even though provider-platform spans (which export from Fly, not this script)
land correctly.

For suite 3 (lifecycle), the same env vars must be set in the shell — the
`lifecycle/testnet-verify.ts` flow reads them directly. There is no
lifecycle-specific wrapper today; if you forget either var, you'll see no SDK
spans in suite 4 verification.

### What `run-tempo.sh` checks for

The wrapper only enforces the two OTLP exporter envs. The other variables in the
[Environment Variables](#environment-variables) table still apply (testnet
defaults are baked in; override only when pointing at non-default URLs or
seeding deterministic keys).

## Run against the local stack

The same suites can be pointed at the local stack started by `up.sh` — useful
for debugging when something fails on deployed testnet (or just to avoid burning
testnet airdrops). Trace verification uses the local Jaeger instance instead of
Grafana Cloud Tempo via the `verify-otel-local.ts` companions.

### Quickest path: wrapper script

```bash
./testnet/run-local.sh            # runs all 4 suites
./testnet/run-local.sh payment    # suite 1 + suite 2
./testnet/run-local.sh lifecycle  # suite 3 + suite 4
./testnet/run-local.sh 1          # individual suite
```

The wrapper exports the env vars in the table below, then invokes the underlying
Deno scripts. Override any variable by exporting it before running the wrapper
(e.g. `JAEGER_URL=http://my-jaeger:16686 ./testnet/run-local.sh 2`).

### Manual invocation

If you'd rather invoke the scripts directly, export the local-stack env block
first:

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
# Local verifiers (verify-otel-local.ts) hardcode network=local, so they emit
# unsuffixed service names (provider-platform, council-platform) automatically.
# When pointing at Tempo, set MOONLIGHT_NETWORK=testnet|mainnet (default testnet).

cd testnet && deno run --allow-all main.ts                # suite 1
deno run --allow-all verify-otel-local.ts                 # suite 2 (Jaeger)
cd .. && deno run --allow-all lifecycle/testnet-verify.ts # suite 3
deno run --allow-all lifecycle/verify-otel-local.ts       # suite 4 (Jaeger)
```

The non-obvious bit: the local Stellar quickstart uses the
**`Standalone Network ; February 2017`** passphrase, not the testnet passphrase.
Without overriding, transactions fail with `txBadAuth`.

The verifier scripts (`verify-otel-local.ts`) read from local Jaeger, not
Grafana Cloud, so no `TEMPO_URL`/`TEMPO_AUTH` are needed.
