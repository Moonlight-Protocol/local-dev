/**
 * Multi-asset (UC6) E2E — one council (Quorum Auth), two single-asset privacy
 * channels (XLM + USDC), one provider operating both.
 *
 * Proves the UC6 hypothesis end-to-end: the privacy channel is asset-
 * parameterized, so a council can "enable a second asset" simply by deploying
 * a second channel (bound to a different SAC) under the SAME Channel Auth, and
 * a provider that joined the council inherits both without re-registration.
 *
 *   1. Deploy Channel Auth (council)            — shared by both channels
 *   2. Deploy XLM SAC      + XLM privacy channel  (asset #1)
 *   3. Deploy USDC SAC     + USDC privacy channel (asset #2, same auth)
 *   4. Add provider once on the shared auth; seed membership with BOTH channels
 *   5. XLM   deposit → send → withdraw  (regression: XLM still works)
 *   6. USDC  deposit → send → withdraw  (the new asset), asserting classic
 *      USDC balances actually move and each channel is bound to its own SAC
 *   7. Remove provider
 *
 * Local (standalone node): USDC is a custom asset issued from a local issuer.
 * Testnet (NETWORK=testnet): USDC is Circle's testnet USDC (no local issuance;
 * holders need a trustline + a faucet top-up for the deposit source).
 */
import { Keypair } from "stellar-sdk";
import postgres from "postgres";
import { type ContractId, NetworkConfig } from "@colibri/core";
import {
  ChannelReadMethods,
  PrivacyChannel,
  type StellarNetworkId,
} from "@moonlight/moonlight-sdk";
import { createServer } from "../lib/soroban.ts";
import {
  deployChannelAuth,
  deployPrivacyChannel,
  getOrDeployCustomSac,
  getOrDeployNativeSac,
  uploadWasm,
} from "../lib/deploy.ts";
import {
  establishTrustline,
  getClassicAssetBalance,
  issueAssetTo,
} from "../lib/classic-asset.ts";
import { addProvider, removeProvider } from "../lib/admin.ts";
import { extractEvents, verifyEvent } from "../lib/events.ts";

import { authenticate } from "../lib/client/auth.ts";
import { deposit } from "../lib/client/deposit.ts";
import { prepareReceive } from "../lib/client/receive.ts";
import { send } from "../lib/client/send.ts";
import { withdraw } from "../lib/client/withdraw.ts";
import type { Config } from "../lib/client/config.ts";
import { registerEntity } from "../lib/client/register-entity.ts";

const DEPOSIT_AMOUNT = 10;
const SEND_AMOUNT = 5;
const WITHDRAW_AMOUNT = 4;
// Enough to cover deposit + the 0.05 deposit fee, with headroom.
const USDC_FUND_AMOUNT = "100";

const NETWORK = Deno.env.get("NETWORK") ?? "local";
const IS_TESTNET = NETWORK === "testnet";

// Circle's testnet USDC issuer. Used only on the testnet variant.
const CIRCLE_USDC_ISSUER =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

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

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

function approxEqual(a: number, b: number, tol = 0.0001): boolean {
  return Math.abs(a - b) <= tol;
}

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

function buildConfig(
  ppPublicKey: string,
  channelContractId: string,
  channelAuthId: string,
  assetContractId: string,
  horizonUrl: string,
  providerSecretKey: string,
): Config {
  const networkConfig = NetworkConfig.CustomNet({
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    horizonUrl,
    friendbotUrl: FRIENDBOT_URL,
    allowHttp: true,
  });
  return {
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    horizonUrl,
    friendbotUrl: FRIENDBOT_URL,
    providerUrl: PROVIDER_URL,
    ppPublicKey,
    channelContractId: channelContractId as ContractId,
    channelAuthId: channelAuthId as ContractId,
    channelAssetContractId: assetContractId as ContractId,
    networkConfig,
    networkId: NETWORK_PASSPHRASE as StellarNetworkId,
    providerSecretKey,
  };
}

/** Read the asset SAC a channel is bound to (proves per-channel asset binding). */
async function readChannelAsset(config: Config): Promise<string> {
  const client = new PrivacyChannel(
    config.networkConfig,
    config.channelContractId,
    config.channelAuthId,
    config.channelAssetContractId,
  );
  return await client.read({
    method: ChannelReadMethods.asset,
    methodArgs: {},
  }) as string;
}

/** Read total supply held in a channel (sum of live UTXO values). */
async function readChannelSupply(config: Config): Promise<bigint> {
  const client = new PrivacyChannel(
    config.networkConfig,
    config.channelContractId,
    config.channelAuthId,
    config.channelAssetContractId,
  );
  return await client.read({
    method: ChannelReadMethods.supply,
    methodArgs: {},
  }) as bigint;
}

/** Run deposit → send → withdraw for one channel/asset. */
async function runFlow(
  label: string,
  config: Config,
  alice: Keypair,
  bob: Keypair,
  aliceJwt: string,
  bobJwt: string,
): Promise<void> {
  console.log(`\n  [${label}] Deposit ${DEPOSIT_AMOUNT}`);
  await deposit(alice.secret(), DEPOSIT_AMOUNT, aliceJwt, config);

  console.log(`  [${label}] Send ${SEND_AMOUNT} (Alice → Bob)`);
  const receiverOps = await prepareReceive(bob.secret(), SEND_AMOUNT, config);
  await send(alice.secret(), receiverOps, SEND_AMOUNT, aliceJwt, config);

  console.log(`  [${label}] Withdraw ${WITHDRAW_AMOUNT} (Bob → classic)`);
  await withdraw(
    bob.secret(),
    bob.publicKey(),
    WITHDRAW_AMOUNT,
    bobJwt,
    config,
  );
}

async function main() {
  const startTime = Date.now();
  console.log("\n=== Moonlight Protocol — Multi-Asset (UC6) E2E ===");
  console.log(`  Network: ${NETWORK}\n`);

  const server = createServer(RPC_URL);
  const horizonUrl = RPC_URL.replace("/soroban/rpc", "");

  await waitForFriendbot();

  // ── Accounts ──────────────────────────────────────────────────
  const admin = Keypair.random();
  const provider = Keypair.random();
  const treasury = Keypair.random();
  const usdcIssuer = IS_TESTNET ? null : Keypair.random();
  const alice = Keypair.random();
  const bob = Keypair.random();

  console.log("[setup] Funding accounts...");
  await fundAccount(admin.publicKey());
  await fundAccount(provider.publicKey());
  await fundAccount(treasury.publicKey());
  await fundAccount(alice.publicKey());
  await fundAccount(bob.publicKey());
  if (usdcIssuer) await fundAccount(usdcIssuer.publicKey());
  console.log("  Accounts funded");

  // The USDC asset: local custom-issued, or Circle's testnet USDC. Threaded as
  // code/issuer strings (Asset objects are built inside the 14.x SDK helpers).
  const usdcCode = "USDC";
  const usdcIssuerPk = usdcIssuer ? usdcIssuer.publicKey() : CIRCLE_USDC_ISSUER;

  // ── Step 1: Deploy Council (Channel Auth) ─────────────────────
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
  assert(
    verifyEvent(extractEvents(authDeployTx), "contract_initialized", true)
      .found,
    "channel auth contract_initialized event",
  );
  console.log("  contract_initialized event verified");

  const privacyChannelWasm = await Deno.readFile(
    `${WASM_DIR}/privacy_channel.wasm`,
  );
  const privacyChannelHash = await uploadWasm(
    server,
    admin,
    NETWORK_PASSPHRASE,
    privacyChannelWasm,
  );

  // ── Step 2: XLM SAC + XLM channel (asset #1) ──────────────────
  console.log("\n[2/7] Deploy XLM channel (asset #1)");
  const xlmSacId = await getOrDeployNativeSac(
    server,
    admin,
    NETWORK_PASSPHRASE,
  );
  const xlmChannelId = await deployPrivacyChannel(
    server,
    admin,
    NETWORK_PASSPHRASE,
    privacyChannelHash,
    channelAuthId,
    xlmSacId,
  );

  // ── Step 3: USDC SAC + USDC channel (asset #2, SAME auth) ─────
  console.log("\n[3/7] Deploy USDC channel (asset #2, same Quorum Auth)");
  if (usdcIssuer) {
    console.log(`  Issuing local USDC from ${usdcIssuer.publicKey()}`);
  } else {
    console.log(`  Using Circle testnet USDC (${CIRCLE_USDC_ISSUER})`);
  }
  const usdcSacId = await getOrDeployCustomSac(
    server,
    admin,
    NETWORK_PASSPHRASE,
    usdcCode,
    usdcIssuerPk,
  );
  const usdcChannelId = await deployPrivacyChannel(
    server,
    admin,
    NETWORK_PASSPHRASE,
    privacyChannelHash,
    channelAuthId,
    usdcSacId,
  );
  assert(
    xlmChannelId !== usdcChannelId,
    "the two channels are distinct contracts",
  );

  // ── Step 4: Add provider once + seed membership with BOTH channels ──
  console.log("\n[4/7] Add provider (once) on the shared auth");
  const addTx = await addProvider(
    server,
    admin,
    NETWORK_PASSPHRASE,
    channelAuthId,
    provider.publicKey(),
  );
  assert(
    verifyEvent(extractEvents(addTx), "provider_added", true).found,
    "provider_added event",
  );
  console.log("  provider_added event verified");

  console.log(
    "\n[infra] Registering PP and seeding membership (2 channels)...",
  );
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
        label: "Multi-Asset Provider",
      }),
    })).json();
  assert(
    registerRes.data?.publicKey,
    `PP register: ${JSON.stringify(registerRes)}`,
  );
  console.log("  PP registered");

  // One membership, ONE provider, TWO channels — the provider inherits both
  // assets without a second registration.
  const db = postgres(DATABASE_URL);
  const configJson = JSON.stringify({
    council: { name: "Multi-Asset Council", channelAuthId },
    channels: [
      {
        channelContractId: xlmChannelId,
        assetCode: "XLM",
        assetContractId: xlmSacId,
      },
      {
        channelContractId: usdcChannelId,
        assetCode: "USDC",
        assetContractId: usdcSacId,
      },
    ],
    jurisdictions: [],
    providers: [{
      publicKey: provider.publicKey(),
      label: "Multi-Asset Provider",
    }],
  });
  await db`
    INSERT INTO council_memberships (id, council_url, council_name, council_public_key, channel_auth_id, status, config_json, pp_public_key, created_at, updated_at)
    VALUES (${crypto.randomUUID()}, 'http://multi-asset-council', 'Multi-Asset Council', '', ${channelAuthId}, 'ACTIVE', ${configJson}, ${provider.publicKey()}, ${new Date()}, ${new Date()})
    ON CONFLICT DO NOTHING
  `;
  await db.end();
  console.log("  Membership seeded with 2 channels (XLM + USDC)");

  // ── Configs (one per channel, shared PP + auth) ───────────────
  const xlmConfig = buildConfig(
    provider.publicKey(),
    xlmChannelId,
    channelAuthId,
    xlmSacId,
    horizonUrl,
    provider.secret(),
  );
  const usdcConfig = buildConfig(
    provider.publicKey(),
    usdcChannelId,
    channelAuthId,
    usdcSacId,
    horizonUrl,
    provider.secret(),
  );

  // Each channel is bound to its own SAC — the core "multi-asset" assertion.
  assert(
    (await readChannelAsset(xlmConfig)) === xlmSacId,
    `XLM channel bound to XLM SAC (got ${await readChannelAsset(xlmConfig)})`,
  );
  assert(
    (await readChannelAsset(usdcConfig)) === usdcSacId,
    `USDC channel bound to USDC SAC (got ${await readChannelAsset(
      usdcConfig,
    )})`,
  );
  console.log("  Per-channel asset binding verified (XLM SAC ≠ USDC SAC)");

  // ── Users: entity registration (once per PP) + USDC funding ───
  const aliceJwt = await authenticate(alice, xlmConfig);
  const bobJwt = await authenticate(bob, xlmConfig);
  await registerEntity(PROVIDER_URL, provider.publicKey(), alice, "Alice");
  await registerEntity(PROVIDER_URL, provider.publicKey(), bob, "Bob");
  console.log("  Alice & Bob authenticated + approved (one provider)");

  // Bob needs a USDC trustline to receive the withdrawal; Alice needs USDC to
  // deposit. On testnet the issuer is Circle — fund via a faucet out-of-band.
  if (usdcIssuer) {
    await issueAssetTo(
      server,
      usdcIssuer,
      alice,
      NETWORK_PASSPHRASE,
      usdcCode,
      USDC_FUND_AMOUNT,
    );
    await establishTrustline(
      server,
      bob,
      NETWORK_PASSPHRASE,
      usdcCode,
      usdcIssuerPk,
    );
    console.log(`  Alice funded ${USDC_FUND_AMOUNT} USDC; Bob trustline set`);
  }

  // ── Step 5: XLM flow (regression) ─────────────────────────────
  console.log("\n[5/7] XLM flow (regression)");
  await runFlow("XLM", xlmConfig, alice, bob, aliceJwt, bobJwt);
  const xlmSupply = await readChannelSupply(xlmConfig);
  assert(xlmSupply > 0n, `XLM channel supply > 0 (got ${xlmSupply})`);
  console.log(`  XLM channel supply: ${xlmSupply}`);

  // ── Step 6: USDC flow (the new asset) ─────────────────────────
  console.log("\n[6/7] USDC flow (new asset)");
  const aliceUsdcBefore = await getClassicAssetBalance(
    horizonUrl,
    alice.publicKey(),
    usdcCode,
    usdcIssuerPk,
  );
  const bobUsdcBefore = await getClassicAssetBalance(
    horizonUrl,
    bob.publicKey(),
    usdcCode,
    usdcIssuerPk,
  );

  await runFlow("USDC", usdcConfig, alice, bob, aliceJwt, bobJwt);

  const aliceUsdcAfter = await getClassicAssetBalance(
    horizonUrl,
    alice.publicKey(),
    usdcCode,
    usdcIssuerPk,
  );
  const bobUsdcAfter = await getClassicAssetBalance(
    horizonUrl,
    bob.publicKey(),
    usdcCode,
    usdcIssuerPk,
  );
  const usdcSupply = await readChannelSupply(usdcConfig);

  console.log(
    `  Alice USDC: ${aliceUsdcBefore} → ${aliceUsdcAfter} (deposited ${DEPOSIT_AMOUNT}+fee)`,
  );
  console.log(
    `  Bob   USDC: ${bobUsdcBefore} → ${bobUsdcAfter} (withdrew ${WITHDRAW_AMOUNT})`,
  );
  console.log(`  USDC channel supply: ${usdcSupply}`);

  // Real USDC moved on-chain — not XLM.
  assert(
    approxEqual(bobUsdcAfter - bobUsdcBefore, WITHDRAW_AMOUNT),
    `Bob received ${WITHDRAW_AMOUNT} USDC (got ${
      bobUsdcAfter - bobUsdcBefore
    })`,
  );
  assert(
    aliceUsdcAfter < aliceUsdcBefore,
    `Alice USDC decreased by the deposit (before ${aliceUsdcBefore}, after ${aliceUsdcAfter})`,
  );
  assert(usdcSupply > 0n, `USDC channel supply > 0 (got ${usdcSupply})`);
  console.log("  USDC balances moved on-chain; channel supply asserted");

  // ── Step 7: Remove provider ───────────────────────────────────
  console.log("\n[7/7] Remove provider");
  const removeTx = await removeProvider(
    server,
    admin,
    NETWORK_PASSPHRASE,
    channelAuthId,
    provider.publicKey(),
  );
  assert(
    verifyEvent(extractEvents(removeTx), "provider_removed", true).found,
    "provider_removed event",
  );
  console.log("  provider_removed event verified");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n────────────────────────────────────────────────");
  console.log("  Council (Channel Auth): " + channelAuthId);
  console.log(`  XLM  SAC ${xlmSacId}`);
  console.log(`  XLM  channel ${xlmChannelId}`);
  console.log(`  USDC SAC ${usdcSacId}`);
  console.log(`  USDC channel ${usdcChannelId}`);
  console.log(`\n=== Multi-Asset (UC6) E2E passed in ${elapsed}s ===`);
}

main().catch((err) => {
  console.error("\n=== Multi-Asset (UC6) E2E FAILED ===");
  console.error(err);
  Deno.exit(1);
});
