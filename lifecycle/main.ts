import { Keypair } from "stellar-sdk";
import type { ContractId } from "@colibri/core";
import type { Config } from "../e2e/config.ts";
import { loadConfig } from "./config.ts";
import { createServer } from "./soroban.ts";
import {
  deployChannelAuth,
  deployPrivacyChannel,
  getOrDeployNativeSac,
  uploadWasm,
} from "./deploy.ts";
import { addProvider, removeProvider } from "./admin.ts";
import { extractEvents, verifyEvent } from "./events.ts";
import { startProvider, type ProviderInstance } from "./provider.ts";

// Existing E2E modules for the payment flow
import { authenticate } from "../e2e/auth.ts";
import { deposit } from "../e2e/deposit.ts";
import { prepareReceive } from "../e2e/receive.ts";
import { send } from "../e2e/send.ts";
import { withdraw } from "../e2e/withdraw.ts";

const DEPOSIT_AMOUNT = 10; // XLM
const SEND_AMOUNT = 5; // XLM
const WITHDRAW_AMOUNT = 4; // XLM

const DEPLOYMENT_PATH = new URL("./deployment.json", import.meta.url).pathname;

async function fundAccount(
  friendbotUrl: string,
  publicKey: string,
): Promise<void> {
  const res = await fetch(`${friendbotUrl}?addr=${publicKey}`);
  if (!res.ok) {
    throw new Error(
      `Friendbot failed for ${publicKey}: ${res.status} ${await res.text()}`,
    );
  }
}

async function main() {
  const startTime = Date.now();
  const config = loadConfig();
  let providerInstance: ProviderInstance | null = null;

  console.log("\n=== Moonlight Protocol — Full Lifecycle E2E ===\n");

  try {
    // ── Setup ──────────────────────────────────────────────────────
    console.log("[setup] Initializing...");
    const server = createServer(config.rpcUrl, config.allowHttp);
    console.log(`  Network: ${config.networkPassphrase}`);
    console.log(`  RPC:     ${config.rpcUrl}`);

    const admin = Keypair.random();
    const provider = Keypair.random();
    const treasury = Keypair.random();
    console.log(`  Admin:    ${admin.publicKey()}`);
    console.log(`  Provider: ${provider.publicKey()}`);
    console.log(`  Treasury: ${treasury.publicKey()}`);

    console.log("\n[setup] Funding accounts...");
    await fundAccount(config.friendbotUrl, admin.publicKey());
    console.log("  Admin funded");
    await fundAccount(config.friendbotUrl, treasury.publicKey());
    console.log("  Treasury funded");

    // ── Step 1: Deploy Council (Channel Auth) ──────────────────────
    console.log("\n[1/7] Deploy Council (Channel Auth)");
    const channelAuthWasm = await Deno.readFile(config.channelAuthWasmPath);
    const channelAuthHash = await uploadWasm(
      server,
      admin,
      config.networkPassphrase,
      channelAuthWasm,
    );
    const { contractId: channelAuthId, txResponse: authDeployTx } =
      await deployChannelAuth(
        server,
        admin,
        config.networkPassphrase,
        channelAuthHash,
      );

    const deployEvents = extractEvents(authDeployTx);
    const initResult = verifyEvent(deployEvents, "ContractInitialized", true);
    if (initResult.found) console.log("  ContractInitialized event verified");

    // ── Step 2: Deploy Channel (Privacy Channel) ──────────────────
    console.log("\n[2/7] Deploy Channel (Privacy Channel)");
    console.log("  Deploying native XLM SAC...");
    const assetContractId = await getOrDeployNativeSac(
      server,
      admin,
      config.networkPassphrase,
    );

    const privacyChannelWasm = await Deno.readFile(
      config.privacyChannelWasmPath,
    );
    const privacyChannelHash = await uploadWasm(
      server,
      admin,
      config.networkPassphrase,
      privacyChannelWasm,
    );
    const channelContractId = await deployPrivacyChannel(
      server,
      admin,
      config.networkPassphrase,
      privacyChannelHash,
      channelAuthId,
      assetContractId,
    );

    // ── Step 3: Add Privacy Provider ──────────────────────────────
    console.log("\n[3/7] Add Privacy Provider");
    const addTx = await addProvider(
      server,
      admin,
      config.networkPassphrase,
      channelAuthId,
      provider.publicKey(),
    );

    const addEvents = extractEvents(addTx);
    const addResult = verifyEvent(addEvents, "ProviderAdded", true);
    if (addResult.found) console.log("  ProviderAdded event verified");

    // ── Start provider-platform for payment flow ──────────────────
    let providerUrl: string;
    if (config.providerUrl) {
      // Use externally-managed provider
      providerUrl = config.providerUrl;
      console.log(`\n[provider] Using existing provider at ${providerUrl}`);
    } else {
      // Start a fresh provider configured for these contracts
      console.log("\n[provider] Starting provider-platform...");
      providerInstance = await startProvider({
        providerPlatformPath: config.providerPlatformPath,
        rpcUrl: config.rpcUrl,
        channelContractId,
        channelAuthId,
        assetContractId,
        providerSecretKey: provider.secret(),
        treasuryPublicKey: treasury.publicKey(),
        treasurySecretKey: treasury.secret(),
      });
      providerUrl = providerInstance.url;
    }

    // Build a Config compatible with the existing E2E modules
    const e2eConfig: Config = {
      networkPassphrase: config.networkPassphrase,
      rpcUrl: config.rpcUrl,
      horizonUrl: config.horizonUrl,
      friendbotUrl: config.friendbotUrl,
      providerUrl,
      channelContractId: channelContractId as ContractId,
      channelAuthId: channelAuthId as ContractId,
      channelAssetContractId: assetContractId as ContractId,
      networkConfig: config.networkConfig,
      networkId: config.networkId,
      providerSecretKey: provider.secret(),
    };

    const alice = Keypair.random();
    const bob = Keypair.random();
    console.log(`\n  Alice: ${alice.publicKey()}`);
    console.log(`  Bob:   ${bob.publicKey()}`);

    await fundAccount(config.friendbotUrl, alice.publicKey());
    await fundAccount(config.friendbotUrl, bob.publicKey());
    console.log("  Users funded");

    // ── Step 4: Deposit ──────────────────────────────────────────
    console.log(`\n[4/7] Deposit (${DEPOSIT_AMOUNT} XLM)`);
    const aliceJwt = await authenticate(alice, e2eConfig);
    console.log("  Alice authenticated");
    await deposit(alice.secret(), DEPOSIT_AMOUNT, aliceJwt, e2eConfig);
    console.log("  Deposit complete");

    // ── Step 5: Send ─────────────────────────────────────────────
    console.log(`\n[5/7] Send (${SEND_AMOUNT} XLM)`);
    const bobJwt = await authenticate(bob, e2eConfig);
    console.log("  Bob authenticated");
    const receiverOps = await prepareReceive(
      bob.secret(),
      SEND_AMOUNT,
      e2eConfig,
    );
    await send(
      alice.secret(),
      receiverOps,
      SEND_AMOUNT,
      aliceJwt,
      e2eConfig,
    );
    console.log("  Send complete");

    // ── Step 6: Withdraw ─────────────────────────────────────────
    console.log(`\n[6/7] Withdraw (${WITHDRAW_AMOUNT} XLM)`);
    await withdraw(
      bob.secret(),
      bob.publicKey(),
      WITHDRAW_AMOUNT,
      bobJwt,
      e2eConfig,
    );
    console.log("  Withdraw complete");

    // ── Step 7: Remove Privacy Provider ──────────────────────────
    console.log("\n[7/7] Remove Privacy Provider");
    const removeTx = await removeProvider(
      server,
      admin,
      config.networkPassphrase,
      channelAuthId,
      provider.publicKey(),
    );

    const removeEvents = extractEvents(removeTx);
    const removeResult = verifyEvent(removeEvents, "ProviderRemoved", true);
    if (removeResult.found) console.log("  ProviderRemoved event verified");

    // ── Summary ──────────────────────────────────────────────────
    const deployment = {
      channelAuthId,
      channelContractId,
      assetContractId,
      adminPublicKey: admin.publicKey(),
      providerPublicKey: provider.publicKey(),
      treasuryPublicKey: treasury.publicKey(),
    };
    await Deno.writeTextFile(
      DEPLOYMENT_PATH,
      JSON.stringify(deployment, null, 2),
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log("\n────────────────────────────────────────────────");
    console.log("  Contract IDs:");
    console.log(`    XLM SAC:         ${assetContractId}`);
    console.log(`    Channel Auth:    ${channelAuthId}`);
    console.log(`    Privacy Channel: ${channelContractId}`);
    console.log(`  Config written to: ${DEPLOYMENT_PATH}`);
    console.log(`\n=== Lifecycle E2E passed in ${elapsed}s ===`);
  } finally {
    // Always clean up the provider
    if (providerInstance) {
      console.log("\n[cleanup] Stopping provider-platform...");
      await providerInstance.stop();
      console.log("  Cleaned up");
    }
  }
}

main().catch((err) => {
  console.error("\n=== Lifecycle E2E FAILED ===");
  console.error(err);
  Deno.exit(1);
});
