/**
 * CI Test phase — runs inside docker-compose after setup, council, and provider are ready.
 *
 * Simulates the FULL production flow with two distinct user identities:
 *   - admin: deploys contracts (in setup), creates the council on council-platform,
 *            adds the channel, approves the PP join request, calls on-chain add_provider
 *   - pp_operator: registers a PP via the dashboard API, joins the council
 *
 * Steps:
 *   1. Load test fixture (contracts.env)
 *   2. Admin authenticates to council-platform → JWT
 *   3. Admin creates the council via PUT /council/metadata
 *   4. Admin adds the channel via POST /council/channels
 *   5. PP operator authenticates to provider-platform dashboard → JWT
 *   6. PP operator registers the PP via POST /dashboard/pp/register
 *   7. PP operator signs a join envelope and posts it via POST /dashboard/council/join
 *      (provider-platform forwards to council-platform; PENDING membership row created)
 *   8. Admin lists join requests, approves the PP's request
 *   9. Admin calls on-chain add_provider → emits provider_added event
 *  10. Provider-platform's event watcher activates the membership (poll until ACTIVE)
 *  11. Run bundle flow (deposit / send / withdraw)
 *  12. Remove provider — pinned (API not implemented yet)
 */
import { Keypair } from "stellar-sdk";
import { Buffer } from "node:buffer";
import { NetworkConfig, type ContractId } from "@colibri/core";
import type { StellarNetworkId } from "@moonlight/moonlight-sdk";
import type { Config } from "../e2e/config.ts";
import { createServer } from "../lib/soroban.ts";
import { addProvider } from "../lib/admin.ts";
import { extractEvents, verifyEvent } from "../lib/events.ts";
import { authenticate } from "../e2e/auth.ts";
import { deposit } from "../e2e/deposit.ts";
import { prepareReceive } from "../e2e/receive.ts";
import { send } from "../e2e/send.ts";
import { withdraw } from "../e2e/withdraw.ts";

const RPC_URL = Deno.env.get("STELLAR_RPC_URL")!;
const FRIENDBOT_URL = Deno.env.get("FRIENDBOT_URL")!;
const PROVIDER_URL = Deno.env.get("PROVIDER_URL")!;
const COUNCIL_URL = Deno.env.get("COUNCIL_URL")!;
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

/**
 * Wallet auth: challenge → sign → verify → JWT.
 * Used for both council-platform admin auth and provider-platform dashboard auth.
 */
async function walletAuth(baseUrl: string, route: string, keypair: Keypair): Promise<string> {
  const challengeRes = await fetch(`${baseUrl}${route}/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: keypair.publicKey() }),
  });
  if (!challengeRes.ok) {
    throw new Error(`Challenge failed for ${baseUrl}${route}: ${challengeRes.status}`);
  }
  const { data: { nonce } } = await challengeRes.json();

  const nonceBytes = Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0));
  const sig = keypair.sign(Buffer.from(nonceBytes));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));

  const verifyRes = await fetch(`${baseUrl}${route}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, signature, publicKey: keypair.publicKey() }),
  });
  if (!verifyRes.ok) {
    throw new Error(`Verify failed for ${baseUrl}${route}: ${verifyRes.status}`);
  }
  const { data: { token } } = await verifyRes.json();
  return token;
}

/**
 * Sign a join request envelope as the PP operator.
 * Mirrors `signPayload` from council-platform's signed-payload.ts.
 */
async function signJoinEnvelope<T>(payload: T, keypair: Keypair): Promise<{
  payload: T;
  signature: string;
  publicKey: string;
  timestamp: number;
}> {
  const timestamp = Date.now();
  const canonical = JSON.stringify({ payload, timestamp });
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
  const signature = Buffer.from(keypair.sign(Buffer.from(hash))).toString("base64");
  return {
    payload,
    signature,
    publicKey: keypair.publicKey(),
    timestamp,
  };
}

async function pollMembershipActive(
  ppPublicKey: string,
  dashboardJwt: string,
  maxAttempts = 60,
  intervalMs = 1000,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(
      `${PROVIDER_URL}/api/v1/dashboard/council/membership?ppPublicKey=${encodeURIComponent(ppPublicKey)}`,
      { headers: { "Authorization": `Bearer ${dashboardJwt}` } },
    );
    if (res.status === 200) {
      const { data } = await res.json();
      if (data?.status === "ACTIVE") return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Membership for ${ppPublicKey} did not become ACTIVE after ${maxAttempts * intervalMs}ms`,
  );
}

async function main() {
  const startTime = Date.now();

  // ─── Step 1: Load fixture ───────────────────────────────────────────────
  console.log("[ci-test] Loading config...");
  const contracts = loadEnvFile(`${CONFIG_DIR}/contracts.env`);
  const channelContractId = contracts["CHANNEL_CONTRACT_ID"];
  const channelAuthId = contracts["CHANNEL_AUTH_ID"];
  const assetContractId = contracts["CHANNEL_ASSET_CONTRACT_ID"];
  const adminSecretKey = contracts["ADMIN_SK"];
  const ppOperatorSecretKey = contracts["PP_OPERATOR_SK"];

  const admin = Keypair.fromSecret(adminSecretKey);
  const ppOperator = Keypair.fromSecret(ppOperatorSecretKey);

  console.log(`  Channel:     ${channelContractId}`);
  console.log(`  Auth:        ${channelAuthId}`);
  console.log(`  Asset:       ${assetContractId}`);
  console.log(`  Council:     ${COUNCIL_URL}`);
  console.log(`  Provider:    ${PROVIDER_URL}`);
  console.log(`  Admin:       ${admin.publicKey()}`);
  console.log(`  PP Operator: ${ppOperator.publicKey()}`);

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
    providerSecretKey: ppOperatorSecretKey,
  };

  // ─── Step 2: Admin authenticates to council-platform ────────────────────
  console.log("\n[2/11] Admin authenticates to council-platform");
  const adminCouncilJwt = await walletAuth(COUNCIL_URL, "/api/v1/admin/auth", admin);
  console.log("  Admin JWT acquired");

  // ─── Step 3: Admin creates the council ─────────────────────────────────
  console.log("\n[3/11] Admin creates the council");
  const createRes = await fetch(`${COUNCIL_URL}/api/v1/council/metadata`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${adminCouncilJwt}`,
    },
    body: JSON.stringify({
      councilId: channelAuthId,
      name: "Lifecycle Council",
      description: "End-to-end lifecycle test council",
      contactEmail: "admin@lifecycle.test",
    }),
  });
  if (!createRes.ok) {
    const body = await createRes.json().catch(() => ({}));
    throw new Error(`Create council failed: ${createRes.status} ${JSON.stringify(body)}`);
  }
  console.log("  Council created");

  // ─── Step 4: Admin adds the channel ────────────────────────────────────
  console.log("\n[4/11] Admin adds the channel");
  const addChannelRes = await fetch(
    `${COUNCIL_URL}/api/v1/council/channels?councilId=${encodeURIComponent(channelAuthId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${adminCouncilJwt}`,
      },
      body: JSON.stringify({
        channelContractId,
        assetCode: "XLM",
        assetContractId,
        label: "XLM channel",
      }),
    },
  );
  if (!addChannelRes.ok) {
    const body = await addChannelRes.json().catch(() => ({}));
    throw new Error(`Add channel failed: ${addChannelRes.status} ${JSON.stringify(body)}`);
  }
  console.log("  Channel added");

  // ─── Step 5: PP operator authenticates to provider-platform dashboard ──
  console.log("\n[5/11] PP operator authenticates to provider-platform dashboard");
  const dashboardJwt = await walletAuth(PROVIDER_URL, "/api/v1/dashboard/auth", ppOperator);
  console.log("  Dashboard JWT acquired");

  // ─── Step 6: PP operator registers the PP ──────────────────────────────
  // In this lifecycle test, the PP keypair is the same as the operator wallet
  // (simplest case — single-user, single-PP). In production a single operator
  // would manage multiple PPs derived from a master seed, but the lifecycle
  // test only needs to verify the register → bundle flow works.
  console.log("\n[6/11] PP operator registers the PP");
  const ppKeypair = ppOperator;
  const regRes = await fetch(`${PROVIDER_URL}/api/v1/dashboard/pp/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${dashboardJwt}`,
    },
    body: JSON.stringify({
      secretKey: ppKeypair.secret(),
      derivationIndex: 0,
      label: "Lifecycle PP",
    }),
  });
  if (!regRes.ok) {
    const body = await regRes.json().catch(() => ({}));
    throw new Error(`PP register failed: ${regRes.status} ${body.message || ""}`);
  }
  console.log(`  PP registered: ${ppKeypair.publicKey()}`);

  // ─── Step 7: PP operator signs join envelope and posts join request ────
  console.log("\n[7/11] PP operator submits join request to council");
  const joinPayload = {
    publicKey: ppKeypair.publicKey(),
    councilId: channelAuthId,
    label: "Lifecycle PP",
    contactEmail: "pp@lifecycle.test",
  };
  const signedEnvelope = await signJoinEnvelope(joinPayload, ppKeypair);

  const joinRes = await fetch(`${PROVIDER_URL}/api/v1/dashboard/council/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${dashboardJwt}`,
    },
    body: JSON.stringify({
      councilUrl: COUNCIL_URL,
      councilId: channelAuthId,
      councilName: "Lifecycle Council",
      ppPublicKey: ppKeypair.publicKey(),
      label: "Lifecycle PP",
      contactEmail: "pp@lifecycle.test",
      signedEnvelope,
    }),
  });
  if (!joinRes.ok) {
    const body = await joinRes.json().catch(() => ({}));
    throw new Error(`Join request failed: ${joinRes.status} ${JSON.stringify(body)}`);
  }
  const joinBody = await joinRes.json();
  console.log(`  Join request submitted: ${joinBody.data?.joinRequestId} (PENDING)`);

  // ─── Step 8: Admin lists and approves the join request ─────────────────
  console.log("\n[8/11] Admin approves the join request");
  const listRes = await fetch(
    `${COUNCIL_URL}/api/v1/council/provider-requests?councilId=${encodeURIComponent(channelAuthId)}`,
    { headers: { "Authorization": `Bearer ${adminCouncilJwt}` } },
  );
  if (!listRes.ok) {
    throw new Error(`List join requests failed: ${listRes.status}`);
  }
  const { data: requests } = await listRes.json();
  const ourRequest = requests?.find?.(
    (r: { publicKey: string }) => r.publicKey === ppKeypair.publicKey(),
  );
  if (!ourRequest) {
    throw new Error(
      `Could not find our join request among ${requests?.length ?? 0} requests`,
    );
  }

  const approveRes = await fetch(
    `${COUNCIL_URL}/api/v1/council/provider-requests/${ourRequest.id}/approve`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${adminCouncilJwt}` },
    },
  );
  if (!approveRes.ok) {
    const body = await approveRes.json().catch(() => ({}));
    throw new Error(`Approve failed: ${approveRes.status} ${JSON.stringify(body)}`);
  }
  console.log("  Join request approved (DB updated)");

  // ─── Step 9: Admin calls on-chain add_provider ─────────────────────────
  // In production this is the council-console (after admin approval) calling
  // the contract directly with the admin's wallet. We simulate that here.
  console.log("\n[9/11] Admin calls on-chain add_provider");
  const server = createServer(RPC_URL);
  const addTx = await addProvider(
    server,
    admin,
    NETWORK_PASSPHRASE,
    channelAuthId,
    ppKeypair.publicKey(),
  );
  const addEvents = extractEvents(addTx);
  const addResult = verifyEvent(addEvents, "provider_added", true);
  if (!addResult.found) {
    throw new Error("provider_added event not emitted");
  }
  console.log("  provider_added event verified");

  // ─── Step 10: Wait for membership to become ACTIVE ─────────────────────
  // The provider-platform's event watcher polls Stellar RPC and activates
  // the membership when it sees the provider_added event.
  console.log("\n[10/11] Waiting for membership to become ACTIVE");
  await pollMembershipActive(ppKeypair.publicKey(), dashboardJwt);
  console.log("  Membership ACTIVE");

  // ─── Step 11: Run the bundle flow (deposit/send/withdraw) ──────────────
  console.log(`\n[11/11] Bundle flow (deposit ${DEPOSIT_AMOUNT}, send ${SEND_AMOUNT}, withdraw ${WITHDRAW_AMOUNT})`);
  const alice = Keypair.random();
  const bob = Keypair.random();
  console.log(`  Alice: ${alice.publicKey()}`);
  console.log(`  Bob:   ${bob.publicKey()}`);

  await fundAccount(alice.publicKey());
  await fundAccount(bob.publicKey());
  console.log("  Users funded");

  const aliceJwt = await authenticate(alice, e2eConfig);
  console.log("  Alice authenticated");
  await deposit(alice.secret(), DEPOSIT_AMOUNT, aliceJwt, e2eConfig);
  console.log(`  Deposit ${DEPOSIT_AMOUNT} XLM complete`);

  const bobJwt = await authenticate(bob, e2eConfig);
  console.log("  Bob authenticated");
  const receiverOps = await prepareReceive(bob.secret(), SEND_AMOUNT, e2eConfig);
  await send(alice.secret(), receiverOps, SEND_AMOUNT, aliceJwt, e2eConfig);
  console.log(`  Send ${SEND_AMOUNT} XLM complete`);

  await withdraw(
    bob.secret(),
    bob.publicKey(),
    WITHDRAW_AMOUNT,
    bobJwt,
    e2eConfig,
  );
  console.log(`  Withdraw ${WITHDRAW_AMOUNT} XLM complete`);

  // ─── Step 12 (PINNED): Remove provider via API ─────────────────────────
  // The remove-provider API is not implemented yet on either platform.
  // When it lands, this should call the council-platform admin endpoint
  // (which triggers an on-chain remove_provider) and verify the membership
  // becomes inactive on provider-platform via the event watcher.
  console.log("\n[PINNED] Remove provider — API not implemented yet (skipped)");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Lifecycle E2E passed in ${elapsed}s ===`);
}

main().catch((err) => {
  console.error("\n=== Lifecycle E2E FAILED ===");
  console.error(err);
  Deno.exit(1);
});
