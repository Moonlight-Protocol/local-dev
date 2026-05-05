/**
 * Section 03 — Private transfer (Bob + Alice in one continuous flow).
 *
 * Demo beats:
 *   1. Bob onboards browser-wallet, joins channel, adds provider
 *   2. Bob navigates to Receive, generates an MLXDR, leaves the wallet open
 *   3. Alice onboards her browser-wallet (Bob's wallet stays alive)
 *   4. Alice deposits 100 XLM (waits for the deposit to actually land)
 *   5. Alice sends 25 XLM to Bob using the MLXDR
 *   6. Bob's confidential balance updates to 25 XLM on screen
 *   7. Alice withdraws 70 XLM back to her public account
 */
import { test } from "@playwright/test";
import { loadRunEnv, requireValue } from "../helpers/run-env";
import {
  closeWalletContext,
  launchWalletContext,
} from "../fixtures/wallet-context";
import {
  addAndConnectProvider,
  closeReceiveConfirmation,
  createPrivacyChannel,
  deposit,
  findBrowserWalletExtensionId,
  onboardWithMnemonic,
  openWalletPopup,
  selectCustomNetwork,
  send,
  showReceive,
  toggleToPrivateView,
  waitForConfidentialBalance,
  withdraw,
} from "../fixtures/browser-wallet";

const RECORDING_PASSWORD = "recording";

test.describe.configure({ mode: "serial" });

test("03 — private transfer (Bob receive → Alice deposit + send → Alice withdraw)", async () => {
  const env = loadRunEnv();
  const channelId = requireValue(env, "PRIVACY_CHANNEL_ID");

  const bobHandle = await launchWalletContext({
    section: "03-bob",
    runId: env.RUN_ID,
    profileName: "bob",
  });

  let aliceHandle: Awaited<ReturnType<typeof launchWalletContext>> | undefined;

  try {
    const bobExtensionId = await findBrowserWalletExtensionId(bobHandle.context);
    const bobWallet = await openWalletPopup(bobHandle.context, bobExtensionId);

    await onboardWithMnemonic(bobWallet, {
      password: RECORDING_PASSWORD,
      mnemonic: env.BOB_MNEMONIC,
    });
    await selectCustomNetwork(bobWallet);
    await toggleToPrivateView(bobWallet);
    await createPrivacyChannel(bobWallet, {
      contractId: channelId,
      channelName: "Moonlight Demo",
      network: "Custom",
      assetCode: "XLM",
    });
    await addAndConnectProvider(bobWallet, {
      providerUrl: env.PROVIDER_PLATFORM_URL,
      providerName: "Acme Privacy Provider",
      password: RECORDING_PASSWORD,
    });

    const bobMlxdr = await showReceive(bobWallet, { amount: "25" });
    if (!bobMlxdr || bobMlxdr.trim().length === 0) {
      throw new Error("Bob's MLXDR was not captured");
    }

    aliceHandle = await launchWalletContext({
      section: "03-alice",
      runId: env.RUN_ID,
      profileName: "alice",
    });

    const aliceExtensionId = await findBrowserWalletExtensionId(
      aliceHandle.context,
    );
    const aliceWallet = await openWalletPopup(
      aliceHandle.context,
      aliceExtensionId,
    );

    await onboardWithMnemonic(aliceWallet, {
      password: RECORDING_PASSWORD,
      mnemonic: env.ALICE_MNEMONIC,
    });
    await selectCustomNetwork(aliceWallet);
    await toggleToPrivateView(aliceWallet);
    await createPrivacyChannel(aliceWallet, {
      contractId: channelId,
      channelName: "Moonlight Demo",
      network: "Custom",
      assetCode: "XLM",
    });
    await addAndConnectProvider(aliceWallet, {
      providerUrl: env.PROVIDER_PLATFORM_URL,
      providerName: "Acme Privacy Provider",
      password: RECORDING_PASSWORD,
    });

    await deposit(aliceWallet, { amount: "100" });

    await send(aliceWallet, {
      receiverMlxdr: bobMlxdr,
      amount: "25",
    });

    // Bob has been on the receive-confirmation page during Alice's send (nice
    // "waiting for funds" beat). Close it so the home view is what we observe
    // when the confidential balance lands.
    await closeReceiveConfirmation(bobWallet);
    await waitForConfidentialBalance(bobWallet, 24.99);

    await withdraw(aliceWallet, {
      amount: "70",
      destinationAddress: env.ALICE_PK,
    });
  } finally {
    if (aliceHandle) await closeWalletContext(aliceHandle);
    await closeWalletContext(bobHandle);
  }
});
