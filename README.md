# Local Dev

Run the full Moonlight stack locally: Stellar network, smart contracts, privacy provider, consoles, and dashboards.

## Prerequisites

| Tool | Install |
|------|---------|
| Docker | [docker.com](https://docs.docker.com/get-docker/) |

Stellar CLI and Deno are auto-installed by `up.sh` if missing.

## Repos

Clone all repos to `~/repos/`:

```
~/repos/
├── local-dev/              # This repo (setup scripts, E2E infrastructure)
├── provider-platform/      # Privacy provider server
├── provider-console/       # Provider dashboard
├── council-platform/       # Council backend
├── council-console/        # Council dashboard
└── network-dashboard/      # Network monitoring dashboard
```

If your repos live somewhere other than `~/repos/`, set `BASE_DIR`:

```bash
BASE_DIR=~/projects ./up.sh
```

You can also override individual repo paths:

```bash
PROVIDER_PLATFORM_PATH=~/other/provider-platform ./up.sh
```

## Infrastructure vs Application

`local-dev` cleanly separates **infrastructure** (long-lived services) from **application setup** (contracts, councils, PPs).

| Layer | Script | Owns | When to run |
|---|---|---|---|
| Infra | `./up.sh` | Stellar quickstart, PostgreSQL, Jaeger, the platform services with infra-only env, the consoles | Once per session, or after `down.sh` |
| App: Council | `./setup-c.sh` | Admin keypair, contract deploys (channel-auth, privacy-channel, XLM SAC), council registered via council-platform API | After `up.sh`, before any flow that needs a council |
| App: Privacy Provider | `./setup-pp.sh` | PP keypair, registered in provider-platform, joined to the council via the production join flow, on-chain `add_provider` | After `setup-c.sh`, before any flow that needs a working PP |

This split exists for three reasons:

1. **Infra restarts shouldn't silently rebuild app state.** Before this split, every `down`/`up` cycle quietly redeployed contracts and re-funded accounts as a side effect. Now `up.sh` is idempotent infra and the app state is explicit.
2. **The setup scripts exercise the production API surface.** `setup-c.sh` and `setup-pp.sh` make the same HTTP calls that council-console and provider-console make. If a platform release breaks the public surface, these scripts break too — that's the point. No DB seeding, no shortcuts.
3. **Skipping app setup is supported.** You can run `up.sh` alone if you only want to develop console UI or hit infra directly without a populated stack.

### Start the infra

```bash
./up.sh
```

This runs through 9 sections:
1. Checks prerequisites (Docker, Stellar CLI, Deno) and auto-installs missing ones
2. Starts Jaeger (OTLP on `:4318`, UI on `:16686`)
3. Starts the Stellar quickstart container (`:8000`) and waits for Friendbot
4. Starts PostgreSQL (`:5442`) and creates `provider_platform_db` + `council_platform_db`
5. Generates provider-platform `.env` (infra-only — no contract IDs, no PP keys), runs migrations, starts the service on `:3010`
6. Generates council-platform `.env` (infra-only — no `CHANNEL_AUTH_ID`, no `COUNCIL_SK`, no `OPEX_*`), runs migrations, starts the service on `:3015`
7. Generates `provider-console/public/config.js` and serves it on `:3020`
8. Generates `council-console/public/config.js` and serves it on `:3030`
9. Generates `network-dashboard/public/config.js` and serves it on `:3040`

After `up.sh` finishes the platform services are healthy and reachable, but the protocol state is empty: no contracts deployed, no councils, no PPs. Run the setup scripts to populate it.

### Set up a council

```bash
./setup-c.sh
```

Steps (all production-like — every API call is the one council-console makes):

1. Generate ephemeral admin keypair, fund via Friendbot
2. Deploy Channel Auth contract → councilId
3. Deploy native XLM SAC (Stellar Asset Contract)
4. Deploy Privacy Channel contract → channelContractId
5. Admin authenticates to council-platform via SEP-43/53 challenge → JWT
6. `PUT /council/metadata` to create the council
7. `POST /council/channels` to add the XLM channel
8. Write admin SK + contract IDs to `.local-dev-state` (gitignored) for `setup-pp.sh` and other followups to consume

### Set up a Privacy Provider

```bash
./setup-pp.sh
```

Requires `setup-c.sh` to have run first. Steps (also production-like):

1. Load admin SK + council ID from `.local-dev-state`
2. Generate fresh PP operator keypair, fund via Friendbot
3. PP operator authenticates to provider-platform dashboard → JWT
4. `POST /dashboard/pp/register` to register the PP
5. Sign a join envelope, `POST /dashboard/council/join` (provider-platform forwards to council-platform)
6. Admin authenticates to council-platform → JWT
7. List join requests, find ours, `POST /council/provider-requests/:id/approve`
8. Admin calls `add_provider` on-chain against the channel-auth contract
9. Poll provider-platform until the membership flips ACTIVE (event watcher sees `provider_added`)
10. Append PP keys to `.local-dev-state`

Each `setup-pp.sh` run registers a fresh PP. Re-running adds a second PP to the same council (multi-PP). To reset: `down.sh` → `up.sh` → `setup-c.sh` → `setup-pp.sh`.

### Stop everything

```bash
./down.sh
```

Tears down all containers, kills all services, and removes generated files (`.env`, `*.log`, `.local-dev-state`). After this you're back to a clean machine. Re-running `up.sh` gives you a fresh Stellar ledger and empty databases — you'll need to re-run the setup scripts to repopulate the application state.

### Run E2E tests

```bash
./test.sh e2e                  # Payment flow (deposit, send, receive, withdraw)
./test.sh otel                 # Payment flow + OTEL trace verification
./test.sh governance           # UC2 governance flows (approve, reject, multi-PP)
./test.sh lifecycle            # Full lifecycle (deploy → payment → remove)
./test.sh pos-instant          # UC4 POS crypto instant payment (temp P256 hop)
./test.sh pos-self-custodial   # UC4 POS self-custodial payment (password-derived keys)
./test.sh all                  # All suites in parallel
```

Each run spins up its own Stellar node, PostgreSQL, provider, council, and (for POS suites) pay-platform in Docker — fully isolated, no shared state, no dependency on `up.sh`. Uses your current local repo source code (mounted read-only). Set `BASE_DIR` if your repos aren't in `~/repos/`.

Each suite has its own Docker Compose file (`docker-compose.<suite>.yml`), its own setup script, and its own test runner. No conditional branching — every suite is fully explicit about what it needs.

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
├── e2e/                  # Payment flow traces
├── otel/                 # Same as e2e (used for OTEL verification)
├── governance/           # UC2 governance flow traces
├── lifecycle/            # Full lifecycle traces (deploy → payment → remove)
├── pos-instant/          # POS crypto instant payment traces
└── pos-self-custodial/   # POS self-custodial payment traces
```

Each directory contains Jaeger's badger storage (`keys/` and `values/`). Delete a directory to clear its traces. The `.traces/` directory is gitignored.

## Releases and Versioning

See [RELEASES.md](RELEASES.md) for the versioning strategy and release workflows across all modules.

## Troubleshooting

- **Friendbot timeout**: The local Stellar node can take a few minutes on first start. Re-run `./up.sh`, it will pick up where it left off.
- **Provider connection fails**: Check `provider.log` in this directory for errors.
- **Contract deployment fails**: Make sure the local Stellar container is running (`docker ps`).
- **No traces in Jaeger**: Check `jaeger.log` and ensure `OTEL_DENO=true` is set (automatic with `deno task e2e`).
