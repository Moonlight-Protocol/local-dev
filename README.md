# Local E2E Development Setup

Run the full Moonlight stack locally: Stellar network, smart contracts, privacy provider, and browser wallet.

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
├── local-e2e/            # This repo (setup scripts & docs)
├── browser-wallet/       # Wallet extension
├── soroban-core/         # Smart contracts (channel-auth, privacy-channel, token)
└── provider-platform/    # Privacy provider server
```

## Step 1: Start Local Stellar Network

```bash
stellar container start local
```

This starts a standalone Stellar node with RPC at `http://localhost:8000/soroban/rpc` and network passphrase `Standalone Network ; February 2017`.

## Step 2: Generate Accounts

```bash
# Admin account (deploys contracts, registers providers)
stellar keys generate admin --network local --fund

# Provider account (registered with quorum contract)
stellar keys generate provider --network local --fund

# Treasury / OpEx account (pays fees, creates UTXOs)
stellar keys generate treasury --network local --fund

# Wallet user account (for testing deposits/sends)
stellar keys generate user1 --network local --fund
```

Save keys for later:

```bash
stellar keys address admin      # Admin public key
stellar keys show admin         # Admin secret key

stellar keys address provider   # Provider public key
stellar keys show provider      # Provider secret key

stellar keys address treasury   # Treasury public key
stellar keys show treasury      # Treasury secret key
```

## Step 3: Build & Deploy Contracts

From the `soroban-core` repo:

```bash
cd ~/repos/soroban-core
stellar contract build
```

### 3a. Deploy Token Contract (test asset)

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/token.wasm \
  --network local \
  --source-account admin \
  -- \
  --admin admin \
  --decimal 7 \
  --name "Test XLM" \
  --symbol TXLM
```

Save the output contract ID as `TOKEN_ID`.

### 3b. Deploy Channel Auth Contract

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/channel_auth_contract.wasm \
  --network local \
  --source-account admin \
  -- \
  --admin admin
```

Save the output contract ID as `AUTH_ID`.

### 3c. Deploy Privacy Channel Contract

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/privacy_channel.wasm \
  --network local \
  --source-account admin \
  -- \
  --admin admin \
  --auth_contract $AUTH_ID \
  --asset $TOKEN_ID
```

Save the output contract ID as `CHANNEL_ID`.

### 3d. Register Provider with Quorum Contract

```bash
stellar contract invoke \
  --network local \
  --id $AUTH_ID \
  --source-account admin \
  -- \
  add_provider \
  --provider $(stellar keys address provider)
```

### 3e. Mint Test Tokens (optional)

If using a test token, mint some to the user account:

```bash
stellar contract invoke \
  --network local \
  --id $TOKEN_ID \
  --source-account admin \
  -- \
  mint \
  --to $(stellar keys address user1) \
  --amount 10000000000
```

## Step 4: Start Provider Platform

From the `provider-platform` repo:

```bash
cd ~/repos/provider-platform
```

### 4a. Start PostgreSQL

```bash
docker-compose up -d
```

### 4b. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with values from Step 2 and 3:

```env
PORT=3000
MODE=development
LOG_LEVEL=TRACE
SERVICE_DOMAIN=localhost

DATABASE_URL=postgresql://admin:devpass@localhost:5432/provider_platform_db

NETWORK=local
NETWORK_FEE=1000000000
CHANNEL_CONTRACT_ID=<CHANNEL_ID from step 3c>
CHANNEL_AUTH_ID=<AUTH_ID from step 3b>
CHANNEL_ASSET_CODE=TXLM

PROVIDER_SK=<output of: stellar keys show provider>
OPEX_PUBLIC=<output of: stellar keys address treasury>
OPEX_SECRET=<output of: stellar keys show treasury>

SERVICE_FEE=100
CHALLENGE_TTL=900
SESSION_TTL=21600
```

### 4c. Run Migrations & Start Server

```bash
deno task db:migrate
deno task serve
```

Server starts on `http://localhost:3000`.

## Step 5: Configure & Build Wallet

From the `browser-wallet` repo:

```bash
cd ~/repos/browser-wallet
```

Create `.env.seed`:

```env
SEED_PASSWORD=localdev
SEED_MNEMONIC=<12-word mnemonic for user1, or generate one>
SEED_NETWORK=custom
SEED_CHANNEL_CONTRACT_ID=<CHANNEL_ID from step 3c>
SEED_CHANNEL_NAME=Local Channel
SEED_ASSET_CODE=TXLM
SEED_ASSET_ISSUER=
SEED_PROVIDERS=Local Provider=http://localhost:3000
```

Build and load:

```bash
deno task build
```

Load `dist/` as unpacked extension in Chrome (`chrome://extensions`).

## Step 6: Verify

1. Extension auto-unlocks and shows the seeded wallet
2. Provider shows as connected (green dot)
3. Deposit some tokens via the Ramp tab
4. Send tokens to another wallet address

## Troubleshooting

- **"Custom network not supported"**: The wallet needs the `custom` network case added to `src/background/contexts/chain/network.ts` (see code changes below).
- **Provider connection fails**: Check that the provider-platform is running and the `NETWORK=local` case is added to its `src/config/network.ts`.
- **Contract deployment fails**: Ensure the local Stellar network is running (`stellar container start local`).
- **"Transaction simulation failed"**: The treasury account may need more XLM. Fund it again: `stellar keys fund treasury --network local`.

## Automated Setup

Instead of following the manual steps above, run:

```bash
cd ~/repos/local-e2e
./setup.sh
```

This handles steps 1-4 automatically and outputs `.env` files for both provider-platform and browser-wallet. Override repo paths with env vars or flags:

```bash
SOROBAN_CORE_PATH=~/repos/soroban-core \
PROVIDER_PLATFORM_PATH=~/repos/provider-platform \
WALLET_PATH=~/repos/browser-wallet \
./setup.sh
```
