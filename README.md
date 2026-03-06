# Local Dev

Run the full Moonlight stack locally: Stellar network, smart contracts, privacy provider, and browser wallet extensions.

## Prerequisites

| Tool | Install |
|------|---------|
| Docker | [docker.com](https://docs.docker.com/get-docker/) |
| Rust/Cargo | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Stellar CLI | `cargo install --locked stellar-cli --features opt` |
| Deno | `curl -fsSL https://deno.land/install.sh \| sh` |

## Directory Layout

```
~/repos/
├── local-dev/              # This repo (setup scripts)
├── browser-wallet/         # Chrome extension
├── soroban-core/           # Smart contracts (channel-auth, privacy-channel, token)
└── provider-platform/      # Privacy provider server
```

Override repo paths with environment variables:

```bash
SOROBAN_CORE_PATH=~/repos/soroban-core \
PROVIDER_PLATFORM_PATH=~/repos/provider-platform \
WALLET_PATH=~/repos/browser-wallet \
./up.sh
```

## Usage

### Start everything

```bash
./up.sh
```

This runs through 7 stages:
1. Checks prerequisites (Docker, Stellar CLI, Deno, Cargo)
2. Starts a local Stellar network via Docker
3. Generates accounts (admin, provider, treasury) and funds them via Friendbot
4. Builds and deploys contracts (token, channel-auth, privacy-channel)
5. Registers the provider and mints test tokens
6. Starts the provider platform (PostgreSQL, migrations, server)
7. Builds wallet extensions for Chrome and Brave with dev seeds

After it finishes, load `browser-wallet/dist/chrome/` or `dist/brave/` as unpacked extensions.

### Stop everything

```bash
./down.sh
```

Stops the provider platform and the local Stellar Docker container.

### Rebuild wallet extensions

```bash
./rebuild.sh
```

Rebuilds the Chrome and Brave wallet extensions without restarting the network or provider.

## Verify it works

1. Open the wallet extension, it auto-unlocks with the seeded password
2. Provider shows as connected (green dot)
3. Deposit tokens via the Ramp tab
4. Send tokens to the other wallet (copy the MLXDR address from the Brave wallet)
5. Withdraw tokens back to a Stellar account

## Troubleshooting

- **Friendbot timeout**: The local Stellar node can take a few minutes on first start. Re-run `./up.sh`, it will pick up where it left off.
- **Provider connection fails**: Check `provider.log` in this directory for errors.
- **"Transaction simulation failed"**: The wallet account may need tokens. The setup script mints 1000 TXLM to each wallet, but if you're using a different mnemonic you'll need to mint manually.
- **Contract deployment fails**: Make sure the local Stellar container is running (`docker ps`).
