# synthetic-traffic

Slow, continuous, realistic-looking activity on the Moonlight **testnet** —
councils forming, providers joining, entities KYC'ing, transactions flowing — so
the network dashboard and provider dashboards show an organically growing
network instead of sitting empty. **Not a load test.**

Design settled with Gorka 2026-07-23 (task `theahaco-submodule-0008`):
corp×region councils (8, staggered over days 0–5, Mercado Libre Mercosur first,
Careem Gulf the near-idle laggard), providers = countries (~24), entities KYC
with their home provider with dormancy-heavy rosters (~2,500–4,000 direct
entities at steady state), chain-shaped traffic (deposit → in-channel sends →
withdraw) with country at the ramps — domestic-dominant value, cross-country
biased to plausible corridors (AR↔UY, MX↔US, intra-EU, KE↔TZ).

## How it works

Everything derives from `SYNTRAF_MASTER_SECRET`: every council admin, provider,
and entity key, and every random draw (via seeded PRNG streams). The
**timeline** — which council forms when, when each provider joins, when each
entity appears, registers, first deposits — is therefore a pure function of the
master secret. Each tick the **reconciler** compares that timeline against
recorded state and creates whatever is due (bootstrap-as-history: the
generator's own runtime builds the network's history; nothing is pre-populated).
Then the **planner** samples Poisson arrivals per provider — shaped by tier peak
rates, council busyness, roster adoption ramp, the country's local-time diurnal
curve, and weekday dips — and executes them through the production APIs (SEP-10
session → MLXDR bundles via provider-platform), exactly like `send-loop.ts` /
the task-0005 flow.

State (`.syntraf-state.json`) only records progress; losing it loses
bookkeeping, not identities.

## Hard safety rails

- **Testnet/local only.** `env.ts` refuses to start on any passphrase other than
  the local standalone network or the SDF testnet; the mainnet passphrase is
  explicitly rejected. Funding is friendbot-only — a mechanism that does not
  exist on mainnet.
- **Registry-first deploys.** All contract deployments go through
  `stellar registry publish` / `deploy` (`moonlight-council` +
  `moonlight-privacy-channel`, versioned). Locally the engine publishes to the
  root registry it manages (`setup-registry.sh` deploys it — the one documented
  bootstrap exception); on the shared testnet registry set
  `SYNTRAF_REGISTRY_NS=moonlight/` once the sub-registry exists.
- **Reset-aware.** A ledger-sequence regression (testnet wipe, local recreate)
  archives state, alerts, and re-bootstraps from a fresh genesis.
- **Dead-man alerting.** Silent in normal operation; the Discord webhook fires
  on low funding runway, network resets, and all-actions-failed ticks. The
  all-failed page needs evidence, not a ratio: a tick pages on its own only once
  it ran `MIN_ALL_FAILED_ACTIONS` real actions, and thinner ticks page after
  `ALL_FAILED_TICKS` consecutive all-failed ticks, then hourly while the outage
  lasts (`alerts.ts`, unit-tested with `deno task test`). One transient on-chain
  failure on a one-action off-peak tick is noise, not an outage.

## Local proving (before any testnet run)

```bash
# 1. Stack + protocol state
./up.sh

# 2. Registry contract on the local network (one-time)
./synthetic-traffic/setup-registry.sh
export STELLAR_REGISTRY_CONTRACT_ID=<printed id>

# 3. Released contract wasms (published to the registry by the engine)
./synthetic-traffic/fetch-wasms.sh          # v0.5.0

# 4. Run compressed: 1 virtual day ≈ 5 real minutes, 30s ticks
export SYNTRAF_MASTER_SECRET=SC...          # any funded-format secret; local only
export SYNTRAF_TIME_SCALE=288
export SYNTRAF_TICK_MS=30000
./synthetic-traffic/synthetic-traffic.sh

# Single tick (smoke): SYNTRAF_ONCE=true ./synthetic-traffic/synthetic-traffic.sh
```

Watch the network dashboard (`:3040`) paint the bootstrap: MELI Mercosur first,
providers trickling in, entities registering, then traffic.

## Testnet

Same engine, testnet env
(`STELLAR_NETWORK_PASSPHRASE="Test SDF Network ;
September 2015"`, testnet
RPC/friendbot, deployed platform URLs, `SYNTRAF_TIME_SCALE=1`), running on the
approved always-on Fly instance. Prereqs settled 2026-07-23: deployed fleet is
on sdk 0.12.1 (16/16 verified); testnet registry contract id + `moonlight/`
namespace arrive via Chad (publish under `unverified/` until then).

## Env reference

| Var                                                 | Default                 | Purpose                                  |
| --------------------------------------------------- | ----------------------- | ---------------------------------------- |
| `SYNTRAF_MASTER_SECRET`                             | — (required)            | root of every derived key + the RNG seed |
| `STELLAR_REGISTRY_CONTRACT_ID`                      | — (required)            | registry the CLI deploys through         |
| `STELLAR_NETWORK_PASSPHRASE`                        | local standalone        | allowlisted: local, testnet              |
| `STELLAR_RPC_URL` / `FRIENDBOT_URL` / `HORIZON_URL` | local stack             | network endpoints                        |
| `COUNCIL_URL` / `PROVIDER_URL`                      | `:3015` / `:3010`       | platform APIs                            |
| `SYNTRAF_TIME_SCALE`                                | `1`                     | virtual-time compression (local proving) |
| `SYNTRAF_TICK_MS`                                   | `300000`                | engine tick (jittered ±15%)              |
| `SYNTRAF_MAX_ACTIONS_PER_TICK`                      | `40`                    | catch-up bound; drops are logged         |
| `SYNTRAF_CONTRACTS_VERSION`                         | `0.5.0`                 | soroban-core release to publish/deploy   |
| `SYNTRAF_REGISTRY_NS`                               | (empty = root)          | registry namespace prefix                |
| `SYNTRAF_DISCORD_WEBHOOK_URL`                       | unset (log-only)        | dead-man alert channel                   |
| `SYNTRAF_AGGREGATORS`                               | `false`                 | pay-platform aggregator driver (pending) |
| `SYNTRAF_STATE_FILE`                                | `./.syntraf-state.json` | progress bookkeeping                     |

## Not yet wired

- **Aggregator driver** (`SYNTRAF_AGGREGATORS`): RappiPay-type (AR/BR/CL/PE/CO,
  one pay-account per country, ~2,000 end users) and Venmo-type (US, ~1,500) via
  the pay-platform instant flow. The timeline schedules them and the reconciler
  logs when they come due; the driver is the next build step.
- **Testnet USDC funding**: locally the engine self-issues USDC; on testnet
  entities need Circle-faucet USDC via a treasury account (manual top-up) —
  until configured, testnet traffic is XLM-only and says so in the logs.
- **FAILED-bundle seasoning** (`lib/client/fail-inject.ts`) — occasional
  organic-looking failures; trivial to add once the core loop is proven.
