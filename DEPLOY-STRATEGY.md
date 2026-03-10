# Deploy Strategy

## Modules Overview

| Module | CI/CD | Testnet Deploy | Version Source | Publish Target |
|--------|-------|----------------|---------------|----------------|
| soroban-core | Auto-tag + release (WASMs) | Local script | `Cargo.toml` | GitHub Releases |
| provider-platform | Auto-tag + release + testnet deploy | Automated (Fly.io after E2E) | `deno.json` | GHCR Docker image |
| browser-wallet | None | Manual | `manifest.json` | Chrome Web Store |
| moonlight-sdk | Auto-publish to JSR on version bump | N/A | `deno.json` | JSR (@moonlight/moonlight-sdk) |
| colibri | Auto-publish to JSR on version bump | N/A | `deno.json` | JSR (@colibri/core) |
| stellar-cli (local-dev) | Release on tag | N/A | Tag `stellar-cli-v*` | GHCR Docker image |

## Branch Strategy (Consistent Across Repos)

| Branch | Purpose |
|--------|---------|
| `main` | Release-ready. Auto-tagging triggers on version bumps. |
| `dev` | Integration branch. Feature branches merge here first. |
| `feat/`, `fix/`, `chore/` | Feature branches. Named per convention, include ClickUp ID when applicable. |

## Release Pipeline

```
feature branch → dev → main
                         ↓
                       auto-tag
                         ↓
                   ┌─────┴─────┐
                   │           │
             soroban-core  provider-platform
             (build WASMs)  (build Docker image)
                   │           │
                   └─────┬─────┘
                         ↓
                    E2E gate (Docker Compose)
                         ↓
              ┌──────────┴──────────┐
              │                     │
        provider-platform      contracts
        auto-deploy to Fly.io  manual deploy via local script
```

`main` → testnet is sufficient for current team size and pace. A `dev` → staging environment would add overhead without much value until there are parallel workstreams needing independent testing.

## Deploy by Module

### soroban-core (Contracts)

**CI**: Auto-tag on `Cargo.toml` version bump → build WASMs → GitHub Release → dispatch E2E.

**Testnet deploy**: Manual via `local-dev/deploy-testnet/deploy.sh`. Contract deployments are infrequent and stateful (deploy once, reference contract ID everywhere). Upgrading an existing contract vs deploying fresh have different flows that require human judgement — no CI automation.

**Why no automated deploy**: Contract IDs must propagate to provider-platform config (Fly.io secrets) and browser-wallet seed files. This is a coordination step that doesn't benefit from automation at current scale.

### provider-platform

**CI**: Auto-tag on `deno.json` version bump → Docker image to GHCR → dispatch E2E → deploy to Fly.io.

**Testnet deploy**: Automated via blue/green. After E2E passes, the release workflow runs `fly deploy`, which uses Fly.io's built-in blue/green strategy. Contract IDs and secrets are configured in Fly.io env vars — these change rarely and are set manually when contracts are redeployed.

**Blue/green deploy** (`fly.toml` sets `strategy = "bluegreen"`):

1. Fly.io starts new machines with the new image alongside the old ones
2. New machines run migrations (via entrypoint script) and start serving
3. Fly.io health-checks the new machines (hits `/api/v1/stellar/auth`)
4. If healthy: traffic cuts over to new machines, old machines stop
5. If unhealthy: new machines are stopped, old machines keep serving — zero downtime

This is a single app, single URL. No DNS changes, no second app, no wallet config changes. Rollback is automatic on health check failure, or manual via `fly deploy --image <previous-image>`.

**Requirements**:
- `min_machines_running = 1` — at least one machine must be running for blue/green to have something to fall back to (no auto-scale to zero)
- Health check configured in `fly.toml` under `[http_service.checks]`
- Database migrations must be backward-compatible — old and new machines coexist briefly during cutover

**Migration discipline** (required by blue/green):
- Adding columns/tables: safe
- Removing columns/tables: two-step deploy (stop using it first, remove next release)
- Renaming: two-step (add new name, migrate data, remove old name next release)

### browser-wallet

**No CI/CD**. Changes are infrequent. The wallet is built locally and loaded as an unpacked extension. Published to Chrome Web Store manually. The E2E suite already validates the wallet's SDK-level logic (deposit, send, receive, withdraw) without the extension itself.

### moonlight-sdk / colibri

**CI**: Auto-publish to JSR on version bump in `deno.json` when pushed to `main`. Both repos have `publish.yml` workflows that detect version changes and run `deno publish`. Colibri supports multi-package publishing across its workspace (`core`, `rpc-streamer`, `sep10`, plugins).

### stellar-cli image (local-dev)

Tagged in the local-dev repo. CI builds and pushes to GHCR on `stellar-cli-v*` tag push.

## Testnet

- **Provider platform**: Automated deploy via Fly.io after E2E gate.
- **Contracts**: Deployed via `local-dev/deploy-testnet/deploy.sh`. Generates an ephemeral admin account funded via Friendbot — no persistent keys needed.
- **Browser wallet**: Built locally with testnet seed files (`.env.seed`, `.env.seed.brave`), loaded manually into Chrome/Brave.

### Testnet Deploy Workflow (Contracts)

```bash
# 1. Validate prerequisites
./deploy-testnet/deploy.sh --dry-run <provider-public-key>

# 2. Deploy contracts
./deploy-testnet/deploy.sh <provider-public-key>

# 3. Update provider-platform Fly.io secrets (copy from deploy output)
cd ~/repos/provider-platform && fly secrets set CHANNEL_CONTRACT_ID=C... CHANNEL_AUTH_ID=C... CHANNEL_ASSET_CONTRACT_ID=C...

# 4. Verify deployment
./deploy-testnet/verify.sh <channel-id> <auth-id> <asset-id>
```

## Mainnet

Not on the horizon. No config, infrastructure, or automation exists. Revisit when the protocol is production-ready.

## Key Decisions

- **No staging environment.** `main` → testnet is the only deploy target. Revisit when team or workstreams grow.
- **E2E gate is mandatory.** Every release must pass cross-repo E2E before reaching testnet.
- **Contracts don't use CI for deploy.** Deploys are stateful and infrequent — a local script is the right tool.
- **Provider-platform uses CI for deploy.** Stateless server, Docker image, Fly.io — straightforward to automate.
- **Browser wallet has no CI.** Low change frequency doesn't justify it. The E2E tests validate the SDK path the wallet uses.


## Gaps

| Gap | Impact | Effort | Priority |
|-----|--------|--------|----------|
| Testnet provider deploy in CI | Currently manual `flyctl deploy` | Low — add step to provider-platform release.yml after E2E | High |

## CI Workflows Reference

| Repo | Workflow | Trigger | What It Does |
|------|----------|---------|-------------|
| soroban-core | `auto-tag.yml` | Push to `main` modifying `Cargo.toml` | Creates semver tag |
| soroban-core | `release.yml` | Tag push (`v*`) | Builds WASMs, publishes GitHub Release, dispatches E2E |
| provider-platform | `auto-tag.yml` | Push to `main` modifying `deno.json` | Creates semver tag |
| provider-platform | `release.yml` | Tag push (`v*`) | Builds Docker image, pushes to GHCR, dispatches E2E, deploys to Fly.io |
| local-dev | `e2e.yml` | Repository dispatch from soroban-core or provider-platform | Runs Docker Compose E2E with resolved versions |
| local-dev | `release-stellar-cli.yml` | Tag push (`stellar-cli-v*`) | Publishes stellar-cli Docker image to GHCR |
