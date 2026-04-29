# Recording rig

Tooling for recording end-to-end demo videos against testnet (or any other
non-local stack). Each "run" is a self-contained set of keys and seeds derived
deterministically from a master secret so a recording can be re-run or debugged
without state from prior runs leaking in.

## Quickstart

```bash
# From local-dev/ — run from this directory's parent.
./recording/setup-recording-keys.sh

# Outputs land in recording/runs/<run-id>/:
#   keys.txt           Human-readable summary (commit-ignored)
#   run.env            Sourced by Playwright recording scripts
#   .env.seed.user1    Browser-wallet vault seed for Alice
#   .env.seed.user2    Browser-wallet vault seed for Bob
```

`setup-recording-keys.sh` probes the council, provider, and dashboard URLs
before doing any work and aborts on the first unreachable endpoint. This catches
the `:3110`-style trap where a parallel-stack `.env` (e.g. `PROVIDER_PORT=3110`)
leaks into the shell and silently overrides the default `PROVIDER_PLATFORM_URL`.
If the probe fails, run `env | grep -E '_URL$|_PORT$'` to see what's overriding.

## Recording the demo

After `setup-recording-keys.sh` succeeds, drive the actual videos via the
Playwright project under `recording/playwright/`:

```bash
cd recording/playwright
./build-wallet.sh                 # build browser-wallet w/o seed injection
RUN_ID=<id> npm run record        # all sections in order
```

See [`playwright/README.md`](./playwright/README.md) for the full section list,
run order, and per-section video output paths.

## How keys are derived

All identities derive from a single Stellar secret seed (`MASTER_SECRET`,
defaults to the local-dev master in `lib/master-seed.ts`). The run id —
typically an ISO timestamp — namespaces every key, so two recordings on the same
testnet never collide:

```
admin   = SHA-256(masterSeed ‖ "recording-admin" ‖ runId)  → Stellar keypair
pp      = SHA-256(masterSeed ‖ "recording-pp"    ‖ runId)  → Stellar keypair
alice   = SHA-256(masterSeed ‖ "mnemonic:recording-alice" ‖ runId)[:16]
                                                            → BIP39 mnemonic
bob     = SHA-256(masterSeed ‖ "mnemonic:recording-bob"   ‖ runId)[:16]
                                                            → BIP39 mnemonic
```

Wallet primary accounts are derived from each mnemonic using the same SLIP-0010
path (`m/44'/148'/0'`) the browser-wallet uses.

## Roles

| Role  | Purpose                                                       |
| ----- | ------------------------------------------------------------- |
| admin | Council admin — drives council-console, signs onboarding txns |
| pp    | Provider operator — drives provider-console, owns the PP key  |
| alice | Browser-wallet user 1 — deposits, sends                       |
| bob   | Browser-wallet user 2 — receives                              |

All four primary Stellar accounts are funded via Friendbot before the run
starts.

## Env overrides

| Var                     | Default                                             |
| ----------------------- | --------------------------------------------------- |
| `MASTER_SECRET`         | `LOCAL_DEV_MASTER_SECRET` (in `lib/master-seed.ts`) |
| `RUN_ID`                | ISO-8601 timestamp (UTC, dashes for safety)         |
| `FRIENDBOT_URL`         | `https://friendbot.stellar.org`                     |
| `OUTPUT_DIR`            | `recording/runs/<RUN_ID>`                           |
| `COUNCIL_CONSOLE_URL`   | `https://moonlight-beta-council-console.fly.dev`    |
| `COUNCIL_PLATFORM_URL`  | `https://moonlight-beta-council-platform.fly.dev`   |
| `DASHBOARD_URL`         | `https://dashboard-testnet.moonlightprotocol.io`    |
| `PROVIDER_PLATFORM_URL` | `https://moonlight-beta-privacy-provider-a.fly.dev` |

`COUNCIL_CONSOLE_URL` is the council-console UI (where Section 01 admin
onboards); `COUNCIL_PLATFORM_URL` is the council-platform API
(`/api/v1/public/...`) — the dashboard fetches its council list from there. For
local-dev: `COUNCIL_CONSOLE_URL=http://localhost:3030`,
`COUNCIL_PLATFORM_URL=http://localhost:3015`.

## Output layout

```
local-dev/
└── recording/
    ├── README.md                  (this file)
    ├── recording-keys.ts          (derivation lib)
    ├── setup-recording-keys.ts    (entry script)
    ├── setup-recording-keys.sh    (bash wrapper)
    └── runs/                      (gitignored)
        └── <run-id>/
            ├── keys.txt
            ├── run.env
            ├── .env.seed.user1
            └── .env.seed.user2
```

`keys.txt` is the debug record — keep it accessible during a recording in case a
step fails and you need to re-derive a key by hand.

`run.env` has sentinel comments (`# CHANNEL_AUTH_ID=`, `# PRIVACY_CHANNEL_ID=`)
that the Section 1 (council onboarding) Playwright script populates after the
council and channel are deployed. Subsequent sections source `run.env` and pick
up those values.
