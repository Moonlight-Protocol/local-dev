/**
 * Full UC flow: Playwright E2E test with Freighter wallet + OTEL verification.
 *
 * Exercises the complete user journey across all Moonlight UIs:
 *   1.  Council user signs in to council-console
 *   2.  Council user creates "Council Playwright <ts>"
 *   3.  Provider user signs in to provider-console
 *   4.  Provider user creates "Provider Playwright <ts>"
 *   5.  Provider user requests joining the council
 *   6.  Council user approves join request
 *   7.  Admin user signs in to moonlight-pay/admin
 *   8.  Admin user adds council to moonlight-pay
 *   9.  Merchant user signs in to moonlight-pay
 *   10. Merchant user creates an account
 *   11. POS user navigates to merchant's POS URL
 *   12. POS user sends instant payment
 *   13. Merchant user verifies received payment
 *   14. OTEL trace verification (Jaeger locally, Tempo on testnet/mainnet)
 *
 * All user keys are derived from a single MASTER_SECRET (or the hardcoded
 * local-dev default). See helpers/keys.ts for the derivation.
 */
import { expect, type Page, test } from "@playwright/test";
import { execSync } from "child_process";
import { getTarget, getUrls, type ServiceUrls } from "../helpers/urls";
import { deriveAllProfiles, type DerivedProfiles } from "../helpers/keys";
import {
  closeAllContexts,
  createUserContext,
  type UserContext,
} from "../fixtures/contexts";
import {
  loginMoonlightPay,
  loginWithFreighter,
  verifyAuthenticated,
} from "../fixtures/auth";
import {
  approveNextPopup,
  SEL_APPROVE_BUTTON,
  withWalletApproval,
} from "../fixtures/freighter";
import {
  buildOtelConfig,
  checkOtelConnectivity,
  formatOtelResults,
  verifyOtelTraces,
} from "../helpers/otel-verify";

// ─── Config ─────────────────────────────────────────────────────────

const TIMESTAMP = Date.now();
const COUNCIL_NAME = `Council Playwright ${TIMESTAMP}`;
const PROVIDER_NAME = `Provider Playwright ${TIMESTAMP}`;

const urls: ServiceUrls = getUrls();
const profiles: DerivedProfiles = deriveAllProfiles(
  process.env.MASTER_SECRET || undefined,
);

// OTEL service names (match OTEL_SERVICE_NAME in infra-up.sh)
const OTEL_SERVICES = [
  process.env.PROVIDER_SERVICE_NAME ?? "provider-platform",
  process.env.COUNCIL_SERVICE_NAME ?? "council-platform",
  process.env.PAY_SERVICE_NAME ?? "pay-platform",
];

// ─── State shared across steps ──────────────────────────────────────

let councilCtx: UserContext;
let providerCtx: UserContext;
let adminCtx: UserContext;
let merchantCtx: UserContext;
let posCtx: UserContext;

let councilPage: Page;
let providerPage: Page;
let councilId: string; // channel auth contract ID from council creation
let adminPage: Page;
let merchantPage: Page;
let posPage: Page;

let posUrl: string;
let testStartEpochS: number;

// ─── Test ───────────────────────────────────────────────────────────

test.describe("Full UC Flow", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    testStartEpochS = Math.floor(Date.now() / 1000);

    // Clean up stale pay-platform data from previous test runs.
    // Deterministic keys mean old accounts/councils accumulate and
    // interfere with council selection (first council without a PP gets
    // picked instead of the newly created one).
    if (getTarget() === "local") {
      try {
        execSync(
          `PGPASSWORD=devpass psql -h localhost -p 5442 -U admin -d pay_platform_db -c "TRUNCATE councils CASCADE; TRUNCATE pay_accounts CASCADE;"`,
          { stdio: "pipe" },
        );
        console.log("Cleaned up stale pay-platform data");
      } catch {
        console.log("DB cleanup skipped (psql not available)");
      }
    }

    console.log(`\nTarget: ${getTarget()}`);
    console.log(`Council Console: ${urls.councilConsole}`);
    console.log(`Provider Console: ${urls.providerConsole}`);
    console.log(`Moonlight Pay: ${urls.moonlightPay}`);
    console.log(`Council user: ${profiles.council.publicKey}`);
    console.log(`Provider user: ${profiles.provider.publicKey}`);
    console.log(`Admin user: ${profiles.admin.publicKey}`);
    console.log(`Merchant user: ${profiles.merchant.publicKey}`);
    console.log(`POS user: ${profiles.pos.publicKey}\n`);

    // Create user contexts — each launches its own persistent Chromium
    // process with Freighter loaded into a unique user data directory
    councilCtx = await createUserContext(null, {
      name: profiles.council.name,
      publicKey: profiles.council.publicKey,
      secretKey: profiles.council.secretKey,
    });
    providerCtx = await createUserContext(null, {
      name: profiles.provider.name,
      publicKey: profiles.provider.publicKey,
      secretKey: profiles.provider.secretKey,
    });
    adminCtx = await createUserContext(null, {
      name: profiles.admin.name,
      publicKey: profiles.admin.publicKey,
      secretKey: profiles.admin.secretKey,
    });
    merchantCtx = await createUserContext(null, {
      name: profiles.merchant.name,
      publicKey: profiles.merchant.publicKey,
      secretKey: profiles.merchant.secretKey,
    });
    posCtx = await createUserContext(null, {
      name: profiles.pos.name,
      publicKey: profiles.pos.publicKey,
      secretKey: profiles.pos.secretKey,
    });
  });

  test.afterAll(async () => {
    await closeAllContexts({
      council: councilCtx,
      provider: providerCtx,
      admin: adminCtx,
      merchant: merchantCtx,
      pos: posCtx,
    });
  });

  // ── Step 1: Council user signs in ─────────────────────────────────

  test("Step 1: Council user signs in to council-console", async () => {
    councilPage = await councilCtx.context.newPage();
    await councilPage.goto(urls.councilConsole);
    await councilPage.waitForLoadState("networkidle");

    // council-console login: #connect-btn → Freighter popup → #signin-btn → Freighter popup
    await loginWithFreighter(councilCtx.context, councilPage);

    // Verify: nav appears (authenticated)
    await verifyAuthenticated(councilPage, "nav", 30_000);
  });

  // ── Step 2: Council user creates council ──────────────────────────

  test("Step 2: Council user creates council", async () => {
    // Click create council button on the empty-state page
    const createBtn = councilPage.locator("#create-btn, #new-council-btn");
    await createBtn.first().click();

    // Step 2a: Metadata
    await councilPage.waitForSelector("#council-name", { timeout: 10_000 });
    await councilPage.fill("#council-name", COUNCIL_NAME);
    await councilPage.fill(
      "#council-description",
      `Playwright test council created at ${new Date().toISOString()}`,
    );
    await councilPage.fill("#council-email", "playwright@moonlight.test");

    // Select a jurisdiction (open picker, type, click first match)
    const jurisdictionPicker = councilPage.locator("#jurisdiction-picker");
    if (
      await jurisdictionPicker.isVisible({ timeout: 3_000 }).catch(() => false)
    ) {
      await councilPage.fill("#jurisdiction-filter", "United States");
      await councilPage.waitForTimeout(500);
      const jurisdictionOption = councilPage.locator(
        "#jurisdiction-list .jurisdiction-option, .jurisdiction-option",
      ).first();
      if (
        await jurisdictionOption.isVisible({ timeout: 2_000 }).catch(() =>
          false
        )
      ) {
        await jurisdictionOption.click();
      }
    }

    await councilPage.click("#next-btn");

    // Step 2b: Create (deploy contracts) — signing popups.
    // 4 guaranteed signTransaction calls + 1 conditional (XLM SAC deployment
    // via ensureSacDeployed on a fresh network where the SAC doesn't exist yet).
    // Use an event-based handler to approve all Freighter popups dynamically.
    await councilPage.waitForSelector("#create-btn", { timeout: 10_000 });

    let popupsApproved = 0;
    let popupError: Error | null = null;
    const approvePopup = async (popup: Page) => {
      try {
        popupsApproved++;
        await popup.waitForLoadState("domcontentloaded");
        await popup.waitForTimeout(1500);
        await popup.waitForSelector(
          'button:has-text("Confirm"), button:has-text("Approve"), button:has-text("Sign")',
          { timeout: 15_000 },
        );
        await popup.locator(
          'button:has-text("Confirm"), button:has-text("Approve"), button:has-text("Sign")',
        ).first().click();
      } catch (e) {
        popupError = e as Error;
      }
    };

    councilCtx.context.on("page", approvePopup);
    await councilPage.click("#create-btn");

    // Wait for all signing popups to resolve and fund page to appear.
    // Contract deployment + submission on local can take 30-60s per tx.
    await councilPage.waitForSelector("#fund-amount", { timeout: 180_000 });
    councilCtx.context.off("page", approvePopup);
    console.log(`Council creation: ${popupsApproved} signing popups approved`);
    if (popupError) throw popupError;

    // Step 2c: Fund Treasury
    await councilPage.fill("#fund-amount", "10");

    await withWalletApproval(councilCtx.context, councilPage, async () => {
      await councilPage.click("#fund-btn");
    });

    // Wait for fund tx to complete and Next to become enabled
    await councilPage.waitForSelector("#next-btn:not([disabled])", {
      timeout: 60_000,
    });
    await councilPage.click("#next-btn");

    // Step 2d: Assets — XLM already enabled, click continue
    await councilPage.waitForSelector("#continue-btn, #next-btn", {
      timeout: 10_000,
    });
    await councilPage.locator("#continue-btn, #next-btn").first().click();

    // Step 2e: Invite — capture invite link + council ID, click Done
    await councilPage.waitForSelector("#done-btn", { timeout: 10_000 });
    const inviteLink = await councilPage
      .locator("#invite-link")
      .inputValue()
      .catch(() => "");

    // Extract council ID from invite link (format: ...?council=C... or from sessionStorage)
    const idMatch = inviteLink.match(/[?&#]council=([A-Z0-9]+)/);
    if (idMatch) {
      councilId = idMatch[1];
    } else {
      // Fallback: read from sessionStorage
      councilId = await councilPage.evaluate(
        () => sessionStorage.getItem("onboarding_council_id") ?? "",
      );
    }
    console.log(`Council ID: ${councilId}`);

    await councilPage.click("#done-btn");

    // Verify: council appears in dashboard
    await councilPage.waitForLoadState("networkidle");
    await expect(councilPage.locator(`text=${COUNCIL_NAME}`)).toBeVisible({
      timeout: 15_000,
    });

    test.info().annotations.push({
      type: "invite-link",
      description: inviteLink,
    });
  });

  // ── Step 3: Provider user signs in ────────────────────────────────

  test("Step 3: Provider user signs in to provider-console", async () => {
    providerPage = await providerCtx.context.newPage();
    await providerPage.goto(urls.providerConsole);
    await providerPage.waitForLoadState("networkidle");

    await loginWithFreighter(providerCtx.context, providerPage);
    await verifyAuthenticated(providerPage, "nav", 30_000);
  });

  // ── Step 4: Provider user creates provider ────────────────────────

  test("Step 4: Provider user creates provider", async () => {
    const createBtn = providerPage.locator(
      "#create-pp-btn, button:has-text('Create')",
    );
    await createBtn.first().click();

    // Metadata
    await providerPage.waitForSelector("#pp-name", { timeout: 10_000 });
    await providerPage.fill("#pp-name", PROVIDER_NAME);
    await providerPage.fill("#pp-email", "playwright-pp@moonlight.test");
    await providerPage.click("#next-btn");

    // Fund Account — wallet sends XLM to the PP's derived address
    await providerPage.waitForSelector("#fund-amount", { timeout: 15_000 });
    await providerPage.fill("#fund-amount", "10");

    await withWalletApproval(providerCtx.context, providerPage, async () => {
      await providerPage.click("#fund-btn");
    });

    await providerPage.waitForSelector("#next-btn:not([disabled])", {
      timeout: 60_000,
    });

    // Next registers the PP via API (no wallet popup), then auto-navigates to /setup/join
    await providerPage.click("#next-btn");
    await providerPage.waitForLoadState("networkidle");
  });

  // ── Step 5: Provider requests joining council ─────────────────────

  test("Step 5: Provider requests joining council", async () => {
    // After Step 4, we should be on /setup/join. If not, navigate there.
    const councilUrlInput = providerPage.locator("#council-url, #jc-url");
    const onJoinStep = await councilUrlInput.first().isVisible({
      timeout: 5_000,
    }).catch(() => false);

    if (!onJoinStep) {
      // Maybe we're on /home — use the join council modal
      await providerPage.goto(`${urls.providerConsole}/#/home`);
      await providerPage.waitForLoadState("networkidle");

      const joinModalBtn = providerPage.locator(".join-council-btn").first();
      if (await joinModalBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await joinModalBtn.click();
        await providerPage.waitForTimeout(1000);
      }
    }

    // Fill council platform URL with council ID (required for discover)
    const urlInput = providerPage.locator("#council-url, #jc-url").first();
    await urlInput.waitFor({ state: "visible", timeout: 10_000 });
    await urlInput.fill(`${urls.councilApi}?council=${councilId}`);

    // Discover
    const discoverBtn = providerPage.locator("#discover-btn, #jc-discover-btn")
      .first();
    await discoverBtn.click();

    await providerPage.waitForSelector("#council-info, #jc-info, #jc-confirm", {
      state: "visible",
      timeout: 15_000,
    });

    // Request to join — local signing + API call (no wallet popup)
    const joinBtn = providerPage.locator("#join-btn, #jc-join-btn").first();
    await joinBtn.waitFor({ state: "visible", timeout: 10_000 });
    await joinBtn.click();

    // After successful join, setup view navigates to /home
    await providerPage.waitForLoadState("networkidle");
    await providerPage.waitForTimeout(2000);

    // Verify: should be on /home with PENDING status
    if (!providerPage.url().includes("/home")) {
      await providerPage.goto(`${urls.providerConsole}/#/home`);
      await providerPage.waitForLoadState("networkidle");
    }
    await expect(
      providerPage.locator(".badge-pending, .check-status-btn").first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  // ── Step 6: Council user approves join request ────────────────────

  test("Step 6: Council user approves join request", async () => {
    await councilPage.goto(urls.councilConsole);
    await councilPage.waitForLoadState("networkidle");

    // Click on the council to go to detail view
    await councilPage.locator(`text=${COUNCIL_NAME}`).first().click();
    await councilPage.waitForLoadState("networkidle");

    // Find the Requested provider row
    const requestedRow = councilPage.locator(
      '.provider-row[data-status="Requested"]',
    );
    await expect(requestedRow.first()).toBeVisible({ timeout: 15_000 });

    // Hover to trigger action popup
    await requestedRow.first().hover();

    const approveBtn = councilPage.locator(".popup-approve");
    await approveBtn.waitFor({ state: "visible", timeout: 5_000 });

    // Approve — wallet-signed add_provider transaction
    await withWalletApproval(councilCtx.context, councilPage, async () => {
      await approveBtn.click();
    });

    // Wait for status to change to Active/Approved
    await expect(
      councilPage
        .locator(
          '.provider-row[data-status="Active"], .provider-row[data-status="Approved"]',
        )
        .first(),
    ).toBeVisible({ timeout: 120_000 });
  });

  // ── Step 7: Admin signs in to moonlight-pay ───────────────────────

  test("Step 7: Admin signs in to moonlight-pay/admin", async () => {
    adminPage = await adminCtx.context.newPage();
    await adminPage.goto(`${urls.moonlightPay}/#/login`);
    await adminPage.waitForLoadState("networkidle");

    await loginMoonlightPay(adminCtx.context, adminPage);

    await adminPage.goto(`${urls.moonlightPay}/#/admin`);
    await adminPage.waitForLoadState("networkidle");
    await verifyAuthenticated(adminPage, "#admin-content", 30_000);
  });

  // ── Step 8: Admin adds council to moonlight-pay ───────────────────

  test("Step 8: Admin adds council to moonlight-pay", async () => {
    await adminPage.click("#add-council-btn");

    await adminPage.waitForSelector("#cf-url", { timeout: 10_000 });
    await adminPage.fill("#cf-url", `${urls.councilApi}?council=${councilId}`);

    await adminPage.click("#cf-fetch");

    await adminPage.waitForSelector("#cf-preview", {
      state: "visible",
      timeout: 15_000,
    });

    await adminPage.click("#cf-confirm");

    await adminPage.waitForLoadState("networkidle");
    await expect(
      adminPage.locator("#council-list [data-id]").first(),
    ).toBeVisible({ timeout: 15_000 });

    // Navigate into the council detail view to add a privacy provider
    await adminPage.locator("#council-list [data-id]").first().click();
    await adminPage.waitForSelector("#add-pp-btn", { timeout: 10_000 });

    // Add a privacy provider so instant payments can route
    await adminPage.click("#add-pp-btn");
    await adminPage.waitForSelector("#pp-name", { timeout: 5_000 });
    await adminPage.fill("#pp-name", PROVIDER_NAME);
    await adminPage.fill("#pp-url", urls.providerApi);
    await adminPage.fill("#pp-pk", profiles.provider.publicKey);
    await adminPage.click("#pp-save");

    // Verify PP appears in the list
    await expect(
      adminPage.locator("#pp-list .stat-card").first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  // ── Step 9: Merchant signs in to moonlight-pay ────────────────────

  test("Step 9: Merchant signs in to moonlight-pay", async () => {
    merchantPage = await merchantCtx.context.newPage();
    await merchantPage.goto(`${urls.moonlightPay}/#/login`);
    await merchantPage.waitForLoadState("networkidle");

    await loginMoonlightPay(merchantCtx.context, merchantPage);

    await merchantPage.waitForLoadState("networkidle");
    await verifyAuthenticated(
      merchantPage,
      ".nav-address, .onboarding-stepper",
      30_000,
    );
  });

  // ── Step 10: Merchant creates an account ──────────────────────────

  test("Step 10: Merchant creates an account", async () => {
    // Check if already on home page (returning merchant from previous test run)
    const alreadyHome = await merchantPage
      .locator("#pos-link, #pos-link-section")
      .first()
      .isVisible()
      .catch(() => false);

    if (!alreadyHome) {
      // Account step
      const onAccountStep = await merchantPage
        .locator("#signup-email")
        .isVisible()
        .catch(() => false);

      if (onAccountStep) {
        await merchantPage.fill(
          "#signup-email",
          `merchant-${TIMESTAMP}@moonlight.test`,
        );

        const jurisdictionSelect = merchantPage.locator("#signup-jurisdiction");
        if (await jurisdictionSelect.isVisible()) {
          // Must match the council's jurisdiction (US)
          await jurisdictionSelect.selectOption({ value: "US" });
        }

        const displayName = merchantPage.locator("#signup-display-name");
        if (await displayName.isVisible()) {
          await displayName.fill(`Merchant Playwright ${TIMESTAMP}`);
        }

        await merchantPage.click("#signup-btn");
        await merchantPage.waitForLoadState("networkidle");
      }

      // Treasury step — wait for keypair derivation to finish
      const onTreasuryStep = await merchantPage
        .waitForSelector("#opex-content, #pos-link", {
          state: "visible",
          timeout: 30_000,
        })
        .then((el) => el.evaluate((e) => e.id === "opex-content"))
        .catch(() => false);

      if (onTreasuryStep) {
        // Fund the treasury
        await merchantPage.waitForSelector("#opex-fund-card", {
          state: "visible",
          timeout: 10_000,
        });
        await merchantPage.fill("#opex-fund-amount", "100");

        await withWalletApproval(
          merchantCtx.context,
          merchantPage,
          async () => {
            await merchantPage.click("#opex-fund-btn");
          },
        );

        // Wait for balance to update after funding
        await merchantPage.waitForTimeout(5000);

        // Set fee
        const feeInput = merchantPage.locator("#opex-fee");
        if (await feeInput.isVisible()) {
          await feeInput.fill("1");
        }

        // Complete setup — button becomes enabled once treasury has balance > 0
        await merchantPage.waitForSelector(
          "#opex-complete-btn:not([disabled])",
          {
            timeout: 60_000,
          },
        );
        await merchantPage.click("#opex-complete-btn");
        await merchantPage.waitForLoadState("networkidle");
      }
    }

    // Home page — extract POS link
    await merchantPage.waitForSelector("#pos-link, #pos-link-section", {
      timeout: 30_000,
    });

    const posLinkEl = merchantPage.locator("#pos-link");
    posUrl = (await posLinkEl.textContent()) ?? "";
    expect(posUrl).toBeTruthy();

    if (!posUrl.startsWith("http")) {
      posUrl = `${urls.moonlightPay}/#/pay/${posUrl}`;
    }
  });

  // ── Step 11: POS user navigates to merchant's POS URL ─────────────

  test("Step 11: POS user navigates to POS URL", async () => {
    posPage = await posCtx.context.newPage();

    const separator = posUrl.includes("?") ? "&" : "?";
    const posUrlWithAmount =
      `${posUrl}${separator}amount=1&description=Playwright+test+payment`;

    await posPage.goto(posUrlWithAmount);
    await posPage.waitForLoadState("networkidle");

    await expect(
      posPage.locator(".pos-card, .pos-container").first(),
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      posPage.locator(".pos-amount, #pos-amount-input").first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  // ── Step 12: POS user sends instant payment ───────────────────────

  test("Step 12: POS user sends instant payment", async () => {
    const instantBtn = posPage.locator("#pay-instant-btn");
    await expect(instantBtn).toBeVisible({ timeout: 10_000 });

    const amountInput = posPage.locator("#pos-amount-input");
    if (await amountInput.isVisible().catch(() => false)) {
      await amountInput.fill("1");
    }

    // Click instant payment — opens wallet picker modal first
    await instantBtn.click();
    await posPage.waitForTimeout(1000);

    // Register popup listener BEFORE clicking Freighter in the wallet picker
    const popup1Promise = posCtx.context.waitForEvent("page", {
      timeout: 30_000,
    });

    // Click Freighter in the Stellar Wallets Kit modal (may be in shadow DOM)
    const freighterOption = posPage.locator("text=Freighter").first();
    if (
      await freighterOption.isVisible({ timeout: 3_000 }).catch(() => false)
    ) {
      await freighterOption.click();
    } else {
      await posPage.evaluate(() => {
        const modal = document.querySelector("stellar-wallets-modal");
        if (modal?.shadowRoot) {
          const btn =
            modal.shadowRoot.querySelector("[data-wallet-id]") as HTMLElement ??
              modal.shadowRoot.querySelector("button") as HTMLElement;
          btn?.click();
        }
      });
    }

    // Handle popup 1 (connection approval OR transaction signing)
    const popup1 = await popup1Promise;
    await popup1.waitForLoadState("domcontentloaded");
    await popup1.waitForTimeout(1500);

    // Register for popup 2 BEFORE confirming popup 1.
    // If Freighter is already connected (persistent context from previous run),
    // popup 1 IS the signing popup and no popup 2 will come — handle both cases.
    const popup2Promise = posCtx.context
      .waitForEvent("page", { timeout: 5_000 })
      .catch(() => null);

    await popup1.waitForSelector(SEL_APPROVE_BUTTON, { timeout: 10_000 });
    await popup1.click(SEL_APPROVE_BUTTON);

    // Handle popup 2 (transaction signing) — only if it appears
    const popup2 = await popup2Promise;
    if (popup2) {
      await popup2.waitForLoadState("domcontentloaded");
      await popup2.waitForTimeout(1500);
      await popup2.waitForSelector(SEL_APPROVE_BUTTON, { timeout: 10_000 });
      await popup2.click(SEL_APPROVE_BUTTON);
      await popup2.waitForEvent("close", { timeout: 10_000 }).catch(() => {});
    }

    // Verify: payment status shown
    const statusEl = posPage.locator("#pos-status");
    await expect(statusEl).toBeVisible({ timeout: 60_000 });
    await expect(statusEl).not.toBeEmpty({ timeout: 10_000 });
  });

  // ── Step 13: Merchant verifies received payment ───────────────────

  test("Step 13: Merchant verifies received payment", async () => {
    await merchantPage.goto(`${urls.moonlightPay}/#/`);
    await merchantPage.waitForLoadState("networkidle");
    await merchantPage.waitForTimeout(5000);
    await merchantPage.reload();
    await merchantPage.waitForLoadState("networkidle");

    const hasBalance = await merchantPage
      .locator("#balance-display")
      .isVisible()
      .catch(() => false);
    const hasTxList = await merchantPage
      .locator("#tx-list")
      .isVisible()
      .catch(() => false);

    expect(hasBalance || hasTxList).toBeTruthy();

    if (hasTxList) {
      const txContent = await merchantPage.locator("#tx-list").textContent();
      expect(txContent?.length).toBeGreaterThan(0);
    }
  });

  // ── Step 14: OTEL trace verification ──────────────────────────────

  test("Step 14: OTEL trace verification", async () => {
    const testEndEpochS = Math.floor(Date.now() / 1000);

    const otelConfig = buildOtelConfig(
      testStartEpochS,
      testEndEpochS,
      OTEL_SERVICES,
    );

    // Check connectivity
    const reachable = await checkOtelConnectivity(otelConfig);
    if (!reachable) {
      test.skip(
        true,
        `OTEL backend (${otelConfig.backend}) not reachable — skipping`,
      );
      return;
    }

    // Wait for trace ingestion
    // Jaeger is near-instant locally; Tempo needs ~60s on testnet/mainnet
    const waitMs = otelConfig.backend === "jaeger" ? 5_000 : 60_000;
    console.log(
      `Waiting ${
        waitMs / 1000
      }s for trace ingestion into ${otelConfig.backend}...`,
    );
    await new Promise((r) => setTimeout(r, waitMs));

    const result = await verifyOtelTraces(otelConfig);
    console.log(formatOtelResults(result));

    for (const [service, r] of Object.entries(result.serviceResults)) {
      expect(
        r.found,
        `Expected traces from ${service} but found ${r.traceCount}`,
      ).toBeTruthy();
    }

    expect(result.passed).toBeTruthy();
  });
});
