# Manual User E2E Tests

Simulated user flows that exercise the full API chain across multiple services. These are not automated CI tests — they simulate what a user would do through the UI, using keypair signing instead of wallet interactions.

## Prerequisites

Local dev stack running (`./up.sh` from the repo root) with a seeded council.

## Tests

### UC2: PP Joins a Council

Simulates the full UC2 flow:

1. PP operator authenticates with provider-platform
2. PP discovers a council by URL
3. PP submits a signed join request
4. Council admin authenticates with council-platform
5. Council admin approves the request
6. Council admin signs config and pushes it to the PP
7. PP membership becomes ACTIVE

```bash
deno task uc2
```

Reads `PROVIDER_SK` and `COUNCIL_SK` from the platform `.env` files automatically. Override with env vars or `BASE_DIR` if repos are not at `~/repos/`.
