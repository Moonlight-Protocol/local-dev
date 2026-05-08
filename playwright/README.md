# Playwright UI E2E Tests

Full end-to-end Playwright tests that exercise the complete Moonlight user journey across all UIs — including real Freighter wallet interactions (signing popups, approvals) — with OTEL trace verification.

## What It Tests

A single sequential test walks through the full lifecycle across multiple browser contexts (each simulating a different user with their own Freighter wallet):

1. **Council user** signs in to council-console
2. **Council user** creates a council (metadata, deploy contracts, fund treasury, enable assets)
3. **Provider user** signs in to provider-console
4. **Provider user** creates a provider (metadata, fund account)
5. **Provider user** requests joining the council
6. **Council user** approves the join request (on-chain `add_provider`)
7. **Admin user** signs in to moonlight-pay admin
8. **Admin user** adds the council to moonlight-pay
9. **Merchant user** signs in to moonlight-pay
10. **Merchant user** creates an account (onboarding + treasury setup)
11. **POS user** navigates to merchant's POS URL
12. **POS user** sends an instant crypto payment
13. **Merchant user** verifies the received payment
14. **OTEL traces** verified in Jaeger (local) or Grafana Tempo (testnet/mainnet)

## Key Derivation

All 5 test users are derived from a single `MASTER_SECRET` using the same derivation as `local-dev/lib/master-seed.ts`:

| User | Role | Derives From |
|------|------|-------------|
| Council | `admin` | SHA-256(masterSeed \|\| "admin" \|\| "0") |
| Provider | `pp` | SHA-256(masterSeed \|\| "pp" \|\| "0") |
| Admin (Pay) | `pay-admin` | SHA-256(masterSeed \|\| "pay-admin" \|\| "0") |
| Merchant | `alice` | SHA-256(masterSeed \|\| "alice" \|\| "0") |
| POS Payer | `bob` | SHA-256(masterSeed \|\| "bob" \|\| "0") |

Default: the hardcoded `LOCAL_DEV_MASTER_SECRET` from `lib/master-seed.ts`. Same keys as `setup-keys.sh` generates.

## Prerequisites

- Node.js 18+
- Chromium (installed via Playwright)
- Freighter browser extension (unpacked)
- For local: the local-dev stack running (`down.sh` + `up.sh`)

## Setup

### 1. Install dependencies

```bash
cd playwright
npm install
npx playwright install chromium
```

### 2. Get the Freighter extension

Run the setup script from the local-dev root — it builds the extension from `stellar/freighter` at the pinned tag (matches CI byte-for-byte) and installs it at `playwright/freighter-extension/`:

```bash
cd /path/to/local-dev
./setup-freighter.sh
```

Idempotent. Delete `playwright/freighter-extension/` to refresh after a pin bump. Build runs inside a `node:20` container, so the only host requirement is Docker.

To use a different extension build, set `FREIGHTER_EXTENSION_PATH` to its absolute path before running playwright.

### 3. Start the local stack

```bash
cd /path/to/local-dev
./down.sh
./up.sh
```

Wait for all services to report ready. The Playwright test handles the full setup flow (council creation, PP registration, etc.) itself — you do **not** need to run `setup-c.sh` or `setup-pp.sh`.

### 4. Configure environment

```bash
cp .env.example .env
# Edit only if you changed local-dev ports or need testnet/mainnet
```

For local, the defaults work out of the box — no editing needed.

## Run

```bash
# Full test against local stack (default)
npx playwright test --project=chromium

# Headed mode (watch the browsers)
npx playwright test --project=chromium --headed

# Debug mode (step through)
npx playwright test --project=chromium --debug

# Against testnet
TARGET=testnet MASTER_SECRET=S... npx playwright test --project=chromium

# Against mainnet (use with caution — real funds!)
TARGET=mainnet MASTER_SECRET=S... npx playwright test --project=chromium
```

## Project Structure

```
playwright/
  playwright.config.ts          # Chromium config with Freighter extension
  .env.example                  # Environment variable template
  fixtures/
    freighter.ts                # Extension unlock, import, popup helpers
    auth.ts                     # SEP-53 login flows
    contexts.ts                 # Multi-user browser context factory
  tests/
    full-flow.spec.ts           # The 14-step sequential test
  helpers/
    keys.ts                     # Master seed key derivation (Node.js port)
    otel-verify.ts              # Jaeger/Tempo trace verification
    urls.ts                     # Local/testnet/mainnet URL resolution
```

## OTEL Verification

| Target | Backend | URL | Auth |
|--------|---------|-----|------|
| local | Jaeger | http://localhost:16686 | none |
| testnet | Grafana Tempo | env `TEMPO_URL` | env `TEMPO_AUTH` |
| mainnet | Grafana Tempo | env `TEMPO_URL` | env `TEMPO_AUTH` |

Locally, Jaeger is near-instant (5s wait). On testnet/mainnet, Tempo has ~60s ingestion lag.

## Freighter Selectors

Selectors target Freighter v5.x React UI. Each is documented in `fixtures/freighter.ts`:

- Password input: `input[type="password"]`
- Unlock: `button:has-text("Log In")`
- Approve/Confirm: `button:has-text("Confirm"), button:has-text("Approve")`
- Reject/Deny: `button:has-text("Reject"), button:has-text("Deny")`

## Wallet Popup Pattern

```typescript
import { withWalletApproval } from "../fixtures/freighter";

// Register popup listener BEFORE the click that triggers it
await withWalletApproval(context, page, async () => {
  await page.click("#button-that-opens-freighter");
});
```

## Idempotency

Each run uses timestamped names (e.g., "Council Playwright 1713600000").

## Mainnet Warning

Default target is `local`. Set `TARGET=mainnet` with caution.
