/**
 * Freighter setup inside Bob's / Alice's recording-rig BrowserContext.
 *
 * The browser-wallet context has Freighter loaded as a second extension so
 * the rig can drive provider-console's KYC link-out (Stellar Wallets Kit →
 * Freighter). This helper imports the user's Stellar secret into Freighter
 * after browser-wallet onboarding so it can sign the entity-challenge nonce
 * when the spec follows the "Submit KYC" link.
 */
import { type BrowserContext } from "@playwright/test";
import {
  addLocalNetwork,
  setupFreighterAccount,
  switchToTestnet,
} from "../../../playwright/fixtures/freighter";

export async function findFreighterExtensionId(
  context: BrowserContext,
): Promise<string> {
  const candidates = new Set<string>();
  for (const sw of context.serviceWorkers()) {
    const m = sw.url().match(/chrome-extension:\/\/([a-z]+)/);
    if (m) candidates.add(m[1]);
  }
  for (const bp of context.backgroundPages()) {
    const m = bp.url().match(/chrome-extension:\/\/([a-z]+)/);
    if (m) candidates.add(m[1]);
  }
  // chrome://extensions shadow-DOM scrape — picks up MV2 extensions whose
  // background pages are dormant.
  try {
    const extPage = await context.newPage();
    await extPage.goto("chrome://extensions/");
    await extPage.waitForTimeout(500);
    const ids: string[] = await extPage.evaluate(() => {
      const out: string[] = [];
      const mgr = document.querySelector("extensions-manager");
      const itemList = mgr?.shadowRoot?.querySelector("extensions-item-list");
      const items = itemList?.shadowRoot?.querySelectorAll("extensions-item") ??
        [];
      items.forEach((it) => {
        const id = (it as HTMLElement).getAttribute("id");
        if (id) out.push(id);
      });
      return out;
    });
    for (const id of ids) candidates.add(id);
    await extPage.close();
  } catch {
    // fall back to whatever we already collected
  }

  const probe = await context.newPage();
  try {
    for (const id of candidates) {
      try {
        const res = await probe.goto(`chrome-extension://${id}/manifest.json`);
        const text = (await res?.text()) ?? "";
        let name = "";
        try {
          name = String(JSON.parse(text).name ?? "");
        } catch {
          continue;
        }
        if (/^freighter$/i.test(name.trim())) return id;
      } catch {
        // try next
      }
    }
  } finally {
    await probe.close();
  }

  throw new Error(
    `Freighter extension not found in context. Candidates: ${
      Array.from(candidates).join(", ") || "none"
    }`,
  );
}

/**
 * Import the user's Stellar secret into Freighter and put the extension in
 * the same warmed-up state the verification rig leaves it in before its
 * own withWalletApproval call sites fire — see
 * `local-dev/playwright/fixtures/contexts.ts` `setupUserContext`. signMessage
 * is network-agnostic, but Freighter's signing popup needs an active network
 * configured; without it the popup opens onto the Welcome screen and the
 * approve UI never renders.
 *
 * `network` defaults to "local" so the recording rig matches the default
 * `RECORDING_WALLET_NETWORK=custom` (local stellar). Pass "testnet" when
 * recording against a deployed network.
 */
export async function setupFreighterForKyc(
  context: BrowserContext,
  opts: {
    secretKey: string;
    password: string;
    network?: "local" | "testnet";
  },
): Promise<{ extensionId: string }> {
  const extensionId = await findFreighterExtensionId(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  await page.waitForLoadState("domcontentloaded");
  await setupFreighterAccount(page, opts.secretKey, opts.password);
  const network = opts.network ?? "local";
  if (network === "local") {
    await addLocalNetwork(page);
  } else {
    await switchToTestnet(page);
  }
  await page.close();
  return { extensionId };
}
