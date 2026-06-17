/**
 * Multi-asset (UC6) E2E — one council (Quorum Auth), two single-asset privacy
 * channels (XLM + USDC), one provider operating both.
 *
 * Proves the UC6 hypothesis end-to-end: the privacy channel is asset-
 * parameterized, so a council can "enable a second asset" simply by deploying
 * a second channel (bound to a different SAC) under the SAME Channel Auth, and
 * a provider that joined the council inherits both without re-registration.
 * It then drives the full asset-lifecycle mechanism against the REAL council
 * watching the REAL chain.
 *
 *   1. Deploy Channel Auth (council)            — shared by both channels
 *   2. Deploy XLM SAC      + XLM privacy channel  (asset #1)
 *   3. Deploy USDC SAC     + USDC privacy channel (asset #2, same auth)
 *   4. Seed the council; provider joins it via the REAL dashboard join API
 *      (starts its on-chain watcher); add provider on-chain → membership ACTIVE
 *   5. XLM   deposit → send → withdraw  (regression: XLM still works)
 *   6. USDC  deposit → send → withdraw  (the new asset), asserting classic
 *      USDC balances actually move and each channel is bound to its own SAC
 *   7. Lifecycle: council disable_channel(USDC) on-chain → council DB tracks the
 *      chain → provider converges on the live event → withdraw-only enforced
 *      (deposits/sends rejected, withdraw works; XLM unaffected) → enable_channel
 *      → full service resumes
 *   8. Remove provider
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
import {
  addProvider,
  disableChannel,
  enableChannel,
  removeProvider,
} from "../lib/admin.ts";
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
const COUNCIL_URL = Deno.env.get("COUNCIL_URL") ?? "http://localhost:8080";
// The real council-platform DB — the council's event-watcher is the sole
// authoritative writer of channel status, and /public/council is what the
// provider converges on. The lifecycle assertions go through this real council.
const COUNCIL_DATABASE_URL = Deno.env.get("COUNCIL_DATABASE_URL") ??
  "postgresql://admin:devpass@council-db:5432/council_multi_asset_db";
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build the SignedPayload envelope the council join-request endpoint verifies:
 * SHA-256(JSON.stringify({payload, timestamp})) → Ed25519 sign → base64.
 * Mirrors council-platform's signPayload so the real onboarding path is used.
 */
async function signJoinEnvelope(
  provider: Keypair,
  channelAuthId: string,
  label: string,
): Promise<unknown> {
  const { Buffer } = await import("buffer");
  const payload = {
    publicKey: provider.publicKey(),
    councilId: channelAuthId,
    label,
  };
  const timestamp = Date.now();
  const canonical = JSON.stringify({ payload, timestamp });
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
  const signature = Buffer.from(provider.sign(Buffer.from(hash))).toString(
    "base64",
  );
  return { payload, signature, publicKey: provider.publicKey(), timestamp };
}

/**
 * Real onboarding: the provider joins the council via its dashboard join API.
 * This is what starts the provider's on-chain event-watcher (addCouncilWatcher)
 * — the genuine path, not a hand-seeded membership.
 */
async function joinCouncil(
  provider: Keypair,
  channelAuthId: string,
  jwt: string,
): Promise<void> {
  const signedEnvelope = await signJoinEnvelope(
    provider,
    channelAuthId,
    "Multi-Asset Provider",
  );
  const res = await fetch(
    `${PROVIDER_URL}/api/v1/providers/${provider.publicKey()}/council/join`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        councilUrl: COUNCIL_URL,
        councilId: channelAuthId,
        signedEnvelope,
      }),
    },
  );
  const body = await res.json().catch(() => ({}));
  assert(
    res.ok,
    `provider join council: ${res.status} ${JSON.stringify(body)}`,
  );
}

/** Read the provider's membership status (dashboard). */
async function getMembershipStatus(
  provider: Keypair,
  jwt: string,
): Promise<string | null> {
  const res = await fetch(
    `${PROVIDER_URL}/api/v1/providers/${provider.publicKey()}/council/membership`,
    { headers: { "Authorization": `Bearer ${jwt}` } },
  );
  if (!res.ok) return null;
  const { data } = await res.json();
  return data?.status ?? null;
}

/** Poll the council's PUBLIC channel query for a channel's confirmed status. */
async function pollCouncilChannelStatus(
  channelAuthId: string,
  channelContractId: string,
  expected: "enabled" | "disabled",
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${COUNCIL_URL}/api/v1/public/channels?councilId=${
          encodeURIComponent(channelAuthId)
        }`,
      );
      if (res.ok) {
        const { data } = await res.json();
        const ch =
          (data as Array<{ channelContractId: string; status: string }>)
            .find((c) => c.channelContractId === channelContractId);
        last = ch?.status;
        if (last === expected) return;
      }
    } catch { /* retry */ }
    await sleep(1500);
  }
  throw new Error(
    `council DB did not reach status='${expected}' for channel ${channelContractId} (last='${last}')`,
  );
}

/** Read the provider registry's view of a channel (dashboard). */
async function getProviderChannelState(
  provider: Keypair,
  channelContractId: string,
  jwt: string,
): Promise<string | undefined> {
  const res = await fetch(
    `${PROVIDER_URL}/api/v1/providers/${provider.publicKey()}/channels`,
    { headers: { "Authorization": `Bearer ${jwt}` } },
  );
  if (!res.ok) return undefined;
  const { data } = await res.json();
  const ch = (data?.channels as Array<{ contractId: string; state: string }>)
    ?.find((c) => c.contractId === channelContractId);
  return ch?.state;
}

/** Poll the provider registry until a channel reaches the expected state. */
async function pollProviderChannelState(
  provider: Keypair,
  channelContractId: string,
  expected: string,
  jwt: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    last = await getProviderChannelState(provider, channelContractId, jwt);
    if (last === expected) return;
    await sleep(1500);
  }
  throw new Error(
    `provider did not converge to state='${expected}' for channel ${channelContractId} (last='${last}')`,
  );
}

/** Assert an operation is REJECTED because the channel is disabled. */
async function expectDisabledRejection(
  label: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`${label}: expected rejection but it succeeded`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(
      /403|disabled|CHANNEL_DISABLED/i.test(msg),
      `${label}: expected a disabled-channel (403) rejection, got: ${msg}`,
    );
    console.log(`  [${label}] correctly rejected (withdraw-only)`);
  }
}

/**
 * Seed the real council's DB: metadata (so its event-watcher discovers and
 * watches the auth) and the two channels (so /public/council serves them with
 * status). The lifecycle status itself is only ever written by the council's
 * watcher from confirmed on-chain events — never seeded ahead.
 */
async function seedCouncilDb(
  channelAuthId: string,
  adminPk: string,
  channels: Array<
    { channelContractId: string; assetCode: string; assetContractId: string }
  >,
): Promise<void> {
  const cdb = postgres(COUNCIL_DATABASE_URL);
  try {
    const now = new Date();
    await cdb`
      INSERT INTO council_metadata (id, name, council_public_key, encrypted_derivation_root, created_at, updated_at)
      VALUES (${channelAuthId}, 'Multi-Asset Council', ${adminPk}, 'e2e-placeholder-not-used', ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `;
    for (const ch of channels) {
      await cdb`
        INSERT INTO council_channels (id, council_id, channel_contract_id, asset_code, asset_contract_id, status, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, ${channelAuthId}, ${ch.channelContractId}, ${ch.assetCode}, ${ch.assetContractId}, 'enabled', ${now}, ${now})
        ON CONFLICT DO NOTHING
      `;
    }
  } finally {
    await cdb.end();
  }
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

  // ── Step 4: Register PP, seed the council, join it for real, add on-chain ──
  // The provider joins the REAL council through the dashboard join API — that is
  // what starts its on-chain event-watcher (addCouncilWatcher). No hand-seeded
  // membership; the membership activates from the provider_added chain event,
  // pulling its channel config (with status) from the real council.
  console.log("\n[4/7] Register PP, seed council, real join, add on-chain");
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
  const providerJwt = verifyRes.data.token as string;
  const registerRes =
    await (await fetch(`${PROVIDER_URL}/api/v1/dashboard/pp/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${providerJwt}`,
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

  // Seed the real council so its watcher discovers the auth and /public/council
  // serves both channels (status seeded enabled; thereafter chain-driven only).
  await seedCouncilDb(channelAuthId, admin.publicKey(), [
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
  ]);
  console.log("  Council seeded (metadata + 2 channels)");

  // Real join → starts the provider's on-chain event-watcher for this auth.
  await joinCouncil(provider, channelAuthId, providerJwt);
  console.log("  Provider joined council (watcher started)");

  // Add the provider on-chain AFTER the watcher is live, so the watcher receives
  // provider_added and activates the membership (pulling config from the council).
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

  // Wait for the membership to activate from the on-chain event.
  let membershipStatus: string | null = null;
  for (let i = 0; i < 40; i++) {
    membershipStatus = await getMembershipStatus(provider, providerJwt);
    if (membershipStatus === "ACTIVE") break;
    await sleep(1500);
  }
  assert(
    membershipStatus === "ACTIVE",
    `membership activated from chain event (status=${membershipStatus})`,
  );
  console.log(
    "  Membership ACTIVE via provider_added (config from real council)",
  );

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

  // ── Step 7: Asset lifecycle — disable USDC → withdraw-only → re-enable ──
  // The whole point of UC6's lifecycle: the council disables an asset on-chain,
  // the council DB tracks the chain, the provider converges on the live event,
  // and a disabled channel is withdraw-only. Re-enable resumes full service.
  console.log(
    "\n[7/8] Asset lifecycle: disable USDC → withdraw-only → re-enable",
  );

  const LIFECYCLE_WITHDRAW = 2;
  console.log("  Council disables USDC on-chain (disable_channel)");
  const disableTx = await disableChannel(
    server,
    admin,
    NETWORK_PASSPHRASE,
    channelAuthId,
    usdcChannelId,
    usdcSacId,
  );
  assert(
    verifyEvent(extractEvents(disableTx), "channel_state_changed", true).found,
    "channel_state_changed (disabled) event",
  );
  console.log("  channel_state_changed event verified");

  // Council DB tracks the chain (its watcher is the sole authoritative writer).
  await pollCouncilChannelStatus(channelAuthId, usdcChannelId, "disabled");
  console.log("  Council DB tracks chain: USDC status=disabled");

  // Provider converges on the live event → registry flips to disabled.
  await pollProviderChannelState(
    provider,
    usdcChannelId,
    "disabled",
    providerJwt,
  );
  console.log("  Provider converged via live event: USDC channel disabled");

  // Withdraw-only enforcement on the disabled channel.
  await expectDisabledRejection(
    "USDC deposit",
    () => deposit(alice.secret(), DEPOSIT_AMOUNT, aliceJwt, usdcConfig),
  );
  // Small enough that Alice's leftover in-channel balance covers it, so the
  // bundle reaches the provider and is rejected by the gate (not a client-side
  // balance check).
  const LIFECYCLE_SEND = 1;
  await expectDisabledRejection("USDC send", async () => {
    const ops = await prepareReceive(bob.secret(), LIFECYCLE_SEND, usdcConfig);
    await send(alice.secret(), ops, LIFECYCLE_SEND, aliceJwt, usdcConfig);
  });
  console.log("  USDC withdraw still works (withdraw-only allowed)");
  await withdraw(
    alice.secret(),
    alice.publicKey(),
    LIFECYCLE_WITHDRAW,
    aliceJwt,
    usdcConfig,
  );
  console.log(`  Withdrew ${LIFECYCLE_WITHDRAW} USDC while disabled`);

  // The other asset (XLM) is unaffected — disable is per-channel.
  console.log("  XLM unaffected (deposit still accepted)");
  await deposit(alice.secret(), DEPOSIT_AMOUNT, aliceJwt, xlmConfig);
  console.log("  XLM deposit accepted while USDC disabled");

  // Re-enable → full service resumes.
  console.log("  Council re-enables USDC on-chain (enable_channel)");
  const reEnableTx = await enableChannel(
    server,
    admin,
    NETWORK_PASSPHRASE,
    channelAuthId,
    usdcChannelId,
    usdcSacId,
  );
  assert(
    verifyEvent(extractEvents(reEnableTx), "channel_state_changed", true).found,
    "channel_state_changed (re-enabled) event",
  );
  await pollCouncilChannelStatus(channelAuthId, usdcChannelId, "enabled");
  console.log("  Council DB tracks chain: USDC status=enabled");
  await pollProviderChannelState(
    provider,
    usdcChannelId,
    "active",
    providerJwt,
  );
  console.log("  Provider converged: USDC channel active again");
  await deposit(alice.secret(), DEPOSIT_AMOUNT, aliceJwt, usdcConfig);
  console.log("  USDC deposit accepted after re-enable — full service resumed");

  // ── Step 8: Remove provider ───────────────────────────────────
  console.log("\n[8/8] Remove provider");
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
