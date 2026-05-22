/**
 * Section 04 — Network dashboard tour (single-page drilldown, v0.2.14+).
 *
 * Demo beats:
 *   1. Land on the dashboard, pause on the world map
 *   2. Click the council's jurisdiction country on the map → CountryDetails
 *      panel lists councils operating there
 *   3. Click our council (unique name) → CouncilDetails populates
 *   4. Click our PP (unique name) in "Member PPs" → ProviderDetails populates
 *   5. Wrap-up — hold on the populated detail trio
 *
 * Council + PP names are made unique per RUN_ID so the rig's entries can be
 * distinguished from the 28+ other councils + 27+ PPs already live on the
 * deployed testnet dashboard.
 */
import { expect, test } from "@playwright/test";
import { loadRunEnv } from "../helpers/run-env";
import {
  getCouncilName,
  getJurisdiction,
  getProviderName,
} from "../helpers/run-variants";
import {
  beat,
  clickWithPause,
  hold,
  holdAfterSuccess,
} from "../fixtures/pacing";
import {
  closeWalletContext,
  launchWalletContext,
} from "../fixtures/wallet-context";

test.describe.configure({ mode: "serial" });

test("04 — dashboard tour", async () => {
  const env = loadRunEnv();
  const councilName = getCouncilName();
  const providerName = getProviderName();
  const jurisdiction = getJurisdiction();

  const handle = await launchWalletContext({
    section: "04",
    runId: env.RUN_ID,
    profileName: "dashboard",
  });

  try {
    const page = await handle.context.newPage();

    // Beat 1 — land on the dashboard, pause on the world map.
    await page.goto(env.DASHBOARD_URL);
    await page.waitForLoadState("networkidle");
    await page.bringToFront();
    // World map renders the country jurisdictions asynchronously from the
    // platform websocket. Wait for the SVG host to be visible (a regular
    // div), then for our country path to be attached. We don't `waitFor`
    // SVG paths in `state: "visible"` because Playwright's visibility
    // heuristic doesn't handle SVG path geometry reliably.
    await page.locator(".world-map-section-host svg").first().waitFor({
      state: "visible",
      timeout: 30_000,
    });
    // Country shapes are injected into the SVG asynchronously by
    // renderWorldMap. The tag varies: simple countries are a `<path>`, but
    // multi-piece countries (e.g. Canada — many islands) are wrapped in a
    // `<g>` group with the id+class on the group and `<path>` children
    // inside. Use a tag-agnostic selector so both render shapes match.
    await page.locator(
      `svg .world-map-country#${jurisdiction.code}`,
    ).first().waitFor({
      state: "attached",
      timeout: 60_000,
    });
    await hold(page);

    // Beat 2 — click the council's jurisdiction country on the map.
    // `dispatchEvent('click')` bypasses Playwright's scrollIntoView +
    // actionability checks (which struggle with SVG path bounding boxes)
    // and goes straight to firing a synthetic MouseEvent. The dashboard's
    // click handler is delegated on the host element, so this still
    // surfaces the selected country to CountryDetails.
    await page.locator(
      `svg .world-map-country#${jurisdiction.code}`,
    ).first().dispatchEvent("click");
    await beat(page, 2);

    // Beat 3 — wait for our council to appear in CountryDetails and click it.
    // The country-details panel renders the matching councils. New councils
    // arrive via the platform websocket — give the platform some time to
    // pick up the on-chain event from section 01.
    const councilButton = page
      .locator(".country-details-council")
      .filter({ hasText: councilName })
      .first();
    await councilButton.waitFor({ state: "visible", timeout: 60_000 });
    await holdAfterSuccess(page);
    await clickWithPause(councilButton);
    await beat(page, 2);

    // Beat 4 — wait for our PP to appear in CouncilDetails and click it.
    const ppButton = page
      .locator(".council-details-pp-button")
      .filter({ hasText: providerName })
      .first();
    await ppButton.waitFor({ state: "visible", timeout: 60_000 });
    await holdAfterSuccess(page);
    await clickWithPause(ppButton);
    await beat(page, 2);

    // Beat 5 — provider details visible, wrap-up hold.
    const providerTitle = page
      .locator(".provider-details-title, h2:has-text('Public key')")
      .first();
    await expect(providerTitle).toBeVisible({ timeout: 15_000 });
    await holdAfterSuccess(page);
    await hold(page);
  } finally {
    await closeWalletContext(handle);
  }
});
