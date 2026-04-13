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
| provider-console | Auto-tag on version bump | Automated (Tigris bucket) | `deno.json` | Tigris static files |
| council-console | Auto-tag on version bump | Automated (Tigris bucket) | `deno.json` | Tigris static files |

## Branch Strategy

Trunk-based development. PRs merge to the primary branch (`main` for all repos).

| Branch | Purpose |
|--------|---------|
| `main` | Primary branch. PRs merge here. Auto-tagging triggers on version bumps. |
| `feat/`, `fix/`, `chore/` | Feature branches. Named per convention, include ClickUp ID when applicable. |

## Versioning and Releases

**Version bumps are deliberate.** Not every PR is a release. The flow:

1. Merge features and fixes freely — no version bump, nothing releases
2. When ready to release, bump the version in a PR (either standalone or bundled with the last fix)
3. Merge → auto-tag creates a git tag → release pipeline fires

This gives full control over release timing without extra tooling. No release-please or similar automation needed — the auto-tag workflow already watches the version file and only acts on changes.

### Cross-Repo Changes

When changes span multiple repos (e.g., new contract fields + matching provider-platform update), intermediate E2E failures are expected and harmless:

1. First repo releases → E2E runs with new artifact + old artifact from other repo → **fails**
2. Second repo releases → E2E runs with both new artifacts → **passes** → deploy

The E2E workflow always resolves non-triggering modules to `latest` (most recent release). The last repo to release triggers the passing run. **Order does not matter.**

Failed intermediate releases exist as GitHub artifacts but never reach testnet — the E2E gate blocks deployment.

## Release Pipeline

```
feature PR → primary branch (no version bump = no release)
                    │
            version bump PR → primary branch
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
              uses latest from each repo
                    ↓
         ┌──────────┴──────────┐
         │                     │
   provider-platform      contracts
   auto-deploy to Fly.io  manual deploy via local script
```

`main` → testnet is sufficient for current team size and pace. A staging environment would add overhead without much value until there are parallel workstreams needing independent testing.

## Deploy by Module

### soroban-core (Contracts)

**Release pipeline (4 steps):**

**Step 1: Version bump merges to main.** A PR bumps version in the root `Cargo.toml` (workspace version). This is the only trigger — feature PRs without a version bump don't release anything.

**Step 2: Auto-tag (`auto-tag.yml`).** Triggers on push to main when `Cargo.toml` changes. It:
1. Reads the version from `Cargo.toml` (e.g. `0.1.0`)
2. Checks if tag `v0.1.0` already exists
3. If not, creates and pushes the tag

Uses `E2E_TRIGGER_TOKEN` (PAT) with `persist-credentials: true` so the tag push triggers downstream workflows (tags pushed by `GITHUB_TOKEN` don't trigger `on: push: tags`).

**Step 3: Release (`release.yml`).** Triggers on tag push matching `v*`. It:
1. Installs Rust with `wasm32v1-none` target
2. Installs `stellar-cli`
3. Runs `stellar contract build` which compiles both channel-auth and privacy-channel to WASM
4. Copies `channel_auth_contract.wasm` and `privacy_channel.wasm` to artifacts
5. Creates a GitHub Release with auto-generated release notes and the two WASMs attached
6. Dispatches a `module-release` event to the `local-dev` repo to trigger E2E tests

**Step 4: E2E gate.** The `local-dev` repo receives the dispatch, runs the cross-repo E2E with the new WASMs + latest provider-platform. If E2E passes, the release is validated. If it fails, the release exists but testnet deploy doesn't happen (provider-platform's deploy is gated on E2E).

**Key design points:**
- Release is deliberate — merging features doesn't release, only version bumps do
- WASMs are built from the tagged commit, so the release always matches the tag
- The PAT is needed at two points: auto-tag (to trigger `release.yml`) and release (to dispatch E2E to `local-dev`)
- Contract deployment to testnet is still manual (`local-dev/deploy-testnet/deploy.sh`) because contract IDs need to propagate to provider-platform and wallet configs

**Testnet deploy**: Manual via `local-dev/deploy-testnet/deploy.sh`. Contract deployments are infrequent and stateful (deploy once, reference contract ID everywhere). Upgrading an existing contract vs deploying fresh have different flows that require human judgement — no CI automation.

**Why no automated deploy**: Contract IDs must propagate to provider-platform config (Fly.io secrets) and browser-wallet seed files. This is a coordination step that doesn't benefit from automation at current scale.

### provider-platform

**Release pipeline:**

**Step 1: Version bump merges to main.** A PR bumps version in `deno.json`. Feature PRs without a version bump don't release.

**Step 2: Auto-tag (`auto-tag.yml`).** Triggers on push to `main` when `deno.json` changes. Same pattern as soroban-core — reads version, checks if tag exists, creates if not. Uses `E2E_TRIGGER_TOKEN` PAT.

**Step 3: Release (`release.yml`).** Triggers on tag push matching `v*`. It:
1. Builds Docker image
2. Tags with semver (`{{version}}` strips `v` prefix — e.g. tag `v0.5.0` → image `0.5.0`), plus `latest`
3. Pushes to GHCR
4. Creates GitHub Release with auto-generated notes
5. Dispatches `module-release` event to `local-dev` with the image version (without `v` prefix, matching the Docker tag)

**Step 4: E2E gate + deploy.** Same as soroban-core — `local-dev` runs cross-repo E2E. If it passes, provider-platform auto-deploys to Fly.io.

**Important**: The dispatch version must match the Docker image tag (no `v` prefix). The metadata-action's `outputs.version` is used for this.

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

### provider-console

**Release pipeline:**

**Step 1: Version bump merges to main.** A PR bumps version in `deno.json`. Feature PRs without a version bump don't release.

**Step 2: Auto-tag (`auto-version.yml`).** Triggers on push to main when `deno.json` changes. It:
1. Reads the version from `deno.json` (e.g. `0.2.0`)
2. Checks if tag `v0.2.0` already exists
3. If not, creates and pushes the tag

Uses `AUTO_VERSION_TOKEN` (PAT) with `persist-credentials: true` so the tag push bypasses branch protection.

**Step 3: Deploy (`deploy.yml`).** Triggers on tag push matching `v*`. It:
1. Generates production `config.js` from GitHub secrets (`API_BASE_URL`, `POSTHOG_PROJECT_TOKEN`, Grafana config)
2. Builds production bundle with esbuild (`deno task build -- --production` — minified, no sourcemaps)
3. Uploads static files to a public Tigris bucket via `aws s3 sync`

**Hosting**: Static files served directly from Tigris (S3-compatible object storage on Fly.io). No server required.
- **Bucket**: `provider-console`
- **URL**: `https://provider-testnet.moonlightprotocol.io` (Tigris bucket: `provider-console`)
- **Secrets**: `TIGRIS_ACCESS_KEY_ID`, `TIGRIS_SECRET_ACCESS_KEY`, `API_BASE_URL`, `POSTHOG_PROJECT_TOKEN`

**Tests**: `test.yml` runs `deno task test` on every PR to main. Tests must pass before merge.

### council-console

Same pattern as provider-console.

**Release pipeline:**

**Step 1: Version bump merges to main.** A PR bumps version in `deno.json`.

**Step 2: Auto-tag (`auto-version.yml`).** Same as provider-console — reads version from `deno.json`, creates tag if it doesn't exist. Uses `AUTO_VERSION_TOKEN` PAT.

**Step 3: Deploy (`deploy.yml`).** Triggers on tag push matching `v*`. Same build + Tigris upload pattern.

**Hosting**: Static files on Tigris.
- **Bucket**: `moonlight-council-console`
- **URL**: `https://council-testnet.moonlightprotocol.io` (Tigris bucket: `moonlight-council-console`)
- **Secrets**: `TIGRIS_ACCESS_KEY_ID`, `TIGRIS_SECRET_ACCESS_KEY`, `POSTHOG_PROJECT_TOKEN`, `GRAFANA_OTLP_ENDPOINT`, `GRAFANA_OTLP_AUTH`

**Tests**: `ci.yml` runs tests on every PR to main.

### stellar-cli image (local-dev)

Tagged in the local-dev repo. CI builds and pushes to GHCR on `stellar-cli-v*` tag push.

## Testnet

- **Provider platform**: Automated deploy via Fly.io after E2E gate.
- **Contracts**: Deployed via `local-dev/deploy-testnet/deploy.sh`. Generates an ephemeral admin account funded via Friendbot — no persistent keys needed.
- **Browser wallet**: Built locally with testnet seed files (`.env.seed`, `.env.seed.brave`), loaded manually into Chrome/Brave.
- **Provider console**: Auto-deployed to Tigris bucket on version bump. Config generated from GitHub secrets at build time.
- **Council console**: Auto-deployed to Tigris bucket on version bump. Same pattern as provider console.

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

- **Trunk-based development.** PRs merge to the primary branch. No long-lived integration branches.
- **Deliberate version bumps.** Merging a PR does not release. Bumping the version in the version file triggers the release pipeline.
- **Cross-repo failures are expected.** When coupled changes span repos, intermediate E2E failures are noise. The last release triggers the passing run.
- **No staging environment.** `main` → testnet is the only deploy target. Revisit when team or workstreams grow.
- **E2E gate is mandatory.** Every release must pass cross-repo E2E before reaching testnet.
- **Contracts don't use CI for deploy.** Deploys are stateful and infrequent — a local script is the right tool.
- **Provider-platform uses CI for deploy.** Stateless server, Docker image, Fly.io — straightforward to automate.
- **Browser wallet has no CI.** Low change frequency doesn't justify it. The E2E tests validate the SDK path the wallet uses.
- **Console apps use Tigris for hosting.** Static files deployed to public S3-compatible buckets — no server needed.

## CI Workflows Reference

| Repo | Workflow | Trigger | What It Does |
|------|----------|---------|-------------|
| soroban-core | `auto-tag.yml` | Push to `main` modifying `Cargo.toml` | Creates semver tag |
| soroban-core | `release.yml` | Tag push (`v*`) | Builds WASMs, publishes GitHub Release, dispatches E2E |
| provider-platform | `auto-tag.yml` | Push to `main` modifying `deno.json` | Creates semver tag |
| provider-platform | `release.yml` | Tag push (`v*`) | Builds Docker image, pushes to GHCR, dispatches E2E, deploys to Fly.io |
| provider-platform | `deploy-testnet.yml` | Push to `main` | Auto-deploys to Fly.io (testnet) via blue/green |
| local-dev | `e2e.yml` | Repository dispatch from soroban-core or provider-platform | Runs Docker Compose E2E with resolved versions |
| local-dev | `release-stellar-cli.yml` | Tag push (`stellar-cli-v*`) | Publishes stellar-cli Docker image to GHCR |
| provider-console | `auto-version.yml` | Push to `main` modifying `deno.json` | Creates semver tag |
| provider-console | `deploy.yml` | Tag push (`v*`) | Builds production bundle, deploys to Tigris bucket |
| provider-console | `test.yml` | Pull request to `main` | Runs `deno task test` |
| council-console | `auto-version.yml` | Push to `main` modifying `deno.json` | Creates semver tag |
| council-console | `deploy.yml` | Tag push (`v*`) | Builds production bundle, deploys to Tigris bucket |
| council-console | `ci.yml` | Pull request to `main` | Runs tests |
