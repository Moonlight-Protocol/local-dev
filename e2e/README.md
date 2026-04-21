# E2E / CI Infrastructure

Docker compose setup for running the full Moonlight stack in CI. No host dependencies beyond Docker.

## Architecture

```
┌──────────┐     ┌─────┐     ┌──────────┐     ┌─────────────┐
│ stellar  │     │ db  │     │ provider │     │ test-runner  │
│ (node)   │◄────│(pg) │◄────│ (deno)   │◄────│ (deno)      │
└──────────┘     └─────┘     └──────────┘     └─────────────┘
      ▲                            │ traces          │ traces
      │         ┌───────┐         ▼                  ▼
      └─────────│ setup │    ┌──────────┐
                │(1-shot)│   │  jaeger  │
                └───────┘    └──────────┘
```

Services:
- **stellar** — `stellar/quickstart` standalone node (RPC, Horizon, Friendbot)
- **db** — PostgreSQL for the provider platform
- **setup** — one-shot container that generates accounts, deploys contracts, writes config
- **provider** — provider platform (reads config from setup, runs migrations, serves API)
- **test-runner** — runs the E2E test suite against provider and stellar node
- **jaeger** — all-in-one tracing backend (OTLP collector + query UI on port 16686)

Each `docker compose up` creates an isolated network. Parallel runs don't interfere with each other.

## Prerequisites

### Docker images

Build locally or pull from GHCR:

```bash
# Option A: build locally
docker build -f Dockerfile.stellar-cli -t stellar-cli:local .
docker build -t provider-platform:local /path/to/provider-platform/

# Option B: pull from GHCR
docker pull ghcr.io/moonlight-protocol/stellar-cli:<version>
docker pull ghcr.io/moonlight-protocol/provider-platform:<version>
```

### Contract wasms

Download from a soroban-core release or build locally:

```bash
# From release
gh release download v0.1.0 --repo Moonlight-Protocol/soroban-core -p '*.wasm' -D wasms/

# Or from a local build
cp /path/to/soroban-core/target/wasm32v1-none/release/*.wasm wasms/
```

Expected files:
```
e2e/wasms/
├── channel_auth_contract.wasm
└── privacy_channel.wasm
```

## Usage

```bash
# Run everything (local images)
docker compose up --abort-on-container-exit

# Run with GHCR images
STELLAR_CLI_IMAGE=ghcr.io/moonlight-protocol/stellar-cli:0.1.0 \
PROVIDER_IMAGE=ghcr.io/moonlight-protocol/provider-platform:0.2.0 \
docker compose up --abort-on-container-exit

# Run infra only (no test runner)
docker compose up stellar db setup provider

# Custom wasm directory
WASM_DIR=/path/to/soroban-core/target/wasm32v1-none/release docker compose up
```

## Config flow

1. **setup** waits for stellar node to be healthy
2. **setup** generates accounts, deploys contracts, registers provider
3. **setup** writes `provider.env` and `contracts.env` to a shared volume
4. **provider** reads `provider.env` at startup, runs migrations, starts serving
5. **test-runner** reads `contracts.env` via env vars and runs the E2E test suite

## Running locally

Run tests via `test.sh` in the repo root. Each run spins up a fully isolated Docker stack (own Stellar, PostgreSQL, provider, council) using your current local source code:

```bash
# From local-dev/
./test.sh e2e                  # Payment flow
./test.sh otel                 # Payment flow + OTEL trace verification
./test.sh governance           # UC2 governance flows
./test.sh lifecycle            # Full lifecycle (deploy → payment → remove)
./test.sh pos-instant          # UC4 POS crypto instant payment
./test.sh all                  # All suites in parallel
```

No `up.sh` needed. Each run is independent — parallel runs don't interfere with each other or with your dev stack.

## Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Service definitions |
| `Dockerfile.stellar-cli` | Rust + Stellar CLI image for contract deployment |
| `setup.sh` | Account generation, contract deployment, config output |
| `provider-entrypoint.sh` | Loads config, runs migrations, starts provider |
| `main.ts` | E2E test entry point |
| `config.ts` | Config loader (env vars in Docker, .env files locally) |
| `account.ts` | UTXO account setup and derivation |
| `auth.ts` | SEP-10 style authentication with provider |
| `bundle.ts` | Bundle submission and polling |
| `deposit.ts` | Deposit flow |
| `receive.ts` | Prepare-to-receive flow |
| `send.ts` | Send flow |
| `withdraw.ts` | Withdraw flow |
| `tracer.ts` | OpenTelemetry adapter for SDK's MoonlightTracer interface |
| `verify-otel.ts` | Jaeger trace verification (16 checks) |
| `e2e-trace-ids.json` | Generated artifact — trace IDs from the last E2E run |

## OpenTelemetry / Jaeger

The E2E suite is instrumented with distributed tracing. When run with `OTEL_DENO=true` (set automatically by `deno task e2e`), traces are exported to Jaeger and can be inspected visually.

### How tracing works

There are **two services** producing traces:

- **`moonlight-e2e`** — the E2E test process. Creates spans for each test step (`e2e.deposit`, `e2e.send`, etc.), SDK operations (`PrivacyChannel.read`, `UtxoBasedAccount.deriveBatch`), auth flows, and bundle submission/polling. Outgoing `fetch()` calls automatically carry W3C `traceparent` headers.

- **`provider-platform`** — the privacy provider. Creates spans for request handling (auto-instrumented HTTP spans via `OTEL_DENO=true`) and application logic (`P_CreateChallenge`, `P_AddOperationsBundle`, `Executor.*`, `Verifier.*`, `Mempool.*`, `Bundle.*`).

**Distributed traces** connect the two: when the SDK makes an HTTP request to the provider, the provider's HTTP span appears as a child of the SDK's span within the same trace. The provider's application-level spans (background services like executor, verifier, mempool) run on polling loops and appear as **separate 1-span root traces** — they are not nested inside the HTTP request traces.

### Running

```bash
# Start the stack (includes Jaeger)
./up.sh

# Run E2E with tracing enabled
cd e2e
deno task e2e

# Verify traces were captured (16 checks)
deno task verify-otel

# Open Jaeger UI
open http://localhost:16686
```

### Navigating the Jaeger UI

#### 1. View all E2E traces

1. In the left sidebar, set **Service** to `moonlight-e2e`
2. Click **Find Traces**
3. You'll see 7 traces (one per E2E step), each showing:
   - Root span name (`e2e.fund_accounts`, `e2e.authenticate_alice`, etc.)
   - Total duration
   - Span count
   - Which services are involved (1 service = SDK only, 2 services = distributed)

The traces map 1:1 to the E2E steps:

| Trace | What it does | Distributed? |
|-------|-------------|--------------|
| `e2e.fund_accounts` | Funds test accounts via Friendbot | No (Friendbot only) |
| `e2e.authenticate_alice` | SEP-10 auth with provider | Yes |
| `e2e.authenticate_bob` | SEP-10 auth with provider | Yes |
| `e2e.deposit` | Deposit XLM into privacy channel | Yes |
| `e2e.prepare_receive` | Derive UTXOs for receiving | No (Soroban reads only) |
| `e2e.send` | Send XLM through privacy channel | Yes |
| `e2e.withdraw` | Withdraw XLM from privacy channel | Yes |

#### 2. Read an authentication trace

Click an **`e2e.authenticate_*`** trace. The waterfall view shows:

```
e2e.authenticate_alice                          ██████████████████████  (root span)
  auth.get_challenge                            ████████                 GET challenge from provider
    GET                                         ███████                  outgoing fetch()
      GET [provider-platform]                   ██████                   provider handles request
  auth.sign_challenge                               ██                   local crypto (no network)
  auth.verify_challenge                               ████████████████   POST signed challenge
    POST                                              ████████████████   outgoing fetch()
      POST [provider-platform]                        ███████████████    provider verifies
```

- **Indentation** = parent-child relationship
- **Two colors** = two services. The provider's spans are nested inside the SDK's HTTP spans — that's the `traceparent` link
- **`auth.sign_challenge`** has no children — it's pure local cryptographic signing
- Click any span to see its **Tags** (HTTP method, status code, URL) and **Logs/Events** (`enter`, `exit`)

#### 3. Read a deposit/send/withdraw trace

Click an **`e2e.deposit`** trace. This is the richest trace:

```
e2e.deposit                                     ████████████████████████████████████████
  UtxoBasedAccount.deriveBatch                  ██                                        derive UTXO keys
  UtxoBasedAccount.batchLoad                    ████                                      load UTXO state
    PrivacyChannel.read                         ████                                      read on-chain data
      POST                                      ███                                       Soroban RPC call
  bundle.submit                                     ██                                    submit to provider
    POST                                            ██                                    outgoing fetch()
      POST [provider-platform]                      █                                     provider accepts
  bundle.wait                                         ██████████████████████████████████   poll until done
    GET → GET [provider-platform]                     █  █  █                              polling requests
```

**Three phases:**
1. **Account setup** (first ~200ms) — derive keys, load on-chain UTXO state via Soroban RPC
2. **Bundle submission** (small sliver) — POST the privacy operations to the provider
3. **Waiting** (the long bar) — poll the provider every 5s until the bundle is processed. The gaps between GET spans are the sleep intervals

The `e2e.send` trace is similar but also includes `UtxoBasedAccount.selectUTXOsForTransfer` (a fast synchronous span for UTXO selection).

**Zoom in**: click and drag on the timeline header to zoom into the account setup phase. Click "Reset Zoom" (top-right) to restore.

#### 4. View provider application spans

The provider's background services (executor, verifier, mempool) run on polling loops independent of HTTP requests. Their spans appear as **separate 1-span root traces**, not nested inside the E2E traces.

1. Set **Service** to `provider-platform`
2. Set **Operation** to a specific span (e.g., `P_AddOperationsBundle`, `Executor.executeNext`)
3. Click **Find Traces**
4. Each result is a single-span trace. Click one to see its **Logs/Events** — these show the internal state machine:
   - `P_AddOperationsBundle`: `enter` → `session_valid` → `operations_classified` → `fee_calculated` → `exit`
   - `Executor.executeNext`: `enter` → `slot_found` → `transaction_built` → `submitted` → `exit`

To filter to spans from your E2E run (vs background noise), use **Min Duration** or narrow the **Lookback** time window.

#### 5. Inspect the distributed link

1. Open any distributed trace (e.g., `e2e.deposit`)
2. Find a provider-platform span (different color) — e.g., the POST inside `bundle.submit`
3. Click it to expand the detail panel
4. Look at **References** — it shows `CHILD_OF` with a parent span ID pointing to the SDK's outgoing HTTP span

This proves W3C traceparent propagation is working: the SDK's `fetch()` injected the trace context, and the provider's `Deno.serve()` extracted it.

#### 6. Compare operation durations

1. Service: `provider-platform`, Operation: `Executor.submitTransactionToNetwork`
2. Find Traces
3. Compare durations across the 3 bundles (deposit, send, withdraw) to see which transaction type is slowest on-chain

#### 7. Service dependency graph

Click **System Architecture** (or **Dependencies**) in the top navigation to see a graph of `moonlight-e2e` → `provider-platform` — the service dependency map derived from trace data.

### Sidebar filter reference

| Filter | Use case |
|--------|----------|
| Service | `moonlight-e2e` for SDK traces, `provider-platform` for server traces |
| Operation | Filter by span name (e.g., `e2e.deposit`, `P_AddOperationsBundle`) |
| Tags | Filter by attributes (e.g., `http.status_code=500` to find errors) |
| Min/Max Duration | Find slow operations (e.g., Min: `10s` to find long bundle waits) |
| Lookback | Narrow time window to filter out old/background traces |

### Trace verification

`deno task verify-otel` runs 16 automated checks against Jaeger:

- **Provider-platform** (8 checks): function-level spans, auth create/verify spans, bundle processing, Bundle.* helpers, spans with events, HTTP spans, background service spans
- **SDK** (7 checks): all 7 E2E step spans present, auth/bundle E2E spans, PrivacyChannel spans, UtxoBasedAccount spans, SDK spans with events
- **Distributed tracing** (2 checks): shared trace IDs between services, CHILD_OF parent-child references

It uses two query strategies to avoid background span noise:
1. **Trace-by-ID** — fetches exact E2E traces (for SDK + distributed checks)
2. **Time-windowed query** — fetches provider spans within the E2E time window (for application-level checks)
