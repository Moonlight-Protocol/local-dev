/**
 * Local Dev — Council Setup
 *
 * Sets up a council against a running local-dev stack. This is the production
 * flow exercised end-to-end against the local Stellar node and the local
 * council-platform service. Steps mirror lifecycle/testnet-verify.ts:
 *
 *   1. Generate fresh admin keypair, fund via Friendbot
 *   2. Deploy Channel Auth contract → councilId
 *   3. Deploy native XLM SAC (or fetch existing)
 *   4. Deploy Privacy Channel contract → channelContractId
 *   5. Admin authenticates to council-platform → JWT
 *   6. Admin creates the council via PUT /council/metadata
 *   7. Admin adds the channel via POST /council/channels
 *   8. Write all IDs + admin SK to .local-dev-state for setup-pp.sh and the
 *      browser-wallet seed files to consume
 *
 * Why production-like: every API call here is the same one council-console
 * makes against the deployed council-platform. If a council-platform release
 * breaks the public surface, this script breaks too — that's the point.
 *
 * Prereqs:
 *   - up.sh has run (Stellar quickstart on :8000, council-platform on :3015)
 *
 * Usage (preferred — via wrapper):
 *   ./setup-c.sh
 *
 * Usage (direct):
 *   deno run --allow-all lifecycle/setup-c.ts
 *
 * Env overrides:
 *   STELLAR_RPC_URL          default http://localhost:8000/soroban/rpc
 *   FRIENDBOT_URL            default http://localhost:8000/friendbot
 *   STELLAR_NETWORK_PASSPHRASE default "Standalone Network ; February 2017"
 *   COUNCIL_URL              default http://localhost:3015
 *   STATE_FILE               default ../.local-dev-state
 *   COUNCIL_NAME             default "Local Council"
 *   CHANNEL_AUTH_WASM        default ../e2e/wasms/channel_auth_contract.wasm
 *   PRIVACY_CHANNEL_WASM     default ../e2e/wasms/privacy_channel.wasm
 */
import { Keypair } from "stellar-sdk";
import { Buffer } from "node:buffer";
import { createServer } from "./soroban.ts";
import {
  deployChannelAuth,
  deployPrivacyChannel,
  getOrDeployNativeSac,
  uploadWasm,
} from "./deploy.ts";
import { extractEvents, verifyEvent } from "./events.ts";

const RPC_URL = Deno.env.get("STELLAR_RPC_URL") ?? "http://localhost:8000/soroban/rpc";
const FRIENDBOT_URL = Deno.env.get("FRIENDBOT_URL") ?? "http://localhost:8000/friendbot";
const NETWORK_PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ??
  "Standalone Network ; February 2017";
const COUNCIL_URL = Deno.env.get("COUNCIL_URL") ?? "http://localhost:3015";
const STATE_FILE = Deno.env.get("STATE_FILE") ??
  new URL("../.local-dev-state", import.meta.url).pathname;
const COUNCIL_NAME = Deno.env.get("COUNCIL_NAME") ?? "Local Council";
const CHANNEL_AUTH_WASM = Deno.env.get("CHANNEL_AUTH_WASM") ??
  new URL("../e2e/wasms/channel_auth_contract.wasm", import.meta.url).pathname;
const PRIVACY_CHANNEL_WASM = Deno.env.get("PRIVACY_CHANNEL_WASM") ??
  new URL("../e2e/wasms/privacy_channel.wasm", import.meta.url).pathname;

async function fundAccount(publicKey: string): Promise<void> {
  // Friendbot returns 200 on first fund, 400 "already funded" on retry. Both fine.
  const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(
      `Friendbot failed for ${publicKey}: ${res.status} ${await res.text()}`,
    );
  }
}

async function warmupCouncil(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${COUNCIL_URL}/api/v1/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`council-platform not reachable at ${COUNCIL_URL}`);
}

/** SEP-43/53 wallet auth: challenge → sign → verify → JWT. */
async function walletAuth(keypair: Keypair): Promise<string> {
  const challengeRes = await fetch(`${COUNCIL_URL}/api/v1/admin/auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: keypair.publicKey() }),
  });
  if (!challengeRes.ok) {
    throw new Error(
      `Council auth challenge failed: ${challengeRes.status} ${await challengeRes.text()}`,
    );
  }
  const { data: { nonce } } = await challengeRes.json();

  // The nonce is a base64-encoded random 32 bytes. We sign the raw bytes —
  // council-platform's verifier accepts SEP-43, SEP-53, or raw formats.
  const nonceBytes = Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0));
  const sig = keypair.sign(Buffer.from(nonceBytes));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));

  const verifyRes = await fetch(`${COUNCIL_URL}/api/v1/admin/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, signature, publicKey: keypair.publicKey() }),
  });
  if (!verifyRes.ok) {
    throw new Error(
      `Council auth verify failed: ${verifyRes.status} ${await verifyRes.text()}`,
    );
  }
  const { data: { token } } = await verifyRes.json();
  return token;
}

async function writeStateFile(state: Record<string, string>): Promise<void> {
  const lines = [
    "# Generated by setup-c.sh — regenerated on every run.",
    "# Consumed by setup-pp.sh and other follow-up scripts.",
    `# Created: ${new Date().toISOString()}`,
    "",
    ...Object.entries(state).map(([k, v]) => `${k}=${v}`),
    "",
  ];
  await Deno.writeTextFile(STATE_FILE, lines.join("\n"));
}

async function main() {
  const startTime = Date.now();

  console.log("\n=== local-dev — Council Setup ===\n");
  console.log(`  RPC:        ${RPC_URL}`);
  console.log(`  Friendbot:  ${FRIENDBOT_URL}`);
  console.log(`  Council:    ${COUNCIL_URL}`);
  console.log(`  State file: ${STATE_FILE}`);

  console.log("\n[1/8] Warmup council-platform");
  await warmupCouncil();
  console.log("  council-platform reachable");

  // Ephemeral admin key. Each setup-c run creates a fresh council — there's no
  // way to "reuse" a council across deployments because the contracts that
  // identify it are themselves redeployed (Soroban quickstart is non-persistent).
  const admin = Keypair.random();
  console.log(`\n  Admin: ${admin.publicKey()}`);

  console.log("\n[2/8] Funding admin via Friendbot");
  await fundAccount(admin.publicKey());
  console.log("  Admin funded");

  console.log("\n[3/8] Deploy Channel Auth contract");
  const server = createServer(RPC_URL, true);
  const channelAuthWasm = await Deno.readFile(CHANNEL_AUTH_WASM);
  const channelAuthHash = await uploadWasm(server, admin, NETWORK_PASSPHRASE, channelAuthWasm);
  const { contractId: channelAuthId, txResponse: authDeployTx } =
    await deployChannelAuth(server, admin, NETWORK_PASSPHRASE, channelAuthHash);
  if (verifyEvent(extractEvents(authDeployTx), "contract_initialized", true).found) {
    console.log("  contract_initialized event verified");
  }
  console.log(`  Channel Auth: ${channelAuthId}`);

  console.log("\n[4/8] Deploy native XLM SAC");
  const assetContractId = await getOrDeployNativeSac(server, admin, NETWORK_PASSPHRASE);
  console.log(`  XLM SAC: ${assetContractId}`);

  console.log("\n[5/8] Deploy Privacy Channel contract");
  const privacyChannelWasm = await Deno.readFile(PRIVACY_CHANNEL_WASM);
  const privacyChannelHash = await uploadWasm(server, admin, NETWORK_PASSPHRASE, privacyChannelWasm);
  const channelContractId = await deployPrivacyChannel(
    server,
    admin,
    NETWORK_PASSPHRASE,
    privacyChannelHash,
    channelAuthId,
    assetContractId,
  );
  console.log(`  Privacy Channel: ${channelContractId}`);

  console.log("\n[6/8] Admin authenticates to council-platform");
  const adminJwt = await walletAuth(admin);
  console.log("  Admin JWT acquired");

  console.log("\n[7/8] Admin creates council + adds channel");
  const createRes = await fetch(`${COUNCIL_URL}/api/v1/council/metadata`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${adminJwt}`,
    },
    body: JSON.stringify({
      councilId: channelAuthId,
      name: COUNCIL_NAME,
      description: "Local-dev council created by setup-c.sh",
      contactEmail: "local-dev@moonlight.test",
    }),
  });
  if (!createRes.ok) {
    throw new Error(
      `Create council failed: ${createRes.status} ${await createRes.text()}`,
    );
  }
  console.log(`  Council created: ${channelAuthId}`);

  const addChannelRes = await fetch(
    `${COUNCIL_URL}/api/v1/council/channels?councilId=${encodeURIComponent(channelAuthId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${adminJwt}`,
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
    throw new Error(
      `Add channel failed: ${addChannelRes.status} ${await addChannelRes.text()}`,
    );
  }
  console.log(`  Channel added: ${channelContractId} (XLM)`);

  console.log("\n[8/8] Write state file");
  await writeStateFile({
    ADMIN_PK: admin.publicKey(),
    ADMIN_SK: admin.secret(),
    COUNCIL_ID: channelAuthId,
    CHANNEL_ID: channelContractId,
    ASSET_ID: assetContractId,
    COUNCIL_URL,
    NETWORK_PASSPHRASE,
    RPC_URL,
    FRIENDBOT_URL,
  });
  console.log(`  State written to ${STATE_FILE}`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Council setup complete in ${elapsed}s ===\n`);
  console.log(`  Admin:           ${admin.publicKey()}`);
  console.log(`  Council ID:      ${channelAuthId}`);
  console.log(`  Privacy Channel: ${channelContractId}`);
  console.log(`  XLM SAC:         ${assetContractId}`);
  console.log("");
  console.log("Next: ./setup-pp.sh to register a privacy provider in this council.");
  console.log("");
}

main().catch((err) => {
  console.error("\n=== Council setup FAILED ===");
  console.error(err);
  Deno.exit(1);
});
