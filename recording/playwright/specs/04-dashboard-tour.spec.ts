/**
 * Section 04 — Network dashboard tour.
 *
 * Demo beats:
 *   1. Land on /map, pause on the council marker
 *   2. Click "Councils" → tour the list, point at "Moonlight Demo Council"
 *   3. Drill into the council → show stats + Channels + Registered Providers
 *   4. Scroll to Recent Activity (events from sections 02/03)
 *   5. Click "Transactions" → show the cross-network feed
 *   6. Wrap-up beat
 *
 * Pre-step: `writeDashboardConfig` injects the just-created council into
 * the dashboard's `public/config.js`. The dashboard server serves
 * `public/` directly, so no rebuild is needed — a page reload is enough.
 *
 * Uses launchPersistentContext so it shares the recording rig's video
 * pipeline with the wallet sections.
 */
import { expect, test } from "@playwright/test";
import { loadRunEnv, requireValue } from "../helpers/run-env";
import { writeDashboardConfig } from "../helpers/dashboard-config";
import {
  beat,
  clickWithPause,
  hold,
  holdAfterSuccess,
  hover,
} from "../fixtures/pacing";
import {
  closeWalletContext,
  launchWalletContext,
} from "../fixtures/wallet-context";

const COUNCIL_NAME = "Moonlight Demo Council";

test.describe.configure({ mode: "serial" });

test("04 — dashboard tour", async () => {
  const env = loadRunEnv();
  const channelAuthId = requireValue(env, "CHANNEL_AUTH_ID");

  // Point the dashboard's runtime config at the council-platform API. The
  // dashboard fetches /api/v1/public/councils from there at page load — see
  // network-dashboard/src/lib/config.ts. Without councilPlatformUrl set,
  // the council list view shows "No councils registered yet".
  const configPath = writeDashboardConfig({
    councilPlatformUrl: requireValue(env, "COUNCIL_PLATFORM_URL"),
    probeUrl: env.DASHBOARD_URL,
  });
  console.log(`Dashboard config written: ${configPath}`);

  const handle = await launchWalletContext({
    section: "04",
    runId: env.RUN_ID,
    profileName: "dashboard",
  });

  try {
    const page = await handle.context.newPage();

    // Beat 1 — land on root (redirects to /map).
    await page.goto(env.DASHBOARD_URL);
    await page.waitForLoadState("networkidle");
    await hold(page);

    // Beat 2 — switch to Councils tab and let the table render.
    await clickWithPause(page.locator('nav a[href="#/councils"]').first());
    await page.waitForLoadState("networkidle");
    const councilRow = page
      .locator(
        `tr.clickable-row[data-href*="${encodeURIComponent(channelAuthId)}"]`,
      )
      .first();
    await expect(councilRow).toBeVisible({ timeout: 30_000 });
    await holdAfterSuccess(page);
    await hover(councilRow);
    await beat(page, 2);

    // Beat 3 — drill into the council.
    await clickWithPause(councilRow);
    await page.waitForLoadState("networkidle");
    await expect(page.locator(`h2:has-text("${COUNCIL_NAME}")`)).toBeVisible({
      timeout: 15_000,
    });
    await page.locator("#council-detail-content .stats-row").waitFor({
      timeout: 30_000,
    });
    await holdAfterSuccess(page);

    // Channels section
    const channelsHeading = page.locator('h3:has-text("Channels")').first();
    if (
      await channelsHeading.isVisible({ timeout: 5_000 }).catch(() => false)
    ) {
      await channelsHeading.scrollIntoViewIfNeeded();
      await hold(page);
    }

    // Registered Providers section — proves section 02 happened.
    const providersHeading = page.locator('h3:has-text("Registered Providers")')
      .first();
    if (
      await providersHeading.isVisible({ timeout: 5_000 }).catch(() => false)
    ) {
      await providersHeading.scrollIntoViewIfNeeded();
      await hold(page);
    }

    // Beat 4 — Recent Activity (bundles + provider events from 02/03).
    const activityHeading = page.locator('h3:has-text("Recent Activity")')
      .first();
    if (
      await activityHeading.isVisible({ timeout: 5_000 }).catch(() => false)
    ) {
      await activityHeading.scrollIntoViewIfNeeded();
      await hold(page);
      // First feed item, if any, lands the eye on a real event card.
      const firstFeedItem = page.locator(".feed-list .feed-item").first();
      if (
        await firstFeedItem.isVisible({ timeout: 5_000 }).catch(() => false)
      ) {
        await hover(firstFeedItem);
        await holdAfterSuccess(page);
      }
    }

    // Beat 5 — cross-network transaction feed.
    await clickWithPause(page.locator('nav a[href="#/transactions"]').first());
    await page.waitForLoadState("networkidle");
    await expect(page.locator('h2:has-text("Transaction Feed")')).toBeVisible({
      timeout: 15_000,
    });
    await page.locator("#tx-content .stats-row, #tx-content .empty-state")
      .first().waitFor({
        timeout: 30_000,
      });
    await holdAfterSuccess(page);

    // Beat 6 — wrap-up: scroll to the totals stat-row at top of councils page.
    await clickWithPause(page.locator('nav a[href="#/councils"]').first());
    await page.waitForLoadState("networkidle");
    const statsRow = page.locator("#councils-content .stats-row").first();
    await statsRow.waitFor({ timeout: 15_000 });
    await statsRow.scrollIntoViewIfNeeded();
    await hold(page);
    await holdAfterSuccess(page);
  } finally {
    await closeWalletContext(handle);
  }
});
