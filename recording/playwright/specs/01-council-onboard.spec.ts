/**
 * Section 01 — Council onboarding (council-console / Freighter).
 *
 * Demo beats:
 *   1. Admin lands on council-console, signs in via Freighter (SEP-53)
 *   2. Creates "Moonlight Demo Council" with metadata + jurisdiction
 *   3. Deploys Channel Auth + Privacy Channel contracts (4 wallet popups)
 *   4. Funds council treasury (1 wallet popup)
 *   5. Confirms XLM asset
 *   6. Lands on the invite step → captures CHANNEL_AUTH_ID
 *
 * Backfills run.env:
 *   CHANNEL_AUTH_ID=<deployed contract id>
 *   PRIVACY_CHANNEL_ID=<deployed channel id>  (if surfaced separately)
 *
 * Ported from local-dev/playwright/tests/full-flow.spec.ts Steps 1-2.
 * Names changed to human-readable demo strings; all selectors unchanged.
 */
import { expect, type Page, test } from "@playwright/test";
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
import { loadRunEnv, updateRunEnv } from "../helpers/run-env";
import { holdAfterSuccess } from "../fixtures/pacing";

const COUNCIL_NAME = "Moonlight Demo Council";
const COUNCIL_DESCRIPTION =
  "Privacy-preserving payments council for the Tranche 2 demo recording.";
const COUNCIL_EMAIL = "demo@moonlight.test";

test.describe.configure({ mode: "serial" });

test("01 — council onboarding", async () => {
  const env = loadRunEnv();
  const urls = getUrls();

  const adminCtx = await createUserContext(null, {
    name: "Admin",
    publicKey: env.ADMIN_PK,
    secretKey: env.ADMIN_SK,
  });

  const councilPage = await adminCtx.context.newPage();

  try {
    // Beat 1 — sign in
    await councilPage.goto(urls.councilConsole);
    await councilPage.waitForLoadState("networkidle");
    await loginWithFreighter(adminCtx.context, councilPage);
    await verifyAuthenticated(councilPage, "nav", 30_000);

    // Beat 2 — create council
    await councilPage.locator("#create-btn, #new-council-btn").first().click();
    await councilPage.waitForSelector("#council-name", { timeout: 10_000 });
    await councilPage.fill("#council-name", COUNCIL_NAME);
    await councilPage.fill("#council-description", COUNCIL_DESCRIPTION);
    await councilPage.fill("#council-email", COUNCIL_EMAIL);

    const jurisdictionPicker = councilPage.locator("#jurisdiction-picker");
    if (
      await jurisdictionPicker.isVisible({ timeout: 3_000 }).catch(() => false)
    ) {
      await councilPage.fill("#jurisdiction-filter", "United States");
      await councilPage.waitForTimeout(500);
      const opt = councilPage.locator(
        "#jurisdiction-list .jurisdiction-option, .jurisdiction-option",
      ).first();
      if (await opt.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await opt.click();
      }
    }
    await councilPage.click("#next-btn");

    // Beat 3 — deploy contracts (multiple signing popups)
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
        await popup
          .locator(
            'button:has-text("Confirm"), button:has-text("Approve"), button:has-text("Sign")',
          )
          .first()
          .click();
      } catch (e) {
        popupError = e as Error;
      }
    };

    adminCtx.context.on("page", approvePopup);
    await councilPage.click("#create-btn");
    await councilPage.waitForSelector("#fund-amount", { timeout: 180_000 });
    adminCtx.context.off("page", approvePopup);
    console.log(`Council deploy: ${popupsApproved} signing popups approved`);
    if (popupError) throw popupError;

    // Beat 4 — fund treasury
    await councilPage.fill("#fund-amount", "10");
    await withWalletApproval(adminCtx.context, councilPage, async () => {
      await councilPage.click("#fund-btn");
    });
    await councilPage.waitForSelector("#next-btn:not([disabled])", {
      timeout: 60_000,
    });
    await councilPage.click("#next-btn");

    // Beat 5 — assets (XLM auto-enabled)
    await councilPage.waitForSelector("#continue-btn, #next-btn", {
      timeout: 10_000,
    });
    await councilPage.locator("#continue-btn, #next-btn").first().click();

    // Beat 6 — invite step → capture council/channel IDs
    await councilPage.waitForSelector("#done-btn", { timeout: 10_000 });
    const inviteLink = await councilPage.locator("#invite-link").inputValue()
      .catch(() => "");
    const idMatch = inviteLink.match(/[?&#]council=([A-Z0-9]+)/);
    const channelAuthId = idMatch?.[1] ??
      (await councilPage.evaluate(
        () => sessionStorage.getItem("onboarding_council_id") ?? "",
      ));

    if (!channelAuthId) {
      throw new Error(
        "Could not capture CHANNEL_AUTH_ID from invite link or sessionStorage",
      );
    }

    // Fetch privacy channel contract ID from the council-platform public API.
    // The channel auth contract ID (above) and the privacy channel contract ID
    // are different deployments; the wallet needs the privacy channel one.
    const channelsRes = await fetch(
      `${urls.councilApi}/api/v1/public/channels?councilId=${channelAuthId}`,
    );
    if (!channelsRes.ok) {
      throw new Error(`Failed to fetch channels: HTTP ${channelsRes.status}`);
    }
    const channelsBody = await channelsRes.json() as {
      data?: { channelContractId: string }[];
    };
    const privacyChannelId = channelsBody.data?.[0]?.channelContractId;
    if (!privacyChannelId) {
      throw new Error(
        `Council ${channelAuthId} has no privacy channel registered yet`,
      );
    }

    updateRunEnv({
      CHANNEL_AUTH_ID: channelAuthId,
      PRIVACY_CHANNEL_ID: privacyChannelId,
    });
    console.log(`CHANNEL_AUTH_ID=${channelAuthId}`);
    if (privacyChannelId) console.log(`PRIVACY_CHANNEL_ID=${privacyChannelId}`);

    await councilPage.click("#done-btn");
    await councilPage.waitForLoadState("networkidle");
    await expect(councilPage.locator(`text=${COUNCIL_NAME}`).first())
      .toBeVisible({ timeout: 15_000 });
    await holdAfterSuccess(councilPage);
  } finally {
    await closeAllContexts({ admin: adminCtx });
  }
});
