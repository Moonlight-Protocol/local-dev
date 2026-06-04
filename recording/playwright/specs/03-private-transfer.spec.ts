/**
 * Section 03 — Private transfer (Bob + Alice in one continuous flow).
 *
 * Each user runs through TWO browser-wallet passes:
 *   Pass 1 — onboard → Freighter → network → channel → add provider + connect
 *             → followKycLinkOut. KYC submission happens here, leaving the
 *             user's entity APPROVED for this PP on the provider-platform.
 *             Context is torn down at the end of pass 1.
 *   Pass 2 — fresh context, redo onboard → Freighter → network → channel →
 *             add provider + connect. Same mnemonic = same account, so the
 *             PP's verify response carries entityStatus=APPROVED and the
 *             KYC link-out is not surfaced. Pass 2's wallet drives the
 *             remaining demo beats (receive / send / withdraw).
 *
 * Demo beats:
 *   1. Bob (pass 1) onboards + submits KYC, then closes
 *   2. Bob (pass 2) re-onboards, navigates to Receive, generates an MLXDR
 *   3. Alice (pass 1) onboards + submits KYC, then closes
 *   4. Alice (pass 2) re-onboards, deposits 100 XLM
 *   5. Alice sends 25 XLM to Bob using the MLXDR
 *   6. Bob's confidential balance updates to 25 XLM on screen
 *   7. Bob withdraws 20 XLM back to his public account
 */
import { type Page, test } from "@playwright/test";
import { loadRunEnv, requireValue, type RunEnv } from "../helpers/run-env";
import { getProviderName } from "../helpers/run-variants";
import {
  closeWalletContext,
  launchWalletContext,
  type WalletContextHandle,
} from "../fixtures/wallet-context";
import { setupFreighterForKyc } from "../fixtures/freighter-setup";
import {
  addProviderAndConnect,
  closeReceiveConfirmation,
  createPrivacyChannel,
  deposit,
  findBrowserWalletExtensionId,
  followKycLinkOut,
  getRecordingChannelLabel,
  onboardWithMnemonic,
  openWalletPopup,
  selectRecordingNetwork,
  send,
  showReceive,
  toggleToPrivateView,
  toggleToPublicView,
  waitForConfidentialBalance,
  withdraw,
} from "../fixtures/browser-wallet";

const RECORDING_PASSWORD = "recording";
// Freighter rejects short/weak passwords. The recording browser-wallet
// password stays short ("recording") so on-screen typing reads cleanly in
// the demo; Freighter (which only signs the KYC nonce, no demo presence)
// gets a stronger one.
const FREIGHTER_PASSWORD = "What-a-useless-req";

test.describe.configure({ mode: "serial" });

interface UserSetup {
  handle: WalletContextHandle;
  wallet: Page;
}

interface UserSetupOpts {
  section: string;
  profileName: string;
  runId: string;
  mnemonic: string;
  secretKey: string;
  channelContractId: string;
  providerUrl: string;
  providerLabel: string;
}

async function setupUser(opts: UserSetupOpts): Promise<UserSetup> {
  const handle = await launchWalletContext({
    section: opts.section,
    runId: opts.runId,
    profileName: opts.profileName,
  });
  const extensionId = await findBrowserWalletExtensionId(handle.context);
  const wallet = await openWalletPopup(handle.context, extensionId);
  await onboardWithMnemonic(wallet, {
    password: RECORDING_PASSWORD,
    mnemonic: opts.mnemonic,
  });
  await setupFreighterForKyc(handle.context, {
    secretKey: opts.secretKey,
    password: FREIGHTER_PASSWORD,
  });
  await selectRecordingNetwork(wallet);
  await toggleToPrivateView(wallet);
  await createPrivacyChannel(wallet, {
    contractId: opts.channelContractId,
    channelName: "Moonlight Demo",
    network: getRecordingChannelLabel(),
    assetCode: "XLM",
  });
  await addProviderAndConnect(wallet, {
    providerUrl: opts.providerUrl,
    providerName: opts.providerLabel,
    password: RECORDING_PASSWORD,
  });
  return { handle, wallet };
}

test("03 — private transfer (Bob receive → Alice deposit + send → Alice withdraw)", async () => {
  const env: RunEnv = loadRunEnv();
  const channelId = requireValue(env, "PRIVACY_CHANNEL_ID");
  const councilId = requireValue(env, "CHANNEL_AUTH_ID");

  // env.PP_PK is the operator pubkey from setup-recording-keys. The PP that
  // spec 02 registered with the platform has its own server-derived pubkey,
  // which is what /providers/:ppPublicKey/... URLs use. Look it up via the
  // council-platform's public listing, matching on the spec-02 label.
  const providerLabel = getProviderName();
  const provListRes = await fetch(
    `${env.COUNCIL_PLATFORM_URL}/api/v1/public/providers?councilId=${councilId}`,
  );
  if (!provListRes.ok) {
    throw new Error(
      `Failed to list providers: HTTP ${provListRes.status}`,
    );
  }
  const provListBody = await provListRes.json() as {
    data?: { publicKey: string; label: string }[];
  };
  const match = provListBody.data?.find((p) => p.label === providerLabel);
  if (!match?.publicKey) {
    throw new Error(
      `Could not find provider "${providerLabel}" on council ${councilId}`,
    );
  }
  const providerPubkey = match.publicKey;
  const providerUrl = `${
    env.PROVIDER_PLATFORM_URL.replace(/\/$/, "")
  }/${providerPubkey}`;

  const bobSetupOpts = {
    runId: env.RUN_ID,
    mnemonic: env.BOB_MNEMONIC,
    secretKey: env.BOB_SK,
    channelContractId: channelId,
    providerUrl,
    providerLabel,
  };
  const aliceSetupOpts = {
    runId: env.RUN_ID,
    mnemonic: env.ALICE_MNEMONIC,
    secretKey: env.ALICE_SK,
    channelContractId: channelId,
    providerUrl,
    providerLabel,
  };

  // ── Bob pass 1: full setup + KYC submission, then tear down. ──
  const bobPass1 = await setupUser({
    section: "03-bob-pass1",
    profileName: "bob-pass1",
    ...bobSetupOpts,
  });
  await followKycLinkOut(bobPass1.wallet, {
    kycEntityName: "Bob",
    password: RECORDING_PASSWORD,
  });
  await closeWalletContext(bobPass1.handle);

  // ── Bob pass 2: fresh context, redo setup (no KYC — already APPROVED),
  //    then continue with the demo. ──
  const bob = await setupUser({
    section: "03-bob",
    profileName: "bob",
    ...bobSetupOpts,
  });
  let aliceHandle: WalletContextHandle | undefined;

  try {
    const bobMlxdr = await showReceive(bob.wallet, { amount: "25" });
    if (!bobMlxdr || bobMlxdr.trim().length === 0) {
      throw new Error("Bob's MLXDR was not captured");
    }

    // ── Alice pass 1: full setup + KYC submission, then tear down. ──
    const alicePass1 = await setupUser({
      section: "03-alice-pass1",
      profileName: "alice-pass1",
      ...aliceSetupOpts,
    });
    await followKycLinkOut(alicePass1.wallet, {
      kycEntityName: "Alice",
      password: RECORDING_PASSWORD,
    });
    await closeWalletContext(alicePass1.handle);

    // ── Alice pass 2: fresh context, redo setup (no KYC), continue. ──
    const alice = await setupUser({
      section: "03-alice",
      profileName: "alice",
      ...aliceSetupOpts,
    });
    aliceHandle = alice.handle;

    await deposit(alice.wallet, { amount: "100" });

    await send(alice.wallet, {
      receiverMlxdr: bobMlxdr,
      amount: "25",
    });

    await closeReceiveConfirmation(bob.wallet);
    await waitForConfidentialBalance(bob.wallet, 24.99);

    await withdraw(bob.wallet, {
      amount: "20",
      destinationAddress: env.BOB_PK,
    });

    await toggleToPublicView(alice.wallet);
    await toggleToPublicView(bob.wallet);
  } finally {
    if (aliceHandle) await closeWalletContext(aliceHandle);
    await closeWalletContext(bob.handle);
  }
});
