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
import process from "node:process";
import { clickWithPause, hold, holdAfterSuccess, typeSlowly } from "./pacing";

// ─── Network selection (env-driven) ───────────────────────────────────
//
// RECORDING_WALLET_NETWORK selects which Stellar network the wallet uses.
// Defaults to "custom" (local stellar-local) for backward compat with the
// local-dev recording flow. Set to "testnet" / "mainnet" / "futurenet" to
// record against deployed networks.

type WalletNetwork = "mainnet" | "testnet" | "futurenet" | "custom";
type ChannelNetworkLabel = "Test" | "Main" | "Future" | "Custom";

const CHANNEL_LABEL_BY_NETWORK: Record<WalletNetwork, ChannelNetworkLabel> = {
  mainnet: "Main",
  testnet: "Test",
  futurenet: "Future",
  custom: "Custom",
};

function getRecordingWalletNetwork(): WalletNetwork {
  const raw = (process.env.RECORDING_WALLET_NETWORK ?? "custom").toLowerCase();
  if (
    raw === "mainnet" || raw === "testnet" || raw === "futurenet" ||
    raw === "custom"
  ) {
    return raw;
  }
  throw new Error(
    `RECORDING_WALLET_NETWORK must be one of mainnet|testnet|futurenet|custom, got: ${raw}`,
  );
}

/** Channel-form button label matching the wallet network. */
export function getRecordingChannelLabel(): ChannelNetworkLabel {
  return CHANNEL_LABEL_BY_NETWORK[getRecordingWalletNetwork()];
}

// ─── Selectors ─────────────────────────────────────────────────────────

export const SEL = {
  // Setup (first run, no password set)
  passwordInput: 'input[type="password"]',
  setupConfirm: 'button:has-text("Confirm")',
  providerPubkeyInput: "#provider-pubkey",
  submitKycButton: 'button:has-text("Submit KYC"):not([disabled])',
  kycNameInput: "#kyc-name",
  kycPasswordInput: "#kyc-password",

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
  // Copy MLXDR — clicking it telegraphs "this is what the sender needs".
  receiveCopyButton:
    'button:has(svg.tabler-icon-copy), button:has-text("Copy")',

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
  await page.setViewportSize({ width: 1280, height: 1080 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForLoadState("domcontentloaded");
  // Override the wallet's hardcoded h-[600px] background so tall content
  // doesn't show a scrollbar in recordings.
  await page.addStyleTag({
    content: `
      #root > div { height: 100vh !important; min-height: 100vh !important; }
    `,
  });
  await page.bringToFront();
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
  await page.bringToFront();
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
  await page.bringToFront();
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
 * Switch the wallet's `lastSelectedNetwork` via the background SET_NETWORK
 * message. Network is selected by RECORDING_WALLET_NETWORK (defaults custom).
 * Without this, the home filters channels by the default network and the
 * channels we create for the recording never surface.
 */
export async function selectRecordingNetwork(page: Page): Promise<void> {
  const network = getRecordingWalletNetwork();
  await page.bringToFront();
  await page.evaluate(async (net) => {
    // The popup runs as a chrome-extension page, so chrome.runtime is bound
    // to the wallet's own background — no extension id required.
    const c = (globalThis as unknown as {
      chrome?: { runtime?: { sendMessage?: (m: unknown) => Promise<unknown> } };
    }).chrome;
    if (!c?.runtime?.sendMessage) {
      throw new Error("chrome.runtime.sendMessage not available in popup");
    }
    await c.runtime.sendMessage({ type: "SET_NETWORK", network: net });
  }, network);

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
  await page.bringToFront();
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

/** Toggle home from private to public view. */
export async function toggleToPublicView(page: Page): Promise<void> {
  await page.bringToFront();
  const toggle = page.locator(SEL.viewModeToggleByShield).first();
  if (await toggle.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await clickWithPause(toggle);
  }
  await page.locator(SEL.homePublicBalanceLabel).first().waitFor({
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
  await page.bringToFront();
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
 * the in-popup sign-request page → password → Approve). After connect, if
 * the wallet reports the entity is not yet APPROVED, complete the KYC step.
 */
export async function addAndConnectProvider(
  page: Page,
  opts: {
    providerUrl: string;
    providerName: string;
    providerPubkey: string;
    kycEntityName: string;
    password: string;
  },
): Promise<void> {
  await page.bringToFront();
  // Open the channel picker sheet (shows PrivateChannelManager).
  const trigger = page.locator(SEL.channelPickerTrigger).first();
  await clickWithPause(trigger);

  // Click "Add Provider" toggle (the dashed-border button at the bottom).
  const addToggle = page.locator(SEL.managerAddProviderToggle).first();
  await addToggle.waitFor({ timeout: 10_000 });
  await clickWithPause(addToggle);

  // Fill provider form (url + name + pubkey).
  await typeSlowly(
    page.locator(SEL.providerUrlInput).first(),
    opts.providerUrl,
  );
  await typeSlowly(
    page.locator(SEL.providerNameInput).first(),
    opts.providerName,
  );
  await typeSlowly(
    page.locator(SEL.providerPubkeyInput).first(),
    opts.providerPubkey,
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

  // After Approve the popup navigates back to home with the channel-picker
  // sheet closed. The KYC prompt lives inside that sheet, so re-open it,
  // then probe for the "Submit KYC" button and complete the form if shown.
  await page.locator(SEL.channelPickerTrigger).first().waitFor({
    timeout: 30_000,
  });
  await clickWithPause(page.locator(SEL.channelPickerTrigger).first());
  const kycButton = page.locator(SEL.submitKycButton).first();
  if (await kycButton.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await clickWithPause(kycButton);
    await typeSlowly(
      page.locator(SEL.kycNameInput).first(),
      opts.kycEntityName,
    );
    await typeSlowly(
      page.locator(SEL.kycPasswordInput).first(),
      opts.password,
    );
    // The button label is identical, but only the form's submit is enabled
    // when both inputs are filled — pick the enabled one.
    await clickWithPause(page.locator(SEL.submitKycButton).last());
  }
  // Close the sheet (whether the KYC step ran or not) so home (with
  // Receive/Send/Ramp) is in view and not blocked by the sheet overlay.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // Success: action buttons enable (Receive visible) and the header dot
  // turns green.
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
  await page.bringToFront();
  const preBalance = await readConfidentialBalance(page);
  await clickWithPause(page.locator(SEL.rampButton).first());

  // Defaults to deposit mode + Direct method.
  await typeSlowly(page.locator(SEL.rampAmountInput).first(), opts.amount);

  // Drop entropy from MEDIUM (5 CREATE ops) to LOW (1 CREATE op). The wallet's
  // default produces a Soroban call that costs ~100 XLM in resource fees on
  // testnet, exceeding the PP's source-account balance. LOW matches the
  // testnet/main.ts suite's bundle shape (1 DEPOSIT + 1 CREATE).
  const entropyTrigger = page
    .locator(
      'button:has-text("Medium"), button:has-text("Low"), button:has-text("High")',
    )
    .first();
  if (await entropyTrigger.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await clickWithPause(entropyTrigger);
    const lowOption = page.locator('[role="menuitemradio"]:has-text("Low")')
      .first();
    await lowOption.waitFor({ state: "visible", timeout: 5_000 });
    await clickWithPause(lowOption);
  }

  // Wait for the form to enable the Review button (validation can lag the
  // last keystroke). Targets the enabled instance directly.
  const reviewDeposit = page
    .locator(`${SEL.rampReviewDeposit}:not([disabled])`)
    .first();
  await reviewDeposit.waitFor({ state: "visible", timeout: 15_000 });
  await clickWithPause(reviewDeposit);

  // Review screen → Execute Transaction.
  const exec = page.locator("#deposit-execute-btn");
  await exec.waitFor({ state: "visible", timeout: 30_000 });
  await clickWithPause(exec);

  // The wallet's submitBundle polls until the bundle is COMPLETED on chain,
  // which on testnet can take ~60-180s. Popup only navigates home after that.
  await page.locator(SEL.receiveButton).first().waitFor({ timeout: 240_000 });
  const target = preBalance + parseFloat(opts.amount) - 0.01;
  await waitForConfidentialBalance(page, target);
  await holdAfterSuccess(page);
}

export interface SendOptions extends AmountOptions {
  /** Receiver MLXDR (multiline base64) — capture from showReceive on counterparty wallet. */
  receiverMlxdr: string;
}

/** Send to a counterparty whose Receive flow produced an MLXDR. */
export async function send(page: Page, opts: SendOptions): Promise<void> {
  await page.bringToFront();
  await clickWithPause(page.locator(SEL.sendButton).first());

  await typeSlowly(
    page.locator(SEL.sendMlxdrTextarea).first(),
    opts.receiverMlxdr,
    5,
  );
  await typeSlowly(page.locator(SEL.sendAmountInput).first(), opts.amount);

  // Send page uses pill buttons (Low/Medium/High/V.High) for privacy level
  // and already defaults to LOW. No override needed — keeping the Soroban
  // resource fee in the operator's budget on testnet.

  await clickWithPause(page.locator(SEL.sendReview).first());

  // Confirm Transfer page → Execute Transaction. Page has a dedicated id
  // (#send-execute-btn) on the Button, distinct from deposit/withdraw, so
  // we never match a stale (lazy-mounted) deposit-review Execute button.
  const exec = page.locator("#send-execute-btn");
  await exec.waitFor({ state: "visible", timeout: 30_000 });
  await clickWithPause(exec);

  // Success: navigates back to home with action buttons available.
  // Wallet polls bundle to COMPLETED before goHome — testnet may need 60-180s.
  await page.locator(SEL.receiveButton).first().waitFor({ timeout: 240_000 });
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
  await page.bringToFront();
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

  // Click the Copy button so the viewer sees "this is what the sender needs"
  // before we move on. Best-effort — skip if the button isn't surfaced.
  const copyBtn = page.locator(SEL.receiveCopyButton).first();
  if (await copyBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await clickWithPause(copyBtn);
  }

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

/**
 * Close the receive-confirmation page and return the wallet to the private
 * home view. Use after `showReceive` once the counterparty has finished
 * sending — leaving Bob on the confirmation page hides the home balance,
 * so `waitForConfidentialBalance` can't observe the incoming funds.
 */
export async function closeReceiveConfirmation(page: Page): Promise<void> {
  await page.bringToFront();
  await clickWithPause(page.locator('button:has-text("Close")').first());
  await page.locator(SEL.receiveButton).first().waitFor({ timeout: 30_000 });
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
  await page.bringToFront();
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

export async function waitForConfidentialBalanceAtMost(
  page: Page,
  maximumXlm: number,
  timeoutMs = 120_000,
): Promise<void> {
  await page.bringToFront();
  await page.locator(SEL.confidentialBalanceLabel).first().waitFor({
    timeout: 30_000,
  });
  await page.waitForFunction(
    (max: number) => {
      const labels = Array.from(document.querySelectorAll("p"));
      const label = labels.find((p) =>
        p.textContent?.trim() === "Confidential Balance"
      );
      if (!label) return false;
      const container = label.parentElement?.parentElement;
      const valueSpan = container?.querySelector(
        "span.text-4xl, span.text-5xl",
      );
      const text = valueSpan?.textContent?.trim() ?? "";
      const num = parseFloat(text);
      return Number.isFinite(num) && num <= max;
    },
    maximumXlm,
    { timeout: timeoutMs, polling: 1_000 },
  );
}

async function readConfidentialBalance(page: Page): Promise<number> {
  await page.locator(SEL.confidentialBalanceLabel).first().waitFor({
    timeout: 30_000,
  });
  const num = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll("p"));
    const label = labels.find((p) =>
      p.textContent?.trim() === "Confidential Balance"
    );
    if (!label) return NaN;
    const container = label.parentElement?.parentElement;
    const valueSpan = container?.querySelector(
      "span.text-4xl, span.text-5xl",
    );
    const text = valueSpan?.textContent?.trim() ?? "";
    return parseFloat(text);
  });
  return Number.isFinite(num) ? num : 0;
}

/** Withdraw via Ramp form (private → public). */
export async function withdraw(
  page: Page,
  opts: WithdrawOptions,
): Promise<void> {
  await page.bringToFront();
  const preBalance = await readConfidentialBalance(page);
  await clickWithPause(page.locator(SEL.rampButton).first());

  // Switch to withdraw tab.
  await clickWithPause(page.locator(SEL.rampWithdrawTab).first());

  await typeSlowly(
    page.locator(SEL.rampDestinationAddress).first(),
    opts.destinationAddress,
  );
  await typeSlowly(page.locator(SEL.rampAmountInput).first(), opts.amount);

  // Drop entropy from MEDIUM to LOW so the Soroban resource fee fits in
  // the operator account's budget on testnet.
  const entropyTrigger = page
    .locator(
      'button:has-text("Medium"), button:has-text("Low"), button:has-text("High")',
    )
    .first();
  if (await entropyTrigger.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await clickWithPause(entropyTrigger);
    const lowOption = page.locator('[role="menuitemradio"]:has-text("Low")')
      .first();
    await lowOption.waitFor({ state: "visible", timeout: 5_000 });
    await clickWithPause(lowOption);
  }

  await clickWithPause(page.locator(SEL.rampReviewWithdraw).first());

  const exec = page.locator("#withdraw-execute-btn");
  await exec.waitFor({ state: "visible", timeout: 15_000 });
  await clickWithPause(exec);

  // Wallet polls bundle to COMPLETED before goHome — testnet may need 60-180s.
  await page.locator(SEL.receiveButton).first().waitFor({ timeout: 240_000 });
  const target = preBalance - parseFloat(opts.amount) + 0.01;
  await waitForConfidentialBalanceAtMost(page, target);
  await holdAfterSuccess(page);
}
