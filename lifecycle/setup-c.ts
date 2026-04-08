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

// ─── DETERMINISTIC LOCAL-DEV IDENTITY ──────────────────────────────────
//
// Fixed admin secret + fixed contract salts → same admin G-address and
// same channel-auth / privacy-channel contract IDs every run. This means
// the wallet's seed file (channel contract ID) and any tooling that
// references the council ID can be set ONCE and never change across
// `down → up → setup-c` cycles.
//
// SAFETY: this secret is for local-dev against `Standalone Network ;
// February 2017` ONLY. It is hard-coded in source so it must NEVER be
// reused on testnet/mainnet. The Friendbot funding is gated to the local
// network passphrase via FRIENDBOT_URL above.
//
// Override with env vars if you want to register a separate admin
// (e.g. testing multi-council scenarios on the local stack).
//
// Admin G-address: GAEILCNSC4ZTA63RK3ACSADVSWC47NRG7KFVYHZ4HKS265YEZVEHWMHG
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") ??
  "SAQCGLJ2JISI67QGG457IBN2DY6YW5GGS2OMQU5KNLXB3TWVUIR2RD74";
// Salts are arbitrary 32-byte values. hexToFixedBuffer pads with leading
// zeros so a 20-hex-char tail is fine. The tails spell "LOCAL_CAUT" and
// "LOCAL_PCHC" — recognizable in logs/dumps and obviously dev-only.
const CHANNEL_AUTH_SALT_HEX = Deno.env.get("CHANNEL_AUTH_SALT_HEX") ??
  "4c4f43414c5f43415554"; // "LOCAL_CAUT"
const PRIVACY_CHANNEL_SALT_HEX = Deno.env.get("PRIVACY_CHANNEL_SALT_HEX") ??
  "4c4f43414c5f50434843"; // "LOCAL_PCHC"

function hexToFixedBuffer(hex: string, length = 32): Buffer {
  const bytes = Buffer.alloc(length);
  const data = Buffer.from(hex, "hex");
  data.copy(bytes, length - data.length);
  return bytes;
}

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

  // Deterministic admin keypair — same address every run. See header comment.
  const admin = Keypair.fromSecret(ADMIN_SECRET);
  console.log(`\n  Admin: ${admin.publicKey()}`);

  console.log("\n[2/8] Funding admin via Friendbot");
  await fundAccount(admin.publicKey());
  console.log("  Admin funded");

  console.log("\n[3/8] Deploy Channel Auth contract");
  const server = createServer(RPC_URL, true);
  const channelAuthWasm = await Deno.readFile(CHANNEL_AUTH_WASM);
  const channelAuthHash = await uploadWasm(server, admin, NETWORK_PASSPHRASE, channelAuthWasm);
  // Fixed salt → deterministic contract ID across runs.
  const channelAuthSalt = hexToFixedBuffer(CHANNEL_AUTH_SALT_HEX);
  const { contractId: channelAuthId, txResponse: authDeployTx } =
    await deployChannelAuth(server, admin, NETWORK_PASSPHRASE, channelAuthHash, channelAuthSalt);
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
  // Fixed salt → deterministic contract ID across runs.
  const privacyChannelSalt = hexToFixedBuffer(PRIVACY_CHANNEL_SALT_HEX);
  const channelContractId = await deployPrivacyChannel(
    server,
    admin,
    NETWORK_PASSPHRASE,
    privacyChannelHash,
    channelAuthId,
    assetContractId,
    privacyChannelSalt,
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
