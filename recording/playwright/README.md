# Recording rig — Playwright specs

Per-section silent video recordings for the Tranche 2 demo. Each spec produces a
`.webm` under `recording/runs/<RUN_ID>/videos/<section>/`. Audio + subtitles are
added in post.

This is **separate** from `local-dev/playwright/` (the verification test suite).
Specs here favour deliberate pacing and a single linear flow per section over
fast assertions.

## Recording flow

A single recording run goes through these phases, in order:

1. **Setup** — `setup-recording-keys.sh` derives a fresh deterministic identity
   set (admin / pp / alice / bob), funds the four primary Stellar accounts via
   Friendbot, probes the platform URLs, and writes
   `runs/<RUN_ID>/{keys.txt, run.env, .env.seed.user1, .env.seed.user2}`.
2. **Build wallet** — `playwright/build-wallet.sh` builds the browser-wallet
   without seed injection so the full UI onboarding flow records.
3. **Specs run in order** — each spec is a separate Playwright invocation that
   loads `run.env` for shared state. Sections 01 and 02 backfill the contract
   IDs that 03a/b/c and 04 consume.
4. **Outputs** — videos land under
   `runs/<RUN_ID>/videos/<spec-name>/<test-id>.webm`. Each section is its own
   file; cut + dub in post.

## Sections

Run order matters: 01 → 02 → 03a → 03b → 03c → 04.

| #   | Spec                                      | What records                                                          | Wallet                                                               | Reads from run.env                                   | Writes to run.env                   |
| --- | ----------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------- |
| 01  | `01-council-onboard.spec.ts`              | council-console: create council, deploy contracts, fund               | Freighter                                                            | ADMIN_*, COUNCIL_CONSOLE_URL                         | CHANNEL_AUTH_ID, PRIVACY_CHANNEL_ID |
| 02  | `02-provider-create-join-approve.spec.ts` | provider-console + council-console approval                           | Freighter                                                            | `PP_*`, `ADMIN_*`, CHANNEL_AUTH_ID                   | —                                   |
| 03a | `03a-alice-deposit-send.spec.ts`          | browser-wallet: onboard, add channel, connect provider, deposit, send | browser-wallet                                                       | ALICE_*, PRIVACY_CHANNEL_ID, PROVIDER_PLATFORM_URL   | bob-mlxdr.txt artifact              |
| 03b | `03b-bob-receive.spec.ts`                 | browser-wallet: onboard, receive view (captures MLXDR)                | browser-wallet                                                       | BOB_*, PRIVACY_CHANNEL_ID, PROVIDER_PLATFORM_URL     | bob-mlxdr.txt artifact              |
| 03c | `03c-alice-withdraw.spec.ts`              | browser-wallet: withdraw                                              | browser-wallet                                                       | ALICE_*, PRIVACY_CHANNEL_ID                          | —                                   |
| 04  | `04-dashboard-tour.spec.ts`               | dashboard: council list, channel detail, provider, activity           | none (uses launchPersistentContext to keep recording rig consistent) | DASHBOARD_URL, COUNCIL_PLATFORM_URL, CHANNEL_AUTH_ID | —                                   |

`run.env` (under `recording/runs/<RUN_ID>/`) is the single shared-state
mechanism between specs:

- `setup-recording-keys.sh` writes the keys + URLs.
- Section 01 backfills `CHANNEL_AUTH_ID` and `PRIVACY_CHANNEL_ID`.
- Sections 02-04 read those values.

Multi-line blobs (e.g. Bob's receive MLXDR) are persisted as
`runs/<RUN_ID>/<name>.txt` artifacts via `writeRunArtifact`/`readRunArtifact` so
they don't pollute `run.env`.

## Setup

```bash
# 1. Generate a fresh recording run (keys + funded testnet accounts).
cd local-dev
./recording/setup-recording-keys.sh
# → recording/runs/<RUN_ID>/{keys.txt, run.env, .env.seed.user1, .env.seed.user2}

# 2. Build browser-wallet WITHOUT seed injection so the full UI flow records.
cd recording/playwright
./build-wallet.sh
# → ~/repos/browser-wallet/dist (loaded by playwright.config.ts)

# 3. Install Playwright deps.
npm install
npm run install:browsers
```

## Recording

```bash
# All sections, in order
RUN_ID=<id> npm run record

# One section
RUN_ID=<id> npx playwright test specs/03a-alice-deposit-send.spec.ts
```

Videos land under:

```
local-dev/recording/runs/<RUN_ID>/
├── run.env
├── keys.txt
├── .env.seed.user{1,2}
├── bob-mlxdr.txt           (only after 03b)
└── videos/
    ├── 01-council-onboard.spec.ts/<test-id>.webm
    ├── 02-provider-create-join-approve.spec.ts/<test-id>.webm
    ├── 03a-alice-deposit-send.spec.ts/<test-id>.webm
    ├── 03b-bob-receive.spec.ts/<test-id>.webm
    ├── 03c-alice-withdraw.spec.ts/<test-id>.webm
    └── 04-dashboard-tour.spec.ts/<test-id>.webm
```

## Capturing sections 01 & 02

Sections 01 (council onboarding) and 02 (provider create/join/approve) use
Freighter and run through `createUserContext()` from
`local-dev/playwright/fixtures/contexts.ts` (the verification suite). That
helper manages its own browser context outside this rig's
`playwright.config.ts`, so Playwright's `video: "on"` setting does **not** apply
— these specs run successfully but emit no `.webm` for the Freighter beats.

Sections 03a / 03b / 03c / 04 use the recording rig's own fixtures and do
produce `.webm` files.

To capture the full six-section run end-to-end, screen-record the display while
`npm run record` executes. The rig already runs non-headless (`headless: false`
in `playwright.config.ts`), so every window is visible.

```bash
# In one terminal — start your screen recorder (QuickTime "New Screen
# Recording", OBS, or `ffmpeg -f avfoundation -i 1 demo.mov`).
# Then in another:
RUN_ID=<id> npm run record
```

Tips:

- Capture the **full display**, not a single window. The rig opens multiple
  Chromium contexts (admin, pp, alice, bob) as separate windows; window-only
  capture will miss handoffs.
- Each context renders at the configured viewport (default 1280x720).
- Total runtime is ~7 minutes for all six specs.
- Cursor + window chrome appear in the screen recording. The Playwright `.webm`
  outputs (03a–04) intentionally do not, so use whichever source is right for
  the section.

## Tunables

| Var                        | Default                                | Effect                                          |
| -------------------------- | -------------------------------------- | ----------------------------------------------- |
| `RUN_ID`                   | (required)                             | Names the run dir under `recording/runs/`       |
| `RECORDING_RUN_DIR`        | derived from `RUN_ID`                  | Override the run dir entirely                   |
| `RECORDING_BEAT_MS`        | `600`                                  | Base unit for `beat()` / `hold()` pacing        |
| `RECORDING_FAST_TYPE=1`    | unset                                  | Skip per-character typing (use `.fill()`)       |
| `VIDEO_WIDTH/HEIGHT`       | `1280x720`                             | Recording resolution                            |
| `VIDEO_SLOWMO`             | unset                                  | ms slowMo on every Playwright action            |
| `BROWSER_WALLET_PATH`      | `../../../browser-wallet/dist`         | Override unpacked extension dir                 |
| `FREIGHTER_EXTENSION_PATH` | `../../playwright/freighter-extension` | Reuse the existing Freighter unpacked extension |

## Pacing helpers

`fixtures/pacing.ts` exposes the deliberate-pause primitives. The recording rig
leans on these instead of bare `waitForTimeout`s so the viewer's eye can track
each step:

| Helper                   | Pause                              | When to use                                                    |
| ------------------------ | ---------------------------------- | -------------------------------------------------------------- |
| `beat(page)`             | `BEAT` (default 600ms)             | Punctuate a step transition                                    |
| `hold(page)`             | `BEAT * 3`                         | Let a result render before moving on                           |
| `holdAfterSuccess(page)` | fixed 2000ms                       | After the UI shows a success indicator — gives the viewer time |
| `clickWithPause(loc)`    | scroll → beat → click → beat       | Replace bare `.click()` for any visually important button      |
| `typeSlowly(loc, txt)`   | per-character delay (default 35ms) | Replace bare `.fill()` so the viewer can read the input        |

Each flow in `fixtures/browser-wallet.ts` (`createPrivacyChannel`,
`addAndConnectProvider`, `deposit`, `send`, `withdraw`, `showReceive`) ends by
waiting on a UI success indicator (channel pill, green provider dot, action
buttons re-enabled, MLXDR card visible) and then calling `holdAfterSuccess` so
the demo doesn't snap to the next step.

## Status

End-to-end validation runs against the local stack with all six specs passing
(`01`, `02`, `03a`, `03b`, `03c`, `04`). Section 04's tour beats
(scroll-to-council, drill-in, provider list, bundle activity) are still TODO.
