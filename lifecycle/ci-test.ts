/**
 * CI Test phase — runs inside docker-compose after setup + provider are ready.
 * Reads config from /config, runs payment flow (steps 4-6), removes provider (step 7).
 */
import { Keypair } from "stellar-sdk";
import { NetworkConfig, type ContractId } from "@colibri/core";
import type { StellarNetworkId } from "@moonlight/moonlight-sdk";
import type { Config } from "../e2e/config.ts";
import { createServer } from "./soroban.ts";
import { removeProvider } from "./admin.ts";
import { extractEvents, verifyEvent } from "./events.ts";
import { authenticate } from "../e2e/auth.ts";
import { deposit } from "../e2e/deposit.ts";
import { prepareReceive } from "../e2e/receive.ts";
import { send } from "../e2e/send.ts";
import { withdraw } from "../e2e/withdraw.ts";

const RPC_URL = Deno.env.get("STELLAR_RPC_URL")!;
const FRIENDBOT_URL = Deno.env.get("FRIENDBOT_URL")!;
const PROVIDER_URL = Deno.env.get("PROVIDER_URL")!;
const NETWORK_PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ??
  "Standalone Network ; February 2017";
const CONFIG_DIR = Deno.env.get("CONFIG_DIR") ?? "/config";

const DEPOSIT_AMOUNT = 10;
const SEND_AMOUNT = 5;
const WITHDRAW_AMOUNT = 4;

function loadEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  const content = Deno.readTextFileSync(path);
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

async function fundAccount(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!res.ok) {
    throw new Error(
      `Friendbot failed for ${publicKey}: ${res.status} ${await res.text()}`,
    );
  }
}

async function main() {
  const startTime = Date.now();

  console.log("[ci-test] Loading config...");
  const contracts = loadEnvFile(`${CONFIG_DIR}/contracts.env`);
  const channelContractId = contracts["CHANNEL_CONTRACT_ID"];
  const channelAuthId = contracts["CHANNEL_AUTH_ID"];
  const assetContractId = contracts["CHANNEL_ASSET_CONTRACT_ID"];
  const providerSecretKey = contracts["PROVIDER_SK"];
  const adminSecretKey = contracts["ADMIN_SK"];

  console.log(`  Channel:  ${channelContractId}`);
  console.log(`  Auth:     ${channelAuthId}`);
  console.log(`  Asset:    ${assetContractId}`);
  console.log(`  Provider: ${PROVIDER_URL}`);

  const horizonUrl = RPC_URL.replace("/soroban/rpc", "");
  const networkConfig = NetworkConfig.CustomNet({
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    horizonUrl,
    friendbotUrl: FRIENDBOT_URL,
    allowHttp: true,
  });

  const e2eConfig: Config = {
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    horizonUrl,
    friendbotUrl: FRIENDBOT_URL,
    providerUrl: PROVIDER_URL,
    channelContractId: channelContractId as ContractId,
    channelAuthId: channelAuthId as ContractId,
    channelAssetContractId: assetContractId as ContractId,
    networkConfig,
    networkId: NETWORK_PASSPHRASE as StellarNetworkId,
    providerSecretKey,
  };

  const alice = Keypair.random();
  const bob = Keypair.random();
  console.log(`  Alice: ${alice.publicKey()}`);
  console.log(`  Bob:   ${bob.publicKey()}`);

  await fundAccount(alice.publicKey());
  await fundAccount(bob.publicKey());
  console.log("  Users funded");

  // Step 4: Deposit
  console.log(`\n[4/7] Deposit (${DEPOSIT_AMOUNT} XLM)`);
  const aliceJwt = await authenticate(alice, e2eConfig);
  console.log("  Alice authenticated");
  await deposit(alice.secret(), DEPOSIT_AMOUNT, aliceJwt, e2eConfig);
  console.log("  Deposit complete");

  // Step 5: Send
  console.log(`\n[5/7] Send (${SEND_AMOUNT} XLM)`);
  const bobJwt = await authenticate(bob, e2eConfig);
  console.log("  Bob authenticated");
  const receiverOps = await prepareReceive(bob.secret(), SEND_AMOUNT, e2eConfig);
  await send(alice.secret(), receiverOps, SEND_AMOUNT, aliceJwt, e2eConfig);
  console.log("  Send complete");

  // Step 6: Withdraw
  console.log(`\n[6/7] Withdraw (${WITHDRAW_AMOUNT} XLM)`);
  await withdraw(
    bob.secret(), bob.publicKey(), WITHDRAW_AMOUNT, bobJwt, e2eConfig,
  );
  console.log("  Withdraw complete");

  // Step 7: Remove provider
  console.log("\n[7/7] Remove Privacy Provider");
  const admin = Keypair.fromSecret(adminSecretKey);
  const server = createServer(RPC_URL);
  const removeTx = await removeProvider(
    server,
    admin,
    NETWORK_PASSPHRASE,
    channelAuthId,
    Keypair.fromSecret(providerSecretKey).publicKey(),
  );
  const removeEvents = extractEvents(removeTx);
  const removeResult = verifyEvent(removeEvents, "ProviderRemoved", true);
  if (removeResult.found) console.log("  ProviderRemoved event verified");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Lifecycle E2E passed in ${elapsed}s ===`);
}

main().catch((err) => {
  console.error("\n=== Lifecycle E2E FAILED ===");
  console.error(err);
  Deno.exit(1);
});
