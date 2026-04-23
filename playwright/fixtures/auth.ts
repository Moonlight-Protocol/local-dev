/**
 * SEP-53 authentication flow helpers for Playwright.
 *
 * Each frontend (council-console, provider-console, moonlight-pay) uses
 * the same pattern:
 *   1. Click "Connect Wallet" → Freighter connect popup
 *   2. Click "Sign In" → Freighter sign message popup (SEP-53 challenge)
 *   3. Verify: dashboard/home loads
 *
 * These helpers encapsulate the two-step wallet auth flow.
 */
import { type BrowserContext, type Page, expect } from "@playwright/test";
import { withWalletApproval, approveNextPopup, SEL_APPROVE_BUTTON } from "./freighter";

/**
 * Connect Freighter wallet on a login page.
 *
 * The frontends use Stellar Wallets Kit which shows a wallet picker modal
 * when the connect button is clicked. The flow is:
 *   1. Click the connect button → modal opens
 *   2. Click "Freighter" in the <stellar-wallets-modal> → Freighter popup opens
 *   3. Approve the Freighter popup
 *
 * @param connectBtnSelector - CSS selector for the "Connect Wallet" button
 */
export async function connectWallet(
  context: BrowserContext,
  page: Page,
  connectBtnSelector: string,
): Promise<void> {
  await page.waitForSelector(connectBtnSelector, { timeout: 15_000 });

  // Step 1: Click the connect button to open the wallet picker modal
  await page.click(connectBtnSelector);
  await page.waitForTimeout(1000);

  // Step 2: Click "Freighter" in the modal, which triggers the extension popup
  // The modal is a <stellar-wallets-modal> web component. Playwright pierces
  // shadow DOM automatically with text selectors.
  await withWalletApproval(context, page, async () => {
    // Try multiple approaches to find the Freighter option in the modal
    const freighterOption = page.locator('text=Freighter').first();
    if (await freighterOption.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await freighterOption.click();
    } else {
      // Fallback: look inside the web component's shadow DOM
      await page.evaluate(() => {
        const modal = document.querySelector("stellar-wallets-modal");
        if (modal?.shadowRoot) {
          const btn = modal.shadowRoot.querySelector('[data-wallet-id]') as HTMLElement
            ?? modal.shadowRoot.querySelector("button") as HTMLElement;
          btn?.click();
        }
      });
    }
  });
}

/**
 * Sign in via SEP-53 challenge after wallet is connected.
 *
 * Clicking sign-in triggers TWO sequential Freighter popups:
 *   1. initMasterSeed() → signMessage("Moonlight: authorize master key")
 *   2. authenticate() → signMessage(challenge nonce)
 *
 * We register the listener for popup 2 BEFORE confirming popup 1 to
 * avoid a race where popup 2 opens before we start listening.
 */
export async function signIn(
  context: BrowserContext,
  page: Page,
  signInBtnSelector: string,
): Promise<void> {
  await page.waitForSelector(signInBtnSelector, { timeout: 15_000 });

  // Listen for popup 1 before clicking
  const popup1Promise = context.waitForEvent("page", { timeout: 30_000 });
  await page.click(signInBtnSelector);

  const popup1 = await popup1Promise;
  await popup1.waitForLoadState("domcontentloaded");
  await popup1.waitForTimeout(1500);

  // Register listener for popup 2 BEFORE confirming popup 1
  const popup2Promise = context.waitForEvent("page", { timeout: 30_000 });

  await popup1.waitForSelector(SEL_APPROVE_BUTTON, { timeout: 10_000 });
  await popup1.click(SEL_APPROVE_BUTTON);

  // Handle popup 2
  const popup2 = await popup2Promise;
  await popup2.waitForLoadState("domcontentloaded");
  await popup2.waitForTimeout(1500);
  await popup2.waitForSelector(SEL_APPROVE_BUTTON, { timeout: 10_000 });
  await popup2.click(SEL_APPROVE_BUTTON);
  await popup2.waitForEvent("close", { timeout: 10_000 }).catch(() => {});
}

/**
 * Full login flow: connect + sign in.
 * Works for council-console (#connect-btn → #signin-btn) and
 * provider-console (#connect-btn → #signin-btn).
 */
export async function loginWithFreighter(
  context: BrowserContext,
  page: Page,
  opts?: {
    connectBtn?: string;
    signInBtn?: string;
  },
): Promise<void> {
  const connectBtn = opts?.connectBtn ?? "#connect-btn";
  const signInBtn = opts?.signInBtn ?? "#signin-btn";

  // Step 1: Connect wallet
  await connectWallet(context, page, connectBtn);

  // Step 2: Sign in (SEP-53 challenge)
  await signIn(context, page, signInBtn);
}

/**
 * Login flow for moonlight-pay.
 * Moonlight Pay chains connectWallet → initMasterSeed → authenticate
 * in its connect handler. This means:
 *   1. Wallet picker modal opens → click Freighter
 *   2. Freighter popup: connection approval (requestAccess)
 *   3. Freighter popup: master seed signature (signMessage)
 *   4. Freighter popup: platform auth signature (signMessage)
 *
 * We chain popup listeners to avoid race conditions.
 */
export async function loginMoonlightPay(
  context: BrowserContext,
  page: Page,
): Promise<void> {
  const connectBtn = "#connect-btn";
  await page.waitForSelector(connectBtn, { timeout: 15_000 });

  // Open the wallet picker modal
  await page.click(connectBtn);
  await page.waitForTimeout(1000);

  // Listen for popup 1 (connection) before clicking Freighter
  const popup1Promise = context.waitForEvent("page", { timeout: 30_000 });

  const freighterOption = page.locator('text=Freighter').first();
  if (await freighterOption.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await freighterOption.click();
  } else {
    await page.evaluate(() => {
      const modal = document.querySelector("stellar-wallets-modal");
      if (modal?.shadowRoot) {
        const btn = modal.shadowRoot.querySelector('[data-wallet-id]') as HTMLElement
          ?? modal.shadowRoot.querySelector("button") as HTMLElement;
        btn?.click();
      }
    });
  }

  // Handle popup 1 (connection)
  const popup1 = await popup1Promise;
  await popup1.waitForLoadState("domcontentloaded");
  await popup1.waitForTimeout(1500);

  // Register for popup 2 BEFORE confirming popup 1
  const popup2Promise = context.waitForEvent("page", { timeout: 30_000 });

  await popup1.waitForSelector(SEL_APPROVE_BUTTON, { timeout: 10_000 });
  await popup1.click(SEL_APPROVE_BUTTON);

  // Handle popup 2 (initMasterSeed)
  const popup2 = await popup2Promise;
  await popup2.waitForLoadState("domcontentloaded");
  await popup2.waitForTimeout(1500);

  // Register for popup 3 BEFORE confirming popup 2.
  // Use a longer timeout — in Docker/xvfb, the authenticate() fetch to
  // pay-platform can take several seconds before signMessage fires.
  const popup3Promise = context.waitForEvent("page", { timeout: 60_000 });

  await popup2.waitForSelector(SEL_APPROVE_BUTTON, { timeout: 10_000 });
  await popup2.click(SEL_APPROVE_BUTTON);

  // Wait for popup 2 to close — Freighter needs time between consecutive
  // signMessage calls, and moving on too early can cause the next one to fail.
  await popup2.waitForEvent("close", { timeout: 10_000 }).catch(() => {});

  // Handle popup 3 (authenticate)
  const popup3 = await popup3Promise;
  await popup3.waitForLoadState("domcontentloaded");
  await popup3.waitForTimeout(1500);
  await popup3.waitForSelector(SEL_APPROVE_BUTTON, { timeout: 10_000 });
  await popup3.click(SEL_APPROVE_BUTTON);
  await popup3.waitForEvent("close", { timeout: 10_000 }).catch(() => {});
}

/**
 * Verify that a page has successfully authenticated by checking
 * that the login form is gone and some content is visible.
 */
export async function verifyAuthenticated(
  page: Page,
  contentSelector: string,
  timeoutMs = 30_000,
): Promise<void> {
  await expect(page.locator(contentSelector)).toBeVisible({
    timeout: timeoutMs,
  });
}
