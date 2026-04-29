/**
 * Section 02 — Provider create + join + council approval.
 *
 * Demo beats:
 *   1. PP operator signs into provider-console (Freighter)
 *   2. Creates "Acme Privacy Provider" + funds operator account
 *   3. Submits join request to the council from Section 01
 *   4. Switch context: Admin opens council-console, sees pending request
 *   5. Admin approves → on-chain `add_provider`
 *   6. PP refreshes provider-console — provider is active
 *
 * Ported from local-dev/playwright/tests/full-flow.spec.ts Steps 3-6.
 */
import { expect, test } from "@playwright/test";
import {
  closeAllContexts,
  createUserContext,
} from "../../../playwright/fixtures/contexts";
import {
  loginWithFreighter,
  verifyAuthenticated,
} from "../../../playwright/fixtures/auth";
import { withWalletApproval } from "../../../playwright/fixtures/freighter";
import { getUrls } from "../../../playwright/helpers/urls";
import { loadRunEnv, requireValue } from "../helpers/run-env";
import { holdAfterSuccess } from "../fixtures/pacing";

const PROVIDER_NAME = "Acme Privacy Provider";
const PROVIDER_EMAIL = "ops@acme.test";

test.describe.configure({ mode: "serial" });

test("02 — provider create + join + approve", async () => {
  const env = loadRunEnv();
  const urls = getUrls();
  const councilId = requireValue(env, "CHANNEL_AUTH_ID");

  const ppCtx = await createUserContext(null, {
    name: "PP",
    publicKey: env.PP_PK,
    secretKey: env.PP_SK,
  });
  const adminCtx = await createUserContext(null, {
    name: "Admin",
    publicKey: env.ADMIN_PK,
    secretKey: env.ADMIN_SK,
  });

  const providerPage = await ppCtx.context.newPage();
  const councilPage = await adminCtx.context.newPage();

  try {
    // Beat 1 — PP signs into provider-console
    await providerPage.goto(urls.providerConsole);
    await providerPage.waitForLoadState("networkidle");
    await loginWithFreighter(ppCtx.context, providerPage);
    await verifyAuthenticated(providerPage, "nav", 30_000);

    // Beat 2 — create provider
    await providerPage
      .locator("#create-pp-btn, button:has-text('Create')")
      .first()
      .click();

    await providerPage.waitForSelector("#pp-name", { timeout: 10_000 });
    await providerPage.fill("#pp-name", PROVIDER_NAME);
    await providerPage.fill("#pp-email", PROVIDER_EMAIL);
    await providerPage.click("#next-btn");

    // Beat 3 — fund PP operator
    await providerPage.waitForSelector("#fund-amount", { timeout: 15_000 });
    await providerPage.fill("#fund-amount", "10");
    await withWalletApproval(ppCtx.context, providerPage, async () => {
      await providerPage.click("#fund-btn");
    });
    await providerPage.waitForSelector("#next-btn:not([disabled])", {
      timeout: 60_000,
    });
    await providerPage.click("#next-btn");
    await providerPage.waitForLoadState("networkidle");

    // Beat 4 — request join
    const onJoinStep = await providerPage
      .locator("#council-url, #jc-url")
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    if (!onJoinStep) {
      await providerPage.goto(`${urls.providerConsole}/#/home`);
      await providerPage.waitForLoadState("networkidle");
      const joinModalBtn = providerPage.locator(".join-council-btn").first();
      if (await joinModalBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await joinModalBtn.click();
        await providerPage.waitForTimeout(1000);
      }
    }

    const urlInput = providerPage.locator("#council-url, #jc-url").first();
    await urlInput.waitFor({ state: "visible", timeout: 10_000 });
    await urlInput.fill(`${urls.councilApi}?council=${councilId}`);

    await providerPage.locator("#discover-btn, #jc-discover-btn").first()
      .click();
    await providerPage.waitForSelector("#council-info, #jc-info, #jc-confirm", {
      state: "visible",
      timeout: 15_000,
    });
    await providerPage.locator("#join-btn, #jc-join-btn").first().click();

    await providerPage.waitForLoadState("networkidle");
    await providerPage.waitForTimeout(2000);
    if (!providerPage.url().includes("/home")) {
      await providerPage.goto(`${urls.providerConsole}/#/home`);
      await providerPage.waitForLoadState("networkidle");
    }
    await expect(
      providerPage.locator(".badge-pending, .check-status-btn").first(),
    ).toBeVisible({ timeout: 15_000 });
    await holdAfterSuccess(providerPage);

    // Beat 5 — Admin approves
    await councilPage.goto(urls.councilConsole);
    await councilPage.waitForLoadState("networkidle");
    await loginWithFreighter(adminCtx.context, councilPage);
    await verifyAuthenticated(councilPage, "nav", 30_000);
    await councilPage.locator(`a[href*="${councilId}"]`).first().click();
    await councilPage.waitForLoadState("networkidle");

    const requestedRow = councilPage.locator(
      '.provider-row[data-status="Requested"]',
    );
    await expect(requestedRow.first()).toBeVisible({ timeout: 15_000 });
    await requestedRow.first().hover();

    const approveBtn = councilPage.locator(".popup-approve");
    await approveBtn.waitFor({ state: "visible", timeout: 5_000 });

    await withWalletApproval(adminCtx.context, councilPage, async () => {
      await approveBtn.click();
    });

    // Beat 6 — verify active
    await expect(
      councilPage
        .locator(
          '.provider-row[data-status="Active"], .provider-row[data-status="Approved"]',
        )
        .first(),
    ).toBeVisible({ timeout: 120_000 });
    await holdAfterSuccess(councilPage);
  } finally {
    await closeAllContexts({ pp: ppCtx, admin: adminCtx });
  }
});
