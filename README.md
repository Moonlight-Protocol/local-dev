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

Override repo paths with environment variables:

```bash
SOROBAN_CORE_PATH=~/repos/soroban-core \
PROVIDER_PLATFORM_PATH=~/repos/provider-platform \
PROVIDER_CONSOLE_PATH=~/repos/provider-console \
COUNCIL_CONSOLE_PATH=~/repos/council-console \
NETWORK_DASHBOARD_PATH=~/repos/network-dashboard \
./up.sh
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

### Run E2E tests

```bash
cd e2e && deno task e2e
```

Runs the full E2E test (fund, auth, deposit, receive, send, withdraw) against the local stack. Traces are exported to Jaeger automatically.

```bash
# Verify traces were captured
deno task verify-otel

# Open Jaeger UI to inspect traces
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
