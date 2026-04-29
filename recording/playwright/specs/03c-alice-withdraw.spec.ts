/**
 * Section 03c — Alice withdraws funds back to her public Stellar account.
 *
 * Re-onboards from scratch (each spec is its own Playwright invocation).
 * Each section runs in an isolated userDataDir, so private-side balance
 * doesn't carry over from 03a — we do a small deposit first to seed
 * balance, then record the withdraw flow itself. Withdraw destination
 * defaults to ALICE_PK.
 */
import { test } from "@playwright/test";
import { loadRunEnv, requireValue } from "../helpers/run-env";
import {
  closeWalletContext,
  launchWalletContext,
} from "../fixtures/wallet-context";
import {
  addAndConnectProvider,
  createPrivacyChannel,
  deposit,
  findBrowserWalletExtensionId,
  onboardWithMnemonic,
  openWalletPopup,
  selectCustomNetwork,
  toggleToPrivateView,
  waitForConfidentialBalance,
  withdraw,
} from "../fixtures/browser-wallet";

const RECORDING_PASSWORD = "recording";

test.describe.configure({ mode: "serial" });

test("03c — Alice withdraw", async () => {
  const env = loadRunEnv();
  const channelId = requireValue(env, "PRIVACY_CHANNEL_ID");

  const handle = await launchWalletContext({
    section: "03c",
    runId: env.RUN_ID,
    profileName: "alice-c",
  });

  try {
    const extensionId = await findBrowserWalletExtensionId(handle.context);
    const wallet = await openWalletPopup(handle.context, extensionId);

    await onboardWithMnemonic(wallet, {
      password: RECORDING_PASSWORD,
      mnemonic: env.ALICE_MNEMONIC,
    });

    await selectCustomNetwork(wallet);

    await toggleToPrivateView(wallet);

    await createPrivacyChannel(wallet, {
      contractId: channelId,
      channelName: "Moonlight Demo Council",
      network: "Custom",
      assetCode: "XLM",
    });

    await addAndConnectProvider(wallet, {
      providerUrl: env.PROVIDER_PLATFORM_URL,
      providerName: "Acme Privacy Provider",
      password: RECORDING_PASSWORD,
    });

    // Seed private balance so the withdraw has something to consume.
    // Each section is isolated, so 03a's deposit doesn't carry over. The
    // deposit UI returns home as soon as the tx is *submitted*, so we
    // explicitly poll for the on-chain confirmation before withdrawing.
    await deposit(wallet, { amount: "100" });
    await waitForConfidentialBalance(wallet, 71);

    await withdraw(wallet, {
      amount: "70",
      destinationAddress: env.ALICE_PK,
    });
  } finally {
    await closeWalletContext(handle);
  }
});
