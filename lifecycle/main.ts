import { Keypair } from "stellar-sdk";
import postgres from "postgres";
import { type ContractId, NetworkConfig } from "@colibri/core";
import type { StellarNetworkId } from "@moonlight/moonlight-sdk";
import { createServer } from "../lib/soroban.ts";
import {
  deployChannelAuth,
  deployPrivacyChannel,
  getOrDeployNativeSac,
  uploadWasm,
} from "../lib/deploy.ts";
import { addProvider, removeProvider } from "../lib/admin.ts";
import { extractEvents, verifyEvent } from "../lib/events.ts";

import { authenticate } from "../e2e/auth.ts";
import { deposit } from "../e2e/deposit.ts";
import { prepareReceive } from "../e2e/receive.ts";
import { send } from "../e2e/send.ts";
import { withdraw } from "../e2e/withdraw.ts";

import type { Config } from "../e2e/config.ts";

const DEPOSIT_AMOUNT = 10; // XLM
const SEND_AMOUNT = 5; // XLM
const WITHDRAW_AMOUNT = 4; // XLM

// Environment — provided by docker-compose or local runner
const RPC_URL = Deno.env.get("STELLAR_RPC_URL") ??
  "http://localhost:8000/soroban/rpc";
const NETWORK_PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ??
  "Standalone Network ; February 2017";
const FRIENDBOT_URL = Deno.env.get("FRIENDBOT_URL") ??
  "http://localhost:8000/friendbot";
const PROVIDER_URL = Deno.env.get("PROVIDER_URL") ?? "http://localhost:3000";
const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgresql://admin:devpass@db:5432/provider_platform_db";
const WASM_DIR = Deno.env.get("WASM_DIR") ?? "/wasms";

async function waitForFriendbot(): Promise<void> {
  console.log("[setup] Waiting for Friendbot...");
  for (let i = 0; i < 180; i++) {
    try {
      const res = await fetch(
        `${FRIENDBOT_URL}?addr=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF`,
      );
      if (res.status === 200 || res.status === 400) {
        console.log(`  Friendbot is ready (${i}s).`);
        return;
      }
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Friendbot did not become ready after 180s");
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

  console.log("\n=== Moonlight Protocol — Full Lifecycle E2E ===\n");

  const server = createServer(RPC_URL);
  const horizonUrl = RPC_URL.replace("/soroban/rpc", "");

  await waitForFriendbot();

  // ── Generate & fund accounts ──────────────────────────────────
  const admin = Keypair.random();
  const provider = Keypair.random();
  const treasury = Keypair.random();
  console.log("[setup] Accounts");
  console.log(`  Admin:    ${admin.publicKey()}`);
  console.log(`  Provider: ${provider.publicKey()}`);
  console.log(`  Treasury: ${treasury.publicKey()}`);

  console.log("\n[setup] Funding accounts...");
  await fundAccount(admin.publicKey());
  console.log("  Admin funded");
  await fundAccount(provider.publicKey());
  console.log("  Provider funded");
  await fundAccount(treasury.publicKey());
  console.log("  Treasury funded");

  // ── Step 1: Deploy Council (Channel Auth) ────────────────────
  console.log("\n[1/7] Deploy Council (Channel Auth)");
  const channelAuthWasm = await Deno.readFile(
    `${WASM_DIR}/channel_auth_contract.wasm`,
  );
  const channelAuthHash = await uploadWasm(
    server,
    admin,
    NETWORK_PASSPHRASE,
    channelAuthWasm,
  );
  const { contractId: channelAuthId, txResponse: authDeployTx } =
    await deployChannelAuth(server, admin, NETWORK_PASSPHRASE, channelAuthHash);

  const deployEvents = extractEvents(authDeployTx);
  const initResult = verifyEvent(deployEvents, "contract_initialized", true);
  if (initResult.found) console.log("  contract_initialized event verified");

  // ── Step 2: Deploy Channel (Privacy Channel) ─────────────────
  console.log("\n[2/7] Deploy Channel (Privacy Channel)");
  console.log("  Deploying native XLM SAC...");
  const assetContractId = await getOrDeployNativeSac(
    server,
    admin,
    NETWORK_PASSPHRASE,
  );

  const privacyChannelWasm = await Deno.readFile(
    `${WASM_DIR}/privacy_channel.wasm`,
  );
  const privacyChannelHash = await uploadWasm(
    server,
    admin,
    NETWORK_PASSPHRASE,
    privacyChannelWasm,
  );
  const channelContractId = await deployPrivacyChannel(
    server,
    admin,
    NETWORK_PASSPHRASE,
    privacyChannelHash,
    channelAuthId,
    assetContractId,
  );

  // ── Step 3: Add Privacy Provider ─────────────────────────────
  console.log("\n[3/7] Add Privacy Provider");
  const addTx = await addProvider(
    server,
    admin,
    NETWORK_PASSPHRASE,
    channelAuthId,
    provider.publicKey(),
  );

  const addEvents = extractEvents(addTx);
  const addResult = verifyEvent(addEvents, "provider_added", true);
  if (addResult.found) console.log("  provider_added event verified");

  // ── Register PP via API + seed DB ─────────────────────────────
  console.log("\n[infra] Registering PP and seeding DB...");
  const { Buffer } = await import("buffer");
  const challengeRes =
    await (await fetch(`${PROVIDER_URL}/api/v1/dashboard/auth/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: provider.publicKey() }),
    })).json();
  const sig = Buffer.from(
    provider.sign(Buffer.from(challengeRes.data.nonce, "base64")),
  ).toString("base64");
  const verifyRes =
    await (await fetch(`${PROVIDER_URL}/api/v1/dashboard/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nonce: challengeRes.data.nonce,
        signature: sig,
        publicKey: provider.publicKey(),
      }),
    })).json();
  const registerRes =
    await (await fetch(`${PROVIDER_URL}/api/v1/dashboard/pp/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${verifyRes.data.token}`,
      },
      body: JSON.stringify({
        secretKey: provider.secret(),
        derivationIndex: 0,
        label: "Lifecycle Provider",
      }),
    })).json();
  if (!registerRes.data?.publicKey) {
    throw new Error(`PP register failed: ${JSON.stringify(registerRes)}`);
  }
  console.log("  PP registered");

  // Seed council membership directly in DB
  const db = postgres(DATABASE_URL);
  const configJson = JSON.stringify({
    council: { name: "Lifecycle Council", channelAuthId },
    channels: [{ channelContractId, assetCode: "XLM", assetContractId }],
    jurisdictions: [],
    providers: [{
      publicKey: provider.publicKey(),
      label: "Lifecycle Provider",
    }],
  });
  await db`
    INSERT INTO council_memberships (id, council_url, council_name, council_public_key, channel_auth_id, status, config_json, pp_public_key, created_at, updated_at)
    VALUES (${crypto.randomUUID()}, 'http://lifecycle-council', 'Lifecycle Council', '', ${channelAuthId}, 'ACTIVE', ${configJson}, ${provider.publicKey()}, ${new Date()}, ${new Date()})
    ON CONFLICT DO NOTHING
  `;
  await db.end();
  console.log("  Council membership seeded");

  // ── Build E2E config ──────────────────────────────────────────
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
    providerSecretKey: provider.secret(),
  };

  const alice = Keypair.random();
  const bob = Keypair.random();
  console.log(`\n  Alice: ${alice.publicKey()}`);
  console.log(`  Bob:   ${bob.publicKey()}`);

  await fundAccount(alice.publicKey());
  await fundAccount(bob.publicKey());
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
  await send(alice.secret(), receiverOps, SEND_AMOUNT, aliceJwt, e2eConfig);
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
    NETWORK_PASSPHRASE,
    channelAuthId,
    provider.publicKey(),
  );

  const removeEvents = extractEvents(removeTx);
  const removeResult = verifyEvent(removeEvents, "provider_removed", true);
  if (removeResult.found) console.log("  provider_removed event verified");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n────────────────────────────────────────────────");
  console.log("  Contract IDs:");
  console.log(`    XLM SAC:         ${assetContractId}`);
  console.log(`    Channel Auth:    ${channelAuthId}`);
  console.log(`    Privacy Channel: ${channelContractId}`);
  console.log(`\n=== Lifecycle E2E passed in ${elapsed}s ===`);
}

main().catch((err) => {
  console.error("\n=== Lifecycle E2E FAILED ===");
  console.error(err);
  Deno.exit(1);
});
