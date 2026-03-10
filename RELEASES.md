# Releases and Versioning

All modules use semver. Integration is validated by E2E tests, not by cross-referencing version numbers.

## Modules

| Module | Versioning | Published to | Release trigger |
|--------|-----------|--------------|-----------------|
| soroban-core | `Cargo.toml` workspace version | GitHub Releases (wasm artifacts) | `v*` tag push |
| moonlight-sdk | `deno.json` version | JSR (`@moonlight/moonlight-sdk`) | JSR publish |
| colibri | `deno.json` version | JSR (`@colibri/core`) | JSR publish |
| provider-platform | `deno.json` version | GHCR (Docker image) | `v*` tag push |
| stellar-cli | Dockerfile | GHCR (Docker image) | `stellar-cli-v*` tag push in local-dev |
| browser-wallet | `manifest.json` version | Chrome Web Store | Manual |

## Dependency chain

```
soroban-core (contracts)
    │
    ▼
moonlight-sdk (reads contract interface)
    │
    ├──► provider-platform
    │
    └──► browser-wallet
```

A contract interface change in soroban-core requires a matching moonlight-sdk update. Provider and wallet depend on the SDK, not directly on the contracts.

## How to release

### soroban-core

```bash
# 1. Update workspace version in Cargo.toml
# 2. Commit and tag
git tag v0.1.0
git push --tags
```

CI builds the contracts and attaches `channel_auth_contract.wasm` and `privacy_channel.wasm` to a GitHub release.

### provider-platform

```bash
# 1. Update version in deno.json
# 2. Commit and tag
git tag v0.2.0
git push --tags
```

CI builds the Docker image and pushes to `ghcr.io/moonlight-protocol/provider-platform:<version>`.

### stellar-cli image

Tagged in the local-dev repo:

```bash
git tag stellar-cli-v0.1.0
git push --tags
```

CI builds the Docker image and pushes to `ghcr.io/moonlight-protocol/stellar-cli:<version>`.

### moonlight-sdk / colibri

Published to JSR via `deno publish`. Version is set in `deno.json`.

## Running E2E tests in CI

The E2E workflow in local-dev can be triggered manually from the Actions tab. It accepts optional version inputs for each module:

- **contracts_version**: soroban-core release tag (default: latest)
- **provider_version**: provider-platform Docker image tag (default: latest)
- **stellar_cli_version**: stellar-cli Docker image tag (default: latest)

When all inputs are `latest`, the workflow tests the most recent release of every module together.

Pin specific versions to test a known-good combination or to bisect a regression:

```
contracts_version: v0.1.0
provider_version: 0.2.0
stellar_cli_version: 0.1.0
```

## Automation (planned)

Each module's release workflow will trigger the E2E workflow in local-dev via `repository_dispatch`, so that every release is automatically validated against the latest versions of all other modules.
