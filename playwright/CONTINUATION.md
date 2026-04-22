# Playwright Full-Flow Test — Continuation Prompt

## Context

The full-flow Playwright test at `/tmp/pw-local-dev/playwright/tests/full-flow.spec.ts` exercises the complete Moonlight Protocol user journey across all UIs (council-console, provider-console, moonlight-pay) with real Freighter wallet interactions and OTEL trace verification. All 14 steps currently pass against the local-dev stack (~5.7 min).

The test was built iteratively — fixes were applied to get it passing, but some of those fixes are band-aids or architectural workarounds. This document captures what needs to be cleaned up, improved, or removed.

The local-dev e2e tests (`./test.sh all` in `/Users/theahaco/repos/local-dev/`) all pass — nothing was broken.

## Files

- **Test**: `/tmp/pw-local-dev/playwright/tests/full-flow.spec.ts`
- **Auth fixtures**: `/tmp/pw-local-dev/playwright/fixtures/auth.ts`
- **Freighter fixtures**: `/tmp/pw-local-dev/playwright/fixtures/freighter.ts`
- **Context factory**: `/tmp/pw-local-dev/playwright/fixtures/contexts.ts`
- **Key derivation**: `/tmp/pw-local-dev/playwright/helpers/keys.ts`
- **URL config**: `/tmp/pw-local-dev/playwright/helpers/urls.ts`
- **OTEL verification**: `/tmp/pw-local-dev/playwright/helpers/otel-verify.ts`

## Fixes applied — status after review with user

### 1. Step 5 — Removed `withWalletApproval` from join-council
**Status: Correct. No change needed.**
Join-council in provider-console uses local signing with the PP's derived keypair. No Freighter popup is produced.

### 2. Step 8 — Added `?council=${councilId}` to discover URL
**Status: Correct. No change needed.**
Pay-platform backend extracts the `council` query param and passes it as `?councilId=` to the council-platform API.

### 3. Step 8 — Added PP registration via admin UI after council creation
**Status: Architectural workaround. Needs removal.**
Pay-platform should NOT track privacy providers. Its role is jurisdiction gating only — does this payer/merchant jurisdiction pair have a valid council route? PP selection happens at bundle time from on-chain routes (in→out), not from a `council_pps` table. The `council_pps` table, the PP check in `prepareInstantHandler` (returns 503 "No privacy provider available"), and the admin PP management UI are all candidates for removal in pay-platform. Once that's done, remove the PP registration code from Step 8 (lines 453-487 currently).

### 4. Step 9 — Added `.first()` in `verifyAuthenticated`
**Status: FIXED.**
Removed `.first()` from `verifyAuthenticated` in `auth.ts`. Changed the Step 9 selector from `"nav, .onboarding-stepper, .login-card"` to `".nav-address, .onboarding-stepper"`. These are mutually exclusive views (home page vs onboarding route), so only one is ever in the DOM. `.nav-address` is the navbar truncated public key (rendered by `renderNav()` in `page()` wrapper). The onboarding layout (`onboardingPage()`) doesn't render nav, so `.onboarding-stepper` covers new merchants.

### 5. Step 10 — Rewrote with `waitForSelector` + conditional handling
**Status: `waitForSelector` part is correct. Returning-merchant branching is dead code.**
The `waitForSelector` replacing `isVisible()` is the right fix — `isVisible` returns immediately without waiting. The returning-merchant conditional logic (lines 510-516: `alreadyHome` check) is dead code because `beforeAll` truncates `pay_accounts`, so the merchant is always new. Consider removing the dead branch for clarity, or keep it for robustness if the truncate is removed later (CI Docker Compose won't need it).

### 6. Step 12 — Added Stellar Wallets Kit modal interaction
**Status: Correct. No change needed.**
`#pay-instant-btn` opens the `<stellar-wallets-modal>` wallet picker, not Freighter directly. Must click "Freighter" inside the modal first.

### 7. Step 12 — Popup2 `.catch(() => null)` with timeout
**Status: FIXED (reduced to 5s). Further improvement possible.**
Reduced timeout from 15s to 5s. Connection popup appears within 1-2s if it's coming. 5s is more than enough while keeping the dead-wait acceptable. A further improvement would be to check Freighter's connection state before clicking (e.g. `window.freighter.getPublicKey()`) to know upfront whether to expect 1 or 2 popups — but 5s works reliably.

### 8. beforeAll — `TRUNCATE councils CASCADE; TRUNCATE pay_accounts CASCADE`
**Status: Correct for local dev. Will be unnecessary in CI.**
The test runs against the live local-dev stack (up.sh), not in Docker isolation. Deterministic keys cause data accumulation across runs. The truncate ensures a clean slate. When this test moves to Docker Compose CI, each run gets a fresh DB and the truncate can be removed. For local dev, `down + up` already provides a fresh slate, so this is a convenience for iterating without full restarts.

### 9. Step 10 — Jurisdiction `selectOption({ label: "United States" })`
**Status: FIXED.**
Changed to `selectOption({ value: "US" })`. The `<option>` elements use ISO 3166-1 alpha-2 country codes as values (confirmed in `moonlight-pay/src/views/onboarding/account.ts` and `lib/jurisdictions.ts`).

## Remaining work

1. **Item 3 (PP removal)**: Requires pay-platform code changes — remove `council_pps` table, the PP check in `prepareInstantHandler`, and the admin PP management UI. Then remove the PP registration code from Step 8. This is an architectural change, not a test fix.
2. Run `cd /Users/theahaco/repos/local-dev && ./test.sh all` before any push to verify e2e suites still pass
3. This test is planned to become a CI test running in Docker Compose (like the existing test.sh suites)

## Important rules

- Never branch/commit on local repos — always work in /tmp
- Never make product/flow/architecture decisions without asking the user first
- Never claim "fixed" until rebuilt, restarted, and verified end-to-end
- Run full CI test suite locally before pushing or opening PRs
