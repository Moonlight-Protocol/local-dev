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

### Run E2E tests

```bash
./test.sh e2e           # Payment flow (deposit, send, receive, withdraw)
./test.sh otel          # Payment flow + OTEL trace verification
./test.sh governance    # UC2 governance flows (approve, reject, multi-PP)
./test.sh all           # All suites in parallel
```

Each run spins up its own Stellar node, PostgreSQL, provider, and council in Docker — fully isolated, no shared state, no dependency on `up.sh`. Uses your current local repo source code (mounted read-only). Set `BASE_DIR` if your repos aren't in `~/repos/`.

## E2E in CI

See [e2e/README.md](e2e/README.md) for the Docker compose setup that runs E2E tests in CI without any host dependencies.

```bash
cd e2e && docker compose up --abort-on-container-exit
```

## Debugging test failures with traces

Every test suite exports OTEL traces to Jaeger, and Jaeger persists them to disk at `.traces/<suite>/`. After a test run (pass or fail), you can inspect the traces by starting a Jaeger instance against the persisted data:

```bash
# Start Jaeger in read-only mode against a suite's traces
docker run --rm -d --name jaeger-inspect \
  -e SPAN_STORAGE_TYPE=badger \
  -e BADGER_EPHEMERAL=false \
  -e BADGER_DIRECTORY_KEY=/badger/keys \
  -e BADGER_DIRECTORY_VALUE=/badger/values \
  -v "$(pwd)/.traces/lifecycle:/badger" \
  -p 16687:16686 \
  jaegertracing/all-in-one:latest

# Open the UI
open http://localhost:16687

# When done
docker rm -f jaeger-inspect
```

Replace `lifecycle` with any suite name (`e2e`, `otel`, `governance`).

### What to look for

| Symptom | Where to look |
|---------|--------------|
| Bundle FAILED | Service: `provider-platform`, Operation: `Executor.submitTransactionToNetwork` — check `submission_failed` event for `error.message` |
| Auth fails | Service: `provider-platform`, Operation: `P_VerifyChallenge` — check signature verification events |
| Event watcher not firing | Service: `provider-platform`, Operation: `EventWatcher.poll` — check for `poll_error` events |
| Slow transactions | Service: `provider-platform`, compare `Executor.submitTransactionToNetwork` durations across bundles |
| Missing distributed traces | Service: `moonlight-e2e` — check that SDK spans have provider-platform children (CHILD_OF references) |

### Trace directory structure

```
.traces/
├── e2e/           # Payment flow traces
├── otel/          # Same as e2e (used for OTEL verification)
├── governance/    # UC2 governance flow traces
└── lifecycle/     # Full lifecycle traces (deploy → payment → remove)
```

Each directory contains Jaeger's badger storage (`keys/` and `values/`). Delete a directory to clear its traces. The `.traces/` directory is gitignored.

## Releases and Versioning

See [RELEASES.md](RELEASES.md) for the versioning strategy and release workflows across all modules.

## Troubleshooting

- **Friendbot timeout**: The local Stellar node can take a few minutes on first start. Re-run `./up.sh`, it will pick up where it left off.
- **Provider connection fails**: Check `provider.log` in this directory for errors.
- **Contract deployment fails**: Make sure the local Stellar container is running (`docker ps`).
- **No traces in Jaeger**: Check `jaeger.log` and ensure `OTEL_DENO=true` is set (automatic with `deno task e2e`).
