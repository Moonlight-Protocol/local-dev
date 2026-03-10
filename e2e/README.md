# E2E / CI Infrastructure

Docker compose setup for running the full Moonlight stack in CI. No host dependencies beyond Docker.

## Architecture

```
┌──────────┐     ┌─────┐     ┌──────────┐     ┌─────────────┐
│ stellar  │     │ db  │     │ provider │     │ test-runner  │
│ (node)   │◄────│(pg) │◄────│ (deno)   │◄────│ (deno)      │
└──────────┘     └─────┘     └──────────┘     └─────────────┘
      ▲                            ▲
      │         ┌───────┐          │
      └─────────│ setup │──────────┘
                │(1-shot)│
                └───────┘
```

Services:
- **stellar** — `stellar/quickstart` standalone node (RPC, Horizon, Friendbot)
- **db** — PostgreSQL for the provider platform
- **setup** — one-shot container that generates accounts, deploys contracts, writes config
- **provider** — provider platform (reads config from setup, runs migrations, serves API)
- **test-runner** — runs the E2E test suite against provider and stellar node

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

## Running locally (without Docker)

The test suite also runs directly with Deno against a local stack started by `up.sh`:

```bash
cd e2e
deno task e2e
```

Config is loaded from env vars first, then `/config/contracts.env` (Docker), then `~/repos/provider-platform/.env` (local). Override the local path with `PROVIDER_PLATFORM_PATH`.

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
