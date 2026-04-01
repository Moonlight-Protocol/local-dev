# Local Dev

Run the full Moonlight stack locally: Stellar network, smart contracts, privacy provider, consoles, and dashboards.

## Prerequisites

| Tool | Install |
|------|---------|
| Docker | [docker.com](https://docs.docker.com/get-docker/) |

Rust/Cargo, Stellar CLI, and Deno are auto-installed by `up.sh` if missing.

## Repos

Clone all repos to `~/repos/`:

```
~/repos/
├── local-dev/              # This repo (setup scripts, E2E infrastructure)
├── soroban-core/           # Smart contracts (channel-auth, privacy-channel)
├── provider-platform/      # Privacy provider server
├── provider-console/       # Provider dashboard
├── council-console/        # Council dashboard
└── network-dashboard/      # Network monitoring dashboard
```

If your repos live somewhere other than `~/repos/`, set `BASE_DIR`:

```bash
BASE_DIR=~/projects ./up.sh
```

You can also override individual repo paths:

```bash
SOROBAN_CORE_PATH=~/other/soroban-core ./up.sh
```

## Local Dev

### Start everything

```bash
./up.sh
```

This runs through 9 stages:
1. Checks prerequisites (Docker) — auto-installs Rust, Stellar CLI, Deno if missing
2. Starts a local Stellar network if not already running
3. Generates accounts (admin, provider, treasury) and funds them via Friendbot
4. Builds and deploys contracts (SAC, channel-auth, privacy-channel)
5. Starts PostgreSQL (Docker container on port 5442)
6. Starts provider-platform (generates `.env`, runs migrations, port 3010)
7. Builds and starts provider-console (port 3020)
8. Builds and starts council-console (port 3030)
9. Builds and starts network-dashboard (port 3040)

All configuration (`.env` files, `config.js` files) is generated automatically.

### Stop everything

```bash
./down.sh
```

### Run E2E tests (isolated)

```bash
./test.sh e2e           # Payment flow
./test.sh governance    # UC2 governance flows
./test.sh uc2           # Manual UC2 user flow
./test.sh all           # All three in parallel
```

Each run spins up its own Stellar node, PostgreSQL, provider, and council in Docker — fully isolated, no shared state, no dependency on `up.sh`. Uses your current local repo source code (mounted read-only). Set `BASE_DIR` if your repos aren't in `~/repos/`.

### Run E2E tests (against local stack)

If you prefer to test against the `up.sh` stack:

```bash
cd e2e && deno task e2e
```

Traces are exported to Jaeger automatically:

```bash
deno task verify-otel
open http://localhost:16686
```

## E2E in CI

See [e2e/README.md](e2e/README.md) for the Docker compose setup that runs E2E tests in CI without any host dependencies.

```bash
cd e2e && docker compose up --abort-on-container-exit
```

## Releases and Versioning

See [RELEASES.md](RELEASES.md) for the versioning strategy and release workflows across all modules.

## Troubleshooting

- **Friendbot timeout**: The local Stellar node can take a few minutes on first start. Re-run `./up.sh`, it will pick up where it left off.
- **Provider connection fails**: Check `provider.log` in this directory for errors.
- **Contract deployment fails**: Make sure the local Stellar container is running (`docker ps`).
- **No traces in Jaeger**: Check `jaeger.log` and ensure `OTEL_DENO=true` is set (automatic with `deno task e2e`).
