/**
 * Testnet E2E — self-contained payment flow test.
 *
 * Deploys fresh contracts, registers a PP through both platforms, then runs
 * the core deposit → send → withdraw flow. If the platforms are broken at
 * the registration layer, this test fails early with a clear error — use
 * lifecycle/testnet-verify.ts for the full governance flow.
 *
 * If the registration succeeds but the payment flow fails, that isolates
 * the bug to the bundle/execution pipeline.
 *
 * Usage:
 *   cd testnet && deno task e2e
 */
import { Keypair } from "stellar-sdk";
import { Buffer } from "node:buffer";
import { masterSeedFromSecret, deriveKeypair, ROLES } from "../lib/master-seed.ts";
import { NetworkConfig, type ContractId } from "@colibri/core";
import type { StellarNetworkId } from "@moonlight/moonlight-sdk";
import type { Config } from "../e2e/config.ts";
import { createServer } from "../lib/soroban.ts";
import {
  deployChannelAuth,
  deployPrivacyChannel,
  getOrDeployNativeSac,
  uploadWasm,
} from "../lib/deploy.ts";
import { addProvider } from "../lib/admin.ts";
import { extractEvents, verifyEvent } from "../lib/events.ts";
import { authenticate } from "../e2e/auth.ts";
import { deposit } from "../e2e/deposit.ts";
import { prepareReceive } from "../e2e/receive.ts";
import { send } from "../e2e/send.ts";
import { withdraw } from "../e2e/withdraw.ts";
import { sdkTracer, withE2ESpan, writeTraceIds } from "../e2e/tracer.ts";
import { exerciseCouncilSpans } from "../lib/exercise-cp-spans.ts";
import { assertNotMainnet } from "../lib/assert-not-mainnet.ts";

// ─── Testnet endpoints ──────────────────────────────────────────────
const RPC_URL = Deno.env.get("STELLAR_RPC_URL") ?? "https://soroban-testnet.stellar.org";
const FRIENDBOT_URL = Deno.env.get("FRIENDBOT_URL") ?? "https://friendbot.stellar.org";
const NETWORK_PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ??
  "Test SDF Network ; September 2015";
const COUNCIL_URL = Deno.env.get("COUNCIL_URL") ?? "https://council-api-testnet.moonlightprotocol.io";
const PROVIDER_URL = Deno.env.get("PROVIDER_URL") ?? "https://provider-api-testnet.moonlightprotocol.io";

const CHANNEL_AUTH_WASM = Deno.env.get("CHANNEL_AUTH_WASM") ??
  new URL("../e2e/wasms/channel_auth_contract.wasm", import.meta.url).pathname;
const PRIVACY_CHANNEL_WASM = Deno.env.get("PRIVACY_CHANNEL_WASM") ??
  new URL("../e2e/wasms/privacy_channel.wasm", import.meta.url).pathname;

const DEPOSIT_AMOUNT = 10;
const SEND_AMOUNT = 5;
const WITHDRAW_AMOUNT = 4;

// ─── Helpers ────────────────────────────────────────────────────────
async function fundAccount(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(`Friendbot failed for ${publicKey}: ${res.status} ${await res.text()}`);
  }
}

async function warmupService(name: string, url: string): Promise<void> {
  console.log(`  Warming up ${name}...`);
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${url}/api/v1/health`);
      if (res.ok) {
        const body = await res.json();
        console.log(`  ${name} ready: ${body.service} v${body.version}`);
        return;
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${name} not reachable after 60s at ${url}`);
}

async function walletAuth(baseUrl: string, route: string, keypair: Keypair): Promise<string> {
  const challengeRes = await fetch(`${baseUrl}${route}/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: keypair.publicKey() }),
  });
  if (!challengeRes.ok) {
    throw new Error(`Challenge failed: ${challengeRes.status} ${await challengeRes.text()}`);
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
    throw new Error(`Verify failed: ${verifyRes.status} ${await verifyRes.text()}`);
  }
  const { data: { token } } = await verifyRes.json();
  return token;
}

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
  return { payload, signature, publicKey: keypair.publicKey(), timestamp };
}

async function pollMembershipActive(
  ppPublicKey: string,
  dashboardJwt: string,
  maxAttempts = 90,
  intervalMs = 2000,
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
  throw new Error(`Membership for ${ppPublicKey} did not become ACTIVE`);
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  assertNotMainnet({
    scriptName: "testnet/main.ts",
    urls: { COUNCIL_URL, PROVIDER_URL },
  });

  const startTime = Date.now();

  console.log("\n=== Testnet E2E — Payment Flow ===\n");
  console.log(`  RPC:        ${RPC_URL}`);
  console.log(`  Council:    ${COUNCIL_URL}`);
  console.log(`  Provider:   ${PROVIDER_URL}`);

  // ── Warmup ────────────────────────────────────────────────────────
  console.log("\n[0/12] Warmup");
  await warmupService("council-platform", COUNCIL_URL);
  await warmupService("provider-platform", PROVIDER_URL);

  const masterSecret = Deno.env.get("MASTER_SECRET");
  let admin: Keypair, ppOperator: Keypair;
  if (masterSecret) {
    const seed = await masterSeedFromSecret(masterSecret);
    admin = await deriveKeypair(seed, ROLES.ADMIN, 0);
    ppOperator = await deriveKeypair(seed, ROLES.PP, 0);
    console.log("  Keys: derived from MASTER_SECRET");
  } else {
    admin = Keypair.random();
    ppOperator = Keypair.random();
    console.log("  Keys: random (set MASTER_SECRET for deterministic)");
  }
  console.log(`\n  Admin:       ${admin.publicKey()}`);
  console.log(`  PP Operator: ${ppOperator.publicKey()}`);

  // ── 1. Fund admin + PP operator ───────────────────────────────────
  console.log("\n[1/12] Funding admin and PP operator");
  await fundAccount(admin.publicKey());
  console.log("  Admin funded");
  await fundAccount(ppOperator.publicKey());
  console.log("  PP Operator funded");

  // ── 2-4. Deploy contracts ─────────────────────────────────────────
  console.log("\n[2/12] Deploy Channel Auth contract");
  const server = createServer(RPC_URL);
  const channelAuthWasm = await Deno.readFile(CHANNEL_AUTH_WASM);
  const channelAuthHash = await uploadWasm(server, admin, NETWORK_PASSPHRASE, channelAuthWasm);
  const { contractId: channelAuthId, txResponse: authDeployTx } =
    await deployChannelAuth(server, admin, NETWORK_PASSPHRASE, channelAuthHash);
  const deployEvents = extractEvents(authDeployTx);
  if (verifyEvent(deployEvents, "contract_initialized", true).found) {
    console.log("  contract_initialized event verified");
  }
  console.log(`  Channel Auth: ${channelAuthId}`);

  console.log("\n[3/12] Deploy native XLM SAC");
  const assetContractId = await getOrDeployNativeSac(server, admin, NETWORK_PASSPHRASE);
  console.log(`  XLM SAC: ${assetContractId}`);

  console.log("\n[4/12] Deploy Privacy Channel contract");
  const privacyChannelWasm = await Deno.readFile(PRIVACY_CHANNEL_WASM);
  const privacyChannelHash = await uploadWasm(server, admin, NETWORK_PASSPHRASE, privacyChannelWasm);
  const channelContractId = await deployPrivacyChannel(
    server, admin, NETWORK_PASSPHRASE,
    privacyChannelHash, channelAuthId, assetContractId,
  );
  console.log(`  Privacy Channel: ${channelContractId}`);

  // ── 5-7. Register council + channel via council-platform ──────────
  console.log("\n[5/12] Admin authenticates to council-platform");
  const adminCouncilJwt = await walletAuth(COUNCIL_URL, "/api/v1/admin/auth", admin);
  console.log("  Admin JWT acquired");

  console.log("\n[6/12] Admin creates the council");
  const createRes = await fetch(`${COUNCIL_URL}/api/v1/council/metadata`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${adminCouncilJwt}`,
    },
    body: JSON.stringify({
      councilId: channelAuthId,
      name: `Testnet E2E ${new Date().toISOString().slice(0, 19)}`,
      description: "Ephemeral council created by testnet e2e",
      contactEmail: "testnet-e2e@moonlight.test",
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Create council failed: ${createRes.status} ${await createRes.text()}`);
  }
  console.log("  Council created");

  console.log("\n[7/12] Admin adds the channel");
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
    throw new Error(`Add channel failed: ${addChannelRes.status} ${await addChannelRes.text()}`);
  }
  const addChannelBody = await addChannelRes.json();
  const channelDbId: string = addChannelBody.data?.id;
  if (!channelDbId) {
    throw new Error("Add channel response missing data.id");
  }
  console.log(`  Channel added (id ${channelDbId})`);

  // ── 8. Register PP + join via provider-platform ───────────────────
  console.log("\n[8/12] Register PP and submit join request");
  const dashboardJwt = await walletAuth(PROVIDER_URL, "/api/v1/dashboard/auth", ppOperator);
  console.log("  Dashboard JWT acquired");

  const regRes = await fetch(`${PROVIDER_URL}/api/v1/dashboard/pp/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${dashboardJwt}`,
    },
    body: JSON.stringify({
      secretKey: ppOperator.secret(),
      derivationIndex: 0,
      label: "Testnet E2E PP",
    }),
  });
  if (!regRes.ok) {
    throw new Error(`PP register failed: ${regRes.status} ${await regRes.text()}`);
  }
  console.log(`  PP registered: ${ppOperator.publicKey()}`);

  const joinPayload = {
    publicKey: ppOperator.publicKey(),
    councilId: channelAuthId,
    label: "Testnet E2E PP",
    contactEmail: "pp@testnet-e2e.moonlight.test",
  };
  const signedEnvelope = await signJoinEnvelope(joinPayload, ppOperator);
  const joinRes = await fetch(`${PROVIDER_URL}/api/v1/dashboard/council/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${dashboardJwt}`,
    },
    body: JSON.stringify({
      councilUrl: COUNCIL_URL,
      councilId: channelAuthId,
      councilName: "Testnet E2E Council",
      ppPublicKey: ppOperator.publicKey(),
      label: "Testnet E2E PP",
      contactEmail: "pp@testnet-e2e.moonlight.test",
      signedEnvelope,
    }),
  });
  if (!joinRes.ok) {
    throw new Error(`Join request failed: ${joinRes.status} ${await joinRes.text()}`);
  }
  const joinBody = await joinRes.json();
  console.log(`  Join request submitted: ${joinBody.data?.joinRequestId} (PENDING)`);

  // ── 9. Admin approves + on-chain add_provider ─────────────────────
  console.log("\n[9/12] Admin approves join request");
  const listRes = await fetch(
    `${COUNCIL_URL}/api/v1/council/provider-requests?councilId=${encodeURIComponent(channelAuthId)}`,
    { headers: { "Authorization": `Bearer ${adminCouncilJwt}` } },
  );
  if (!listRes.ok) {
    throw new Error(`List join requests failed: ${listRes.status} ${await listRes.text()}`);
  }
  const { data: requests } = await listRes.json();
  const ourRequest = requests?.find?.(
    (r: { publicKey: string }) => r.publicKey === ppOperator.publicKey(),
  );
  if (!ourRequest) {
    throw new Error(`Could not find our join request among ${requests?.length ?? 0} requests`);
  }

  const approveRes = await fetch(
    `${COUNCIL_URL}/api/v1/council/provider-requests/${ourRequest.id}/approve`,
    { method: "POST", headers: { "Authorization": `Bearer ${adminCouncilJwt}` } },
  );
  if (!approveRes.ok) {
    throw new Error(`Approve failed: ${approveRes.status} ${await approveRes.text()}`);
  }
  console.log("  Join request approved");

  console.log("  Calling on-chain add_provider...");
  const addTx = await addProvider(
    server, admin, NETWORK_PASSPHRASE, channelAuthId, ppOperator.publicKey(),
  );
  if (!verifyEvent(extractEvents(addTx), "provider_added", true).found) {
    throw new Error("provider_added event not emitted");
  }
  console.log("  provider_added event verified");

  // ── 10. Wait for ACTIVE ───────────────────────────────────────────
  console.log("\n[10/12] Waiting for membership to become ACTIVE");
  await pollMembershipActive(ppOperator.publicKey(), dashboardJwt);
  console.log("  Membership ACTIVE");

  // ── Drive cp signing/escrow APIs to emit cp#28 spans ──────────────
  const ppCouncilJwt = await walletAuth(COUNCIL_URL, "/api/v1/admin/auth", ppOperator);
  await exerciseCouncilSpans({
    councilUrl: COUNCIL_URL,
    ppCouncilJwt,
    adminCouncilJwt,
    councilId: channelAuthId,
    channelContractId,
    channelDbId,
    recipientAddress: ppOperator.publicKey(),
    senderAddress: ppOperator.publicKey(),
    assetCode: "XLM",
  });

  // ── 11. Payment flow ──────────────────────────────────────────────
  console.log(`\n[11/12] Payment flow (deposit ${DEPOSIT_AMOUNT}, send ${SEND_AMOUNT}, withdraw ${WITHDRAW_AMOUNT})`);

  const horizonUrl = Deno.env.get("HORIZON_URL") ?? "https://horizon-testnet.stellar.org";
  const networkConfig = NetworkConfig.CustomNet({
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    horizonUrl,
    friendbotUrl: FRIENDBOT_URL,
    allowHttp: RPC_URL.startsWith("http://"),
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
    providerSecretKey: ppOperator.secret(),
  };

  let alice: Keypair, bob: Keypair;
  if (masterSecret) {
    const seed = await masterSeedFromSecret(masterSecret);
    alice = await deriveKeypair(seed, ROLES.ALICE, 0);
    bob = await deriveKeypair(seed, ROLES.BOB, 0);
  } else {
    alice = Keypair.random();
    bob = Keypair.random();
  }
  console.log(`  Alice: ${alice.publicKey()}`);
  console.log(`  Bob:   ${bob.publicKey()}`);

  await fundAccount(alice.publicKey());
  await fundAccount(bob.publicKey());
  console.log("  Users funded");

  const aliceJwt = await withE2ESpan("e2e.authenticate_alice", () =>
    authenticate(alice, e2eConfig));
  console.log("  Alice authenticated");

  const bobJwt = await withE2ESpan("e2e.authenticate_bob", () =>
    authenticate(bob, e2eConfig));
  console.log("  Bob authenticated");

  await withE2ESpan("e2e.deposit", () =>
    deposit(alice.secret(), DEPOSIT_AMOUNT, aliceJwt, e2eConfig, sdkTracer));
  console.log(`  Deposit ${DEPOSIT_AMOUNT} XLM complete`);

  const receiverOps = await withE2ESpan("e2e.prepare_receive", () =>
    prepareReceive(bob.secret(), SEND_AMOUNT, e2eConfig, sdkTracer));

  await withE2ESpan("e2e.send", () =>
    send(alice.secret(), receiverOps, SEND_AMOUNT, aliceJwt, e2eConfig, sdkTracer));
  console.log(`  Send ${SEND_AMOUNT} XLM complete`);

  await withE2ESpan("e2e.withdraw", () =>
    withdraw(bob.secret(), bob.publicKey(), WITHDRAW_AMOUNT, bobJwt, e2eConfig, sdkTracer));
  console.log(`  Withdraw ${WITHDRAW_AMOUNT} XLM complete`);

  // ── 12. Write trace IDs ───────────────────────────────────────────
  console.log("\n[12/12] Finalize");
  await writeTraceIds();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Testnet E2E passed in ${elapsed}s`);
  console.log(`\n  Council ID:    ${channelAuthId}`);
  console.log(`  Channel ID:    ${channelContractId}`);
  console.log(`  Asset SAC:     ${assetContractId}`);
  console.log(`  PP public key: ${ppOperator.publicKey()}\n`);
}

main().catch((err) => {
  console.error(`\n❌ Testnet E2E failed:`, err);
  Deno.exit(1);
});
