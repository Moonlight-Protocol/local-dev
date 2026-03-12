# Local Dev

Run the full Moonlight stack locally: Stellar network, smart contracts, privacy provider, and browser wallet extensions.

## Prerequisites

| Tool | Install |
|------|---------|
| Docker | [docker.com](https://docs.docker.com/get-docker/) |
| Rust/Cargo | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Stellar CLI | `cargo install --locked stellar-cli --features opt` |
| Deno | `curl -fsSL https://deno.land/install.sh \| sh` |

## Repos

```
~/repos/
├── local-dev/              # This repo (setup scripts, E2E infrastructure)
├── browser-wallet/         # Chrome extension
├── soroban-core/           # Smart contracts (channel-auth, privacy-channel)
├── moonlight-sdk/          # Privacy SDK (JSR: @moonlight/moonlight-sdk)
├── colibri/                # Soroban contract toolkit (JSR: @colibri/core)
└── provider-platform/      # Privacy provider server
```

Override repo paths with environment variables:

```bash
SOROBAN_CORE_PATH=~/repos/soroban-core \
PROVIDER_PLATFORM_PATH=~/repos/provider-platform \
WALLET_PATH=~/repos/browser-wallet \
./up.sh
```

## Local Dev

### Start everything

```bash
./up.sh
```

This runs through 8 stages:
1. Checks prerequisites (Docker, Stellar CLI, Deno, Cargo)
2. Starts Jaeger for distributed tracing (UI at http://localhost:16686)
3. Starts a local Stellar network via Docker
4. Generates accounts (admin, provider, treasury) and funds them via Friendbot
5. Builds and deploys contracts (channel-auth, privacy-channel)
6. Registers the provider on the channel-auth contract
7. Starts the provider platform (PostgreSQL, migrations, server)
8. Builds wallet extensions for Chrome and Brave with dev seeds

After it finishes, load `browser-wallet/dist/chrome/` or `dist/brave/` as unpacked extensions.

### Stop everything

```bash
./down.sh
```

### Rebuild wallet extensions

```bash
./rebuild.sh
```

Rebuilds the Chrome and Brave wallet extensions without restarting the network or provider.

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
