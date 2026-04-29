/**
 * Moonlight browser-wallet automation (full UI flow, no seed injection).
 *
 * The wallet is loaded via Chromium `--load-extension`. Each user runs in a
 * separate persistent context so storage stays isolated.
 *
 * Selectors come from the browser-wallet source recon. If a selector breaks,
 * search the matching element in `~/repos/browser-wallet/src/popup/`.
 *
 * Coverage:
 *   - SetupWalletPage (password) → AddWalletPage (import mnemonic) → Home
 *   - Toggle home view: public ↔ private (globe icon)
 *   - Create privacy channel (PrivateAddChannelPage)
 *   - Open channel manager sheet → add + connect provider (in-popup signing)
 *   - Ramp (deposit/withdraw), Send (paste MLXDR), Receive (generate MLXDR)
 *
 * NOTE: provider connect navigates to an in-popup sign-request page that asks
 * for the wallet password. There's no separate signing popup window — no
 * `context.on("page", ...)` handler needed.
 */
import { type BrowserContext, type Page } from "@playwright/test";
import { clickWithPause, hold, holdAfterSuccess, typeSlowly } from "./pacing";

// ─── Selectors ─────────────────────────────────────────────────────────

export const SEL = {
  // Setup (first run, no password set)
  passwordInput: 'input[type="password"]',
  setupConfirm: 'button:has-text("Confirm")',

  // Add wallet (after setup)
  importTab: 'button:has-text("Import")',
  mnemonicTextarea: 'textarea[placeholder^="twelve words"], textarea',
  importSubmit: 'button:has-text("Import")',

  // Unlock (returning user)
  unlockButton: 'button:has-text("Unlock Wallet")',

  // Home — readiness checks
  homePublicBalanceLabel: "text=Public Balance",
  privateEmptyState: "text=No Private Channels",
  createChannelEmptyButton: 'button:has-text("Create Channel")',

  // View-mode toggle (globe ↔ shield) — only button in header row with svg, no aria
  viewModeToggleByGlobe: "header button:has(svg.tabler-icon-world)",
  viewModeToggleByShield: "header button:has(svg.tabler-icon-shield-lock)",

  // Channel form (PrivateAddChannelTemplate)
  networkTestButton: 'button:has-text("Test")',
  channelContractId: "#contractId",
  channelName: "#name",
  channelAssetCodeByPlaceholder: 'input[placeholder="XLM"]',
  createChannelSubmit: 'button:has-text("Create Channel")',

  // Channel picker / manager (Sheet)
  channelPickerTrigger:
    'header button:has-text("No Provider"), header button:has-text("Provider")',
  managerAddProviderToggle: 'button:has-text("Add Provider")',
  providerUrlInput: "#provider-url",
  providerNameInput: "#provider-name",
  providerSubmit: 'button:has-text("Add Provider"):not([aria-haspopup])',
  providerConnectButton: 'button:has-text("Connect")',
  sheetClose: 'button[aria-label="Close"]',

  // Sign request page (after provider connect)
  signRequestPasswordInput: 'input#password, input[type="password"]',
  signRequestApproveButton: 'button:has-text("Approve")',

  // Home actions (selected channel view, requires connected provider)
  receiveButton: 'button:has-text("Receive")',
  sendButton: 'button:has-text("Send")',
  rampButton: 'button:has-text("Ramp")',

  // Ramp form
  rampDepositTab: 'button:has-text("Deposit")',
  rampWithdrawTab: 'button:has-text("Withdraw")',
  rampDirectMethod: 'button:has-text("Direct")',
  rampAmountInput: "#amount",
  rampDestinationAddress: "#destination-address",
  rampReviewDeposit: 'button:has-text("Review Deposit")',
  rampReviewWithdraw: 'button:has-text("Review Withdraw")',
  rampExecute: 'button:has-text("Execute Transaction")',

  // Send form
  sendMlxdrTextarea: "#mlxdr",
  sendAmountInput: "#amount",
  sendReview: 'button:has-text("Review Transfer")',

  // Receive form
  receiveAmountInput: "#amount",
  receiveGenerate: 'button:has-text("Generate Receiving Address")',
  // Confirmation page renders the MLXDR inside a labeled card.
  receiveMlxdrLabel: "text=Receiving Address (MLXDR)",
  receiveMlxdrValue: "span.font-mono",

  // Private-view home: "Confidential Balance" label sits above the actual
  // figure. Polling its sibling for a non-zero number is how we tell the
  // chain has confirmed our deposit.
  confidentialBalanceLabel: "text=Confidential Balance",
} as const;

// ─── Discovery ─────────────────────────────────────────────────────────

export async function findBrowserWalletExtensionId(
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

  // MV3 service workers can be dormant — enumerate every installed id
  // via chrome://extensions shadow DOM scrape.
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
    // fall through to whatever we already collected
  }

  // Match by parsed manifest.name — fuzzy regex over raw text false-matches
  // Freighter, whose bundled JS contains the string "browser wallet".
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
        if (/^stellar custom wallet$/i.test(name.trim())) {
          return id;
        }
      } catch {
        // try next
      }
    }
  } finally {
    await probe.close();
  }

  throw new Error(
    `browser-wallet extension not found in context. Candidates: ${
      [...candidates].join(", ") || "none"
    }`,
  );
}

export async function openWalletPopup(
  context: BrowserContext,
  extensionId: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForLoadState("domcontentloaded");
  return page;
}

// ─── Onboarding ────────────────────────────────────────────────────────

export interface OnboardOptions {
  password: string;
  mnemonic: string;
}

/**
 * First-run onboarding: SetupWalletPage → AddWalletPage (import mnemonic).
 * Stops on the home page (public view).
 */
export async function onboardWithMnemonic(
  page: Page,
  opts: OnboardOptions,
): Promise<void> {
  // Step 1 — set password (two password fields).
  await page.locator(SEL.passwordInput).first().waitFor({ timeout: 30_000 });
  const pwInputs = page.locator(SEL.passwordInput);
  await typeSlowly(pwInputs.nth(0), opts.password);
  await typeSlowly(pwInputs.nth(1), opts.password);
  await clickWithPause(page.locator(SEL.setupConfirm).first());

  // Step 2 — Import path: click Import button (transitions to Import wallet page).
  await page.locator(SEL.importTab).first().waitFor({ timeout: 10_000 });
  await clickWithPause(page.locator(SEL.importTab).first());

  // Step 3 — Enter mnemonic, click Import.
  await typeSlowly(
    page.locator(SEL.mnemonicTextarea).first(),
    opts.mnemonic,
    20,
  );
  await clickWithPause(page.locator(SEL.importSubmit).first());

  // Land on home — Public Balance row is the readiness signal in public view.
  await page
    .locator(SEL.homePublicBalanceLabel)
    .first()
    .waitFor({ timeout: 60_000 });
  await hold(page);
}

export async function unlock(page: Page, password: string): Promise<void> {
  await page.locator(SEL.passwordInput).first().waitFor({ timeout: 30_000 });
  await typeSlowly(page.locator(SEL.passwordInput).first(), password);
  await clickWithPause(page.locator(SEL.unlockButton).first());
  await page
    .locator(SEL.homePublicBalanceLabel)
    .first()
    .waitFor({ timeout: 30_000 });
}

// ─── Network selection ─────────────────────────────────────────────────

/**
 * Switch the wallet's `lastSelectedNetwork` to "custom" via the background
 * SET_NETWORK message. The Settings UI explicitly disables clicking "Custom",
 * but the background handler accepts it. Without this, the home filters
 * channels by mainnet and our locally-created channels never surface.
 */
export async function selectCustomNetwork(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // The popup runs as a chrome-extension page, so chrome.runtime is bound
    // to the wallet's own background — no extension id required.
    const c = (globalThis as unknown as {
      chrome?: { runtime?: { sendMessage?: (m: unknown) => Promise<unknown> } };
    }).chrome;
    if (!c?.runtime?.sendMessage) {
      throw new Error("chrome.runtime.sendMessage not available in popup");
    }
    await c.runtime.sendMessage({ type: "SET_NETWORK", network: "custom" });
  });

  // Reload so the React state picks up `lastSelectedNetwork === "custom"`.
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page
    .locator(SEL.homePublicBalanceLabel)
    .first()
    .waitFor({ timeout: 30_000 });
  await hold(page);
}

// ─── View toggle + channel creation ────────────────────────────────────

/** Toggle home from public to private view. */
export async function toggleToPrivateView(page: Page): Promise<void> {
  const toggle = page.locator(SEL.viewModeToggleByGlobe).first();
  if (await toggle.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await clickWithPause(toggle);
  }
  // After toggle, empty state shows "No Private Channels".
  await page.locator(SEL.privateEmptyState).first().waitFor({
    timeout: 10_000,
  });
  await hold(page);
}

export interface AddChannelOptions {
  contractId: string;
  channelName: string;
  network?: "Test" | "Main" | "Future" | "Custom"; // default: "Test"
  assetCode?: string; // default: "XLM"
}

/**
 * From home (private view, empty state) → create channel form → submit.
 * Returns to home (private view, with the channel selected).
 */
export async function createPrivacyChannel(
  page: Page,
  opts: AddChannelOptions,
): Promise<void> {
  await clickWithPause(page.locator(SEL.createChannelEmptyButton).first());

  // Form: PrivateAddChannelTemplate
  // Network (Test by default for our local stack)
  const network = opts.network ?? "Test";
  const networkBtn = page.locator(`button:has-text("${network}")`).first();
  if (await networkBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await clickWithPause(networkBtn);
  }

  await typeSlowly(
    page.locator(SEL.channelContractId).first(),
    opts.contractId,
  );
  await typeSlowly(page.locator(SEL.channelName).first(), opts.channelName);

  // Asset code field (placeholder "XLM")
  await typeSlowly(
    page.locator(SEL.channelAssetCodeByPlaceholder).first(),
    opts.assetCode ?? "XLM",
  );

  // Submit — button text is "Create Channel" (or "Adding Channel..." while busy)
  await clickWithPause(page.locator(SEL.createChannelSubmit).last());

  // Success: empty state is gone and the channel picker trigger appears in
  // the header (showing the channel name or "No Provider").
  await page
    .locator(SEL.privateEmptyState)
    .first()
    .waitFor({ state: "detached", timeout: 30_000 });
  await page
    .locator(SEL.channelPickerTrigger)
    .first()
    .waitFor({ timeout: 15_000 });
  await holdAfterSuccess(page);
}

// ─── Provider add + connect ────────────────────────────────────────────

/**
 * Open channel picker sheet, add a provider, connect (which navigates to
 * the in-popup sign-request page → password → Approve).
 */
export async function addAndConnectProvider(
  page: Page,
  opts: { providerUrl: string; providerName: string; password: string },
): Promise<void> {
  // Open the channel picker sheet (shows PrivateChannelManager).
  const trigger = page.locator(SEL.channelPickerTrigger).first();
  await clickWithPause(trigger);

  // Click "Add Provider" toggle (the dashed-border button at the bottom).
  const addToggle = page.locator(SEL.managerAddProviderToggle).first();
  await addToggle.waitFor({ timeout: 10_000 });
  await clickWithPause(addToggle);

  // Fill provider form.
  await typeSlowly(
    page.locator(SEL.providerUrlInput).first(),
    opts.providerUrl,
  );
  await typeSlowly(
    page.locator(SEL.providerNameInput).first(),
    opts.providerName,
  );

  // Submit add — picks the form button (not the toggle we just used).
  // Both have text "Add Provider" — prefer the visible submit inside the form card.
  const submitBtn = page
    .locator('button:has-text("Add Provider"):not(:has(svg))')
    .first();
  await clickWithPause(submitBtn);

  // Provider row appears with Connect button.
  const connectBtn = page.locator(SEL.providerConnectButton).first();
  await connectBtn.waitFor({ timeout: 30_000 });
  await clickWithPause(connectBtn);

  // In-popup signing page: enter password, approve.
  await page.locator(SEL.signRequestPasswordInput).first().waitFor({
    timeout: 30_000,
  });
  await typeSlowly(
    page.locator(SEL.signRequestPasswordInput).first(),
    opts.password,
  );
  await clickWithPause(page.locator(SEL.signRequestApproveButton).first());

  // Success: navigates back to home with provider connected. The action
  // buttons enable (Receive visible) and the header dot turns green.
  await page.locator(SEL.receiveButton).first().waitFor({ timeout: 60_000 });
  await page
    .locator('header span.bg-green-400, header [class*="bg-green-400"]')
    .first()
    .waitFor({ timeout: 15_000 })
    .catch(() => {});
  await holdAfterSuccess(page);
}

// ─── Actions ───────────────────────────────────────────────────────────

export interface AmountOptions {
  amount: string;
}

/** Deposit via Ramp form (public → private). */
export async function deposit(page: Page, opts: AmountOptions): Promise<void> {
  await clickWithPause(page.locator(SEL.rampButton).first());

  // Defaults to deposit mode + Direct method.
  await typeSlowly(page.locator(SEL.rampAmountInput).first(), opts.amount);
  await clickWithPause(page.locator(SEL.rampReviewDeposit).first());

  // Review screen → Execute Transaction.
  const exec = page.locator(SEL.rampExecute).first();
  if (await exec.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await clickWithPause(exec);
  }

  // Success: the wallet navigates back to home with the action buttons
  // present. Receive being visible again is the readiness signal.
  await page.locator(SEL.receiveButton).first().waitFor({ timeout: 60_000 });
  await holdAfterSuccess(page);
}

export interface SendOptions extends AmountOptions {
  /** Receiver MLXDR (multiline base64) — capture from showReceive on counterparty wallet. */
  receiverMlxdr: string;
}

/** Send to a counterparty whose Receive flow produced an MLXDR. */
export async function send(page: Page, opts: SendOptions): Promise<void> {
  await clickWithPause(page.locator(SEL.sendButton).first());

  await typeSlowly(
    page.locator(SEL.sendMlxdrTextarea).first(),
    opts.receiverMlxdr,
    5,
  );
  await typeSlowly(page.locator(SEL.sendAmountInput).first(), opts.amount);
  await clickWithPause(page.locator(SEL.sendReview).first());

  // Review may render an Execute Transaction button — click if present.
  const exec = page.locator(SEL.rampExecute).first();
  if (await exec.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await clickWithPause(exec);
  }

  // Success: navigates back to home with action buttons available.
  await page.locator(SEL.receiveButton).first().waitFor({ timeout: 60_000 });
  await holdAfterSuccess(page);
}

export interface ReceiveOptions {
  amount: string;
}

/**
 * Generate a receiving address. Returns the MLXDR text (best-effort) so the
 * caller can persist it for a counterparty's Send flow.
 */
export async function showReceive(
  page: Page,
  opts: ReceiveOptions,
): Promise<string | undefined> {
  await clickWithPause(page.locator(SEL.receiveButton).first());
  await typeSlowly(page.locator(SEL.receiveAmountInput).first(), opts.amount);
  await clickWithPause(page.locator(SEL.receiveGenerate).first());

  // Success: confirmation page renders the MLXDR card. Wait for the labeled
  // section before reading the value.
  await page
    .locator(SEL.receiveMlxdrLabel)
    .first()
    .waitFor({ timeout: 30_000 });
  await holdAfterSuccess(page);

  try {
    const out = page.locator(SEL.receiveMlxdrValue).first();
    if (await out.isVisible({ timeout: 5_000 }).catch(() => false)) {
      return (await out.textContent())?.trim() ?? undefined;
    }
  } catch {
    // ignore — caller treats as best-effort
  }
  return undefined;
}

export interface WithdrawOptions extends AmountOptions {
  destinationAddress: string;
}

/**
 * Poll the home page until "Confidential Balance" reflects at least
 * `minimumXlm` XLM. Useful as a between-step guard when a section needs
 * the chain to actually confirm a deposit before opening withdraw — the
 * deposit's UI success indicator (back-to-home) only proves the tx was
 * submitted, not that it's been included on-chain.
 */
export async function waitForConfidentialBalance(
  page: Page,
  minimumXlm: number,
  timeoutMs = 120_000,
): Promise<void> {
  await page.locator(SEL.confidentialBalanceLabel).first().waitFor({
    timeout: 30_000,
  });
  await page.waitForFunction(
    (min: number) => {
      const labels = Array.from(document.querySelectorAll("p"));
      const label = labels.find((p) =>
        p.textContent?.trim() === "Confidential Balance"
      );
      if (!label) return false;
      // Sibling structure: <p>Confidential Balance</p> then a div with the value span.
      const container = label.parentElement?.parentElement;
      const valueSpan = container?.querySelector(
        "span.text-4xl, span.text-5xl",
      );
      const text = valueSpan?.textContent?.trim() ?? "";
      const num = parseFloat(text);
      return Number.isFinite(num) && num >= min;
    },
    minimumXlm,
    { timeout: timeoutMs, polling: 1_000 },
  );
}

/** Withdraw via Ramp form (private → public). */
export async function withdraw(
  page: Page,
  opts: WithdrawOptions,
): Promise<void> {
  await clickWithPause(page.locator(SEL.rampButton).first());

  // Switch to withdraw tab.
  await clickWithPause(page.locator(SEL.rampWithdrawTab).first());

  await typeSlowly(
    page.locator(SEL.rampDestinationAddress).first(),
    opts.destinationAddress,
  );
  await typeSlowly(page.locator(SEL.rampAmountInput).first(), opts.amount);
  await clickWithPause(page.locator(SEL.rampReviewWithdraw).first());

  const exec = page.locator('button:has-text("Execute Withdraw")').first();
  await exec.waitFor({ state: "visible", timeout: 15_000 });
  await clickWithPause(exec);

  // Success: navigates back to home with action buttons available.
  await page.locator(SEL.receiveButton).first().waitFor({ timeout: 60_000 });
  await holdAfterSuccess(page);
}
