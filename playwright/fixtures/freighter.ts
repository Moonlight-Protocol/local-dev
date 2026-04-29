/**
 * Freighter Chrome extension helpers for Playwright.
 *
 * Handles: first-time onboarding (import wallet + set password),
 * returning unlock, network switching, and wallet popup approval.
 *
 * Tested against Freighter v5.39.0 (MV3, React-based UI).
 *
 * IMPORTANT: Freighter selectors are version-dependent. Each selector
 * has a comment explaining what element it targets. If Freighter updates
 * its UI, update the selectors here.
 */
import { type BrowserContext, type Page } from "@playwright/test";
import { getFriendbotUrl, getStellarRpcUrl } from "../helpers/urls";

// ─── Selectors (Freighter v5.39.0) ──────────────────────────────

/** Password input — used on both create-password and unlock screens */
const SEL_PASSWORD_INPUT = 'input[type="password"]';

/** "Log In" / "Unlock" button on the returning-user unlock screen */
const SEL_UNLOCK_BUTTON =
  'button:has-text("Log In"), button:has-text("Unlock")';

/** "Confirm" / "Approve" / "Sign" / "Connect" / "Allow" button on wallet popups */
export const SEL_APPROVE_BUTTON =
  'button:has-text("Confirm"), button:has-text("Approve"), button:has-text("Sign"), button:has-text("Connect"), button:has-text("Allow")';

/** "Reject" / "Deny" / "Cancel" button on wallet popups */
const SEL_REJECT_BUTTON =
  'button:has-text("Reject"), button:has-text("Deny"), button:has-text("Cancel")';

// ─── Extension detection ──────────────────────────────────────────

/**
 * Open the Freighter extension popup in a new tab.
 */
export async function openFreighterPopup(
  context: BrowserContext,
  extensionId: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  await page.waitForLoadState("domcontentloaded");
  // Give React time to render
  await page.waitForTimeout(2000);
  return page;
}

// ─── First-time setup (onboarding) ───────────────────────────────

/**
 * Set up Freighter in a fresh profile: create wallet, then import secret key.
 *
 * Freighter v5.39 onboarding does NOT support direct secret key import.
 * The flow is:
 *   1. Welcome → "Create new wallet" (generates a random mnemonic account)
 *   2. Set password + confirm + terms → Confirm
 *   3. Recovery phrase → "Do this later"
 *   4. Reload to get past the "pin extension" screen
 *   5. Navigate to #/account/import → fill secret key + password + checkbox → Import
 *   6. Switch to the imported account as the active wallet
 */
export async function setupFreighterAccount(
  freighterPage: Page,
  secretKey: string,
  password: string,
): Promise<void> {
  const extUrl = freighterPage.url().replace(/#.*/, "");

  // ── Phase 1: Complete onboarding with a throwaway mnemonic wallet ──

  // Welcome screen → "Create new wallet"
  const createBtn = freighterPage.locator(
    'button:has-text("Create new wallet")',
  );
  await createBtn.waitFor({ state: "visible", timeout: 10_000 });
  await createBtn.click();
  await freighterPage.waitForTimeout(1000);

  // Password screen: fill both fields + check terms
  const passwordInputs = freighterPage.locator('input[type="password"]');
  await passwordInputs.first().waitFor({ state: "visible", timeout: 5_000 });
  await passwordInputs.nth(0).fill(password);
  await passwordInputs.nth(1).fill(password);
  await freighterPage.locator('input[type="checkbox"]').check({ force: true });
  await freighterPage.waitForTimeout(500);
  await freighterPage.locator('button[data-testid="account-creator-submit"]')
    .click({ timeout: 10_000 });
  await freighterPage.waitForTimeout(2000);

  // Recovery phrase screen → skip
  await freighterPage.locator('button:has-text("Do this later")').click();
  await freighterPage.waitForTimeout(2000);

  // ── Phase 2: Import the actual secret key ──

  // Navigate to the secret key import page
  await freighterPage.goto(`${extUrl}#/account/import`);
  await freighterPage.waitForTimeout(2000);

  // Fill the secret key (input[name="privateKey"])
  await freighterPage.locator("#privateKey-input").fill(secretKey);
  // Fill the wallet password (input[name="password"])
  await freighterPage.locator("#password-input").fill(password);
  // Check the authorization checkbox ("I'm aware Freighter can't recover...")
  await freighterPage.locator("#authorization-input").check({ force: true });
  await freighterPage.waitForTimeout(500);

  // Click Import
  await freighterPage.locator('button[data-testid="import-account-button"]')
    .click({ timeout: 10_000 });
  await freighterPage.waitForTimeout(3000);

  // ── Phase 3: Switch to the imported account ──

  // After import, Freighter may auto-switch to the new account or stay on
  // the wallets page. Navigate to wallets to confirm and switch if needed.
  await freighterPage.goto(`${extUrl}#/wallets`);
  await freighterPage.waitForTimeout(2000);

  // Click the second wallet row (the imported account) to select it
  const walletRows = freighterPage.locator('[data-testid="wallet-row-select"]');
  const rowCount = await walletRows.count();
  if (rowCount >= 2) {
    // The imported account is the second row
    await walletRows.nth(1).click();
    await freighterPage.waitForTimeout(1000);
  }

  // Return to main UI
  await freighterPage.goto(extUrl);
  await freighterPage.waitForTimeout(2000);
}

/**
 * Unlock Freighter with the dev password (returning user, already set up).
 */
export async function unlockFreighter(
  freighterPage: Page,
  password: string,
): Promise<void> {
  await freighterPage.waitForSelector(SEL_PASSWORD_INPUT, { timeout: 10_000 });
  await freighterPage.fill(SEL_PASSWORD_INPUT, password);
  await freighterPage.click(SEL_UNLOCK_BUTTON);
  await freighterPage.waitForSelector(SEL_PASSWORD_INPUT, {
    state: "hidden",
    timeout: 10_000,
  });
}

// ─── Network switching ────────────────────────────────────────────

/**
 * Switch Freighter to testnet via the network selector dropdown.
 */
export async function switchToTestnet(
  freighterPage: Page,
): Promise<void> {
  const extUrl = freighterPage.url().replace(/#.*/, "");
  await freighterPage.goto(extUrl);
  await freighterPage.waitForTimeout(1500);

  const networkSelector = freighterPage.locator(
    '[data-testid="network-selector-open"]',
  );
  if (await networkSelector.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const text = await networkSelector.textContent() ?? "";
    if (text.includes("Test Net")) {
      return; // already on testnet
    }
    await networkSelector.click();
    await freighterPage.waitForTimeout(500);
    await freighterPage.locator(
      '.AccountHeader__network-selector__row:has-text("Test Net")',
    ).click();
    await freighterPage.waitForTimeout(1000);
  }
}

/**
 * Add a custom "Local" network in Freighter and switch to it.
 *
 * The local-dev stack uses the Stellar standalone network:
 *   - Passphrase: "Standalone Network ; February 2017"
 *   - Horizon/RPC: http://localhost:8000
 *   - Soroban RPC: http://localhost:8000/soroban/rpc
 *   - Friendbot:   http://localhost:8000/friendbot
 *
 * Freighter v5.39 add-network form at #/manage-network/add-network.
 */
export async function addLocalNetwork(
  freighterPage: Page,
): Promise<void> {
  const rpcUrl = getStellarRpcUrl();
  const friendbotUrl = getFriendbotUrl();
  const baseUrl = new URL(rpcUrl).origin;
  const extUrl = freighterPage.url().replace(/#.*/, "");

  // Navigate to the add-network form
  await freighterPage.goto(`${extUrl}#/manage-network/add-network`);
  await freighterPage.waitForTimeout(1500);

  // Fill the form
  await freighterPage.locator("#networkName").fill("Local");
  await freighterPage.locator("#networkUrl").fill(baseUrl);
  await freighterPage.locator("#sorobanRpcUrl").fill(rpcUrl);
  await freighterPage.locator("#networkPassphrase").fill(
    "Standalone Network ; February 2017",
  );
  await freighterPage.locator("#friendbotUrl").fill(friendbotUrl);

  // Check "Allow connecting to non-HTTPS networks"
  await freighterPage.locator("#isAllowHttpSelected-input").check({
    force: true,
  });
  // Check "Switch to this network"
  await freighterPage.locator("#isSwitchSelected-input").check({ force: true });
  await freighterPage.waitForTimeout(500);

  // Click "Add network"
  await freighterPage.locator('[data-testid="NetworkForm__add"]').click({
    timeout: 10_000,
  });
  await freighterPage.waitForTimeout(2000);
}

// ─── Wallet popup handlers ────────────────────────────────────────

/**
 * Wait for a Freighter popup (new page) triggered by a wallet action,
 * then approve it.
 */
export async function approveNextPopup(
  context: BrowserContext,
  timeoutMs = 30_000,
): Promise<void> {
  const popup = await context.waitForEvent("page", { timeout: timeoutMs });
  await popup.waitForLoadState("domcontentloaded");
  await popup.waitForTimeout(1500);

  await popup.waitForSelector(SEL_APPROVE_BUTTON, { timeout: 10_000 });
  await popup.click(SEL_APPROVE_BUTTON);

  await popup.waitForEvent("close", { timeout: 10_000 }).catch(() => {});
}

/**
 * Wait for a Freighter popup and reject it.
 */
export async function rejectNextPopup(
  context: BrowserContext,
  timeoutMs = 30_000,
): Promise<void> {
  const popup = await context.waitForEvent("page", { timeout: timeoutMs });
  await popup.waitForLoadState("domcontentloaded");
  await popup.waitForTimeout(1500);

  await popup.waitForSelector(SEL_REJECT_BUTTON, { timeout: 10_000 });
  await popup.click(SEL_REJECT_BUTTON);

  await popup.waitForEvent("close", { timeout: 10_000 }).catch(() => {});
}

/**
 * Set up popup listener BEFORE triggering the action, then approve.
 * This is the recommended pattern — avoids race conditions.
 */
export async function withWalletApproval(
  context: BrowserContext,
  page: Page,
  triggerAction: () => Promise<void>,
  timeoutMs = 30_000,
): Promise<void> {
  const popupPromise = context.waitForEvent("page", { timeout: timeoutMs });
  await triggerAction();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  await popup.waitForTimeout(1500);
  await popup.waitForSelector(SEL_APPROVE_BUTTON, { timeout: 10_000 });
  await popup.click(SEL_APPROVE_BUTTON);
  await popup.waitForEvent("close", { timeout: 10_000 }).catch(() => {});
}
