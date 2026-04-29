/**
 * Section 03b — Bob onboards, generates a receive address (MLXDR).
 *
 * Saves BOB_MLXDR to run.env so a subsequent Section 03a invocation can
 * paste it into Alice's Send form.
 */
import { test } from "@playwright/test";
import { loadRunEnv, requireValue, writeRunArtifact } from "../helpers/run-env";
import {
  closeWalletContext,
  launchWalletContext,
} from "../fixtures/wallet-context";
import {
  addAndConnectProvider,
  createPrivacyChannel,
  findBrowserWalletExtensionId,
  onboardWithMnemonic,
  openWalletPopup,
  selectCustomNetwork,
  showReceive,
  toggleToPrivateView,
} from "../fixtures/browser-wallet";

const RECORDING_PASSWORD = "recording";

test.describe.configure({ mode: "serial" });

test("03b — Bob receive", async () => {
  const env = loadRunEnv();
  const channelId = requireValue(env, "PRIVACY_CHANNEL_ID");

  const handle = await launchWalletContext({
    section: "03b",
    runId: env.RUN_ID,
    profileName: "bob",
  });

  try {
    const extensionId = await findBrowserWalletExtensionId(handle.context);
    const wallet = await openWalletPopup(handle.context, extensionId);

    await onboardWithMnemonic(wallet, {
      password: RECORDING_PASSWORD,
      mnemonic: env.BOB_MNEMONIC,
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

    const mlxdr = await showReceive(wallet, { amount: "25" });
    if (mlxdr) {
      writeRunArtifact("bob-mlxdr", mlxdr);
    }
  } finally {
    await closeWalletContext(handle);
  }
});
