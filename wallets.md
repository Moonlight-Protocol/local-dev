# Wallets — Local Stellar Node Setup

How to connect browser wallets to the local Stellar node started by `up.sh`.

The local node runs a standalone Stellar network with:
- **RPC**: `http://localhost:8000/soroban/rpc`
- **Horizon**: `http://localhost:8000`
- **Friendbot**: `http://localhost:8000/friendbot`
- **Network passphrase**: `Standalone Network ; February 2017`

## Freighter

Freighter is the primary wallet used for local development with council-console and provider-console.

### Add the local network

1. Open Freighter → Settings (gear icon) → **Network Settings**
2. Click **Add Custom Network** and fill in:

| Field | Value |
|-------|-------|
| Name | Local |
| Horizon URL | `http://localhost:8000` |
| Soroban RPC URL | `http://localhost:8000/soroban/rpc` |
| Passphrase | `Standalone Network ; February 2017` |
| Friendbot URL | `http://localhost:8000/friendbot` |

3. Click **Save**
4. Switch to the **Local** network from the network dropdown

### Fund your account

Once on the Local network, Freighter shows your address. Fund it via Friendbot:

```bash
curl "http://localhost:8000/friendbot?addr=G...YOUR_ADDRESS..."
```

Or use the Stellar CLI:

```bash
stellar keys generate myaccount --network local
```

### Console configuration

The consoles already handle network selection automatically when started by `up.sh`:

- **council-console** receives `stellarNetwork: "standalone"` in its generated `config.js`, which sets the passphrase to `Standalone Network ; February 2017` and points RPC/Horizon/Friendbot at localhost.
- **provider-console** receives `apiBaseUrl` pointing at the local provider-platform. The wallet connects to whichever Stellar network Freighter is set to — make sure Freighter is on the Local network.

### Troubleshooting

- **"Network not allowed" error**: Freighter may reject signing if the transaction's network passphrase doesn't match the active network. Make sure Freighter is switched to the Local network before interacting with the consoles.
- **Transaction fails after node restart**: The local Stellar node is ephemeral — restarting it (`stellar container start local`) resets all state. You need to re-fund accounts and re-deploy contracts (`./up.sh` handles this).
- **Freighter not connecting**: Check that Freighter has permission to connect to `localhost`. Visit the console URL and click "Connect Wallet" — Freighter should prompt for approval.
- **Account not funded**: The local Friendbot has unlimited funds. Use the Friendbot URL above or run `./up.sh` which funds the admin, provider, and treasury accounts automatically.
