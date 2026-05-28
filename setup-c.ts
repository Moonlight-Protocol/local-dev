/**
 * Local Dev — Council Setup (multi-council)
 *
 * Creates THREE councils against the local stack, each with its own
 * channel-auth + privacy-channel contracts, name, and accepted jurisdictions.
 * Drives the full production API surface for every council.
 *
 *   Mercado Libre Mercosur   — AR, BR, UY, PY
 *   Amazon Europe            — GB, FR, DE, ES, IT
 *   Amazon North America     — US, MX, CA
 *
 * Steps per council:
 *   1. Deploy Channel Auth contract (deterministic salt per council index)
 *   2. Deploy Privacy Channel contract (deterministic salt per council index)
 *   3. PUT /council/metadata (name + description)
 *   4. POST /council/channels (XLM channel)
 *   5. POST /council/jurisdictions (one per jurisdiction)
 *
 * Shared:
 *   - Native XLM SAC is deployed once and reused for all 3 councils
 *   - Admin keypair is shared
 *   - JWT is per-council via SEP-43 challenge/verify
 *
 * State file format (.local-dev-state) keys:
 *   ADMIN_PK, ADMIN_SK, ASSET_ID, COUNCIL_URL, NETWORK_PASSPHRASE,
 *   RPC_URL, FRIENDBOT_URL,
 *   COUNCIL_COUNT,
 *   COUNCIL_<i>_ID, COUNCIL_<i>_NAME, COUNCIL_<i>_CHANNEL,
 *   COUNCIL_<i>_JURISDICTIONS  (comma-separated, e.g. AR,BR,UY,PY)
 *
 * Prereqs:
 *   - up.sh has run (Stellar quickstart on :8000, council-platform on :3015)
 *
 * Usage:
 *   ./setup-c.sh
 */
import { Keypair } from "npm:@stellar/stellar-sdk@14.2.0";
import { Buffer } from "node:buffer";
import { createServer } from "./lib/soroban.ts";
import {
  deployChannelAuth,
  deployPrivacyChannel,
  getOrDeployNativeSac,
  uploadWasm,
} from "./lib/deploy.ts";
import { extractEvents, verifyEvent } from "./lib/events.ts";

const RPC_URL = Deno.env.get("STELLAR_RPC_URL") ??
  "http://localhost:8000/soroban/rpc";
const FRIENDBOT_URL = Deno.env.get("FRIENDBOT_URL") ??
  "http://localhost:8000/friendbot";
const NETWORK_PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ??
  "Standalone Network ; February 2017";
const COUNCIL_URL = Deno.env.get("COUNCIL_URL") ?? "http://localhost:3015";
const STATE_FILE = Deno.env.get("STATE_FILE") ??
  new URL("./.local-dev-state", import.meta.url).pathname;
const CHANNEL_AUTH_WASM = Deno.env.get("CHANNEL_AUTH_WASM") ??
  new URL("./e2e/wasms/channel_auth_contract.wasm", import.meta.url).pathname;
const PRIVACY_CHANNEL_WASM = Deno.env.get("PRIVACY_CHANNEL_WASM") ??
  new URL("./e2e/wasms/privacy_channel.wasm", import.meta.url).pathname;

const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") ??
  "SAQCGLJ2JISI67QGG457IBN2DY6YW5GGS2OMQU5KNLXB3TWVUIR2RD74";
const CHANNEL_AUTH_SALT_BASE = Deno.env.get("CHANNEL_AUTH_SALT_HEX") ??
  "4c4f43414c5f43415554";
const PRIVACY_CHANNEL_SALT_BASE = Deno.env.get("PRIVACY_CHANNEL_SALT_HEX") ??
  "4c4f43414c5f50434843";

interface CouncilSpec {
  name: string;
  jurisdictions: string[];
}

const COUNCILS: CouncilSpec[] = [
  {
    name: "Mercado Libre Mercosur",
    jurisdictions: ["AR", "BR", "UY", "PY"],
  },
  {
    name: "Amazon Europe",
    jurisdictions: ["GB", "FR", "DE", "ES", "IT"],
  },
  {
    name: "Amazon North America",
    jurisdictions: ["US", "MX", "CA"],
  },
];

function hexToFixedBuffer(hex: string, length = 32): Buffer {
  const bytes = Buffer.alloc(length);
  const data = Buffer.from(hex, "hex");
  data.copy(bytes, length - data.length);
  return bytes;
}

function saltForCouncil(baseHex: string, index: number): Buffer {
  // Append 4 hex digits of the index so each council gets a distinct salt
  // (and therefore a distinct deterministic contract ID).
  const idxHex = index.toString(16).padStart(4, "0");
  return hexToFixedBuffer(baseHex + idxHex);
}

async function fundAccount(publicKey: string): Promise<void> {
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

async function walletAuth(keypair: Keypair): Promise<string> {
  const challengeRes = await fetch(
    `${COUNCIL_URL}/api/v1/admin/auth/challenge`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: keypair.publicKey() }),
    },
  );
  if (!challengeRes.ok) {
    throw new Error(
      `Council auth challenge failed: ${challengeRes.status} ${await challengeRes
        .text()}`,
    );
  }
  const { data: { nonce } } = await challengeRes.json();

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
      `Council auth verify failed: ${verifyRes.status} ${await verifyRes
        .text()}`,
    );
  }
  const { data: { token } } = await verifyRes.json();
  return token;
}

async function writeStateFile(state: Record<string, string>): Promise<void> {
  const lines = [
    "# Generated by setup-c.sh — regenerated on every run.",
    "# Consumed by setup-pp.sh, setup-pay.sh, send-loop.sh.",
    `# Created: ${new Date().toISOString()}`,
    "",
    ...Object.entries(state).map(([k, v]) => `${k}=${v}`),
    "",
  ];
  await Deno.writeTextFile(STATE_FILE, lines.join("\n"));
}

interface DeployedCouncil {
  spec: CouncilSpec;
  index: number;
  channelAuthId: string;
  channelContractId: string;
}

async function setupOneCouncil(
  spec: CouncilSpec,
  index: number,
  admin: Keypair,
  // deno-lint-ignore no-explicit-any
  server: any,
  assetContractId: string,
  channelAuthWasmHash: Buffer,
  privacyChannelWasmHash: Buffer,
): Promise<DeployedCouncil> {
  const tag = `[${index + 1}/${COUNCILS.length}] ${spec.name}`;
  console.log(`\n=== ${tag} ===`);

  console.log("  Deploying Channel Auth…");
  const channelAuthSalt = saltForCouncil(CHANNEL_AUTH_SALT_BASE, index);
  const { contractId: channelAuthId, txResponse: authDeployTx } =
    await deployChannelAuth(
      server,
      admin,
      NETWORK_PASSPHRASE,
      channelAuthWasmHash,
      channelAuthSalt,
    );
  if (
    verifyEvent(extractEvents(authDeployTx), "contract_initialized", true).found
  ) {
    console.log("    contract_initialized event verified");
  }
  console.log(`    Channel Auth: ${channelAuthId}`);

  console.log("  Deploying Privacy Channel…");
  const privacyChannelSalt = saltForCouncil(PRIVACY_CHANNEL_SALT_BASE, index);
  const channelContractId = await deployPrivacyChannel(
    server,
    admin,
    NETWORK_PASSPHRASE,
    privacyChannelWasmHash,
    channelAuthId,
    assetContractId,
    privacyChannelSalt,
  );
  console.log(`    Privacy Channel: ${channelContractId}`);

  console.log("  Authenticating admin to council-platform…");
  const adminJwt = await walletAuth(admin);

  console.log("  Creating council metadata…");
  const createRes = await fetch(`${COUNCIL_URL}/api/v1/council/metadata`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${adminJwt}`,
    },
    body: JSON.stringify({
      councilId: channelAuthId,
      name: spec.name,
      description: `Local-dev council: ${spec.name}`,
      contactEmail: "local-dev@moonlight.test",
    }),
  });
  if (!createRes.ok) {
    throw new Error(
      `Create council failed: ${createRes.status} ${await createRes.text()}`,
    );
  }
  console.log(`    Council created: ${channelAuthId}`);

  console.log("  Adding XLM channel…");
  const addChannelRes = await fetch(
    `${COUNCIL_URL}/api/v1/council/channels?councilId=${
      encodeURIComponent(channelAuthId)
    }`,
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
      `Add channel failed: ${addChannelRes.status} ${await addChannelRes
        .text()}`,
    );
  }

  console.log("  Adding jurisdictions…");
  for (const j of spec.jurisdictions) {
    const r = await fetch(
      `${COUNCIL_URL}/api/v1/council/jurisdictions?councilId=${
        encodeURIComponent(channelAuthId)
      }`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${adminJwt}`,
        },
        body: JSON.stringify({ countryCode: j }),
      },
    );
    if (!r.ok) {
      throw new Error(
        `Add jurisdiction ${j} failed: ${r.status} ${await r.text()}`,
      );
    }
    console.log(`    + ${j}`);
  }

  return { spec, index, channelAuthId, channelContractId };
}

async function main() {
  const startTime = Date.now();

  console.log("\n=== local-dev — Council Setup (multi-council) ===\n");
  console.log(`  RPC:        ${RPC_URL}`);
  console.log(`  Friendbot:  ${FRIENDBOT_URL}`);
  console.log(`  Council:    ${COUNCIL_URL}`);
  console.log(`  State file: ${STATE_FILE}`);
  console.log(`  Councils to create: ${COUNCILS.length}`);

  console.log("\n[1/4] Warmup council-platform");
  await warmupCouncil();
  console.log("  council-platform reachable");

  const admin = Keypair.fromSecret(ADMIN_SECRET);
  console.log(`  Admin: ${admin.publicKey()}`);

  console.log("\n[2/4] Funding admin via Friendbot");
  await fundAccount(admin.publicKey());

  console.log("\n[3/4] Pre-deploy: WASM upload + native XLM SAC");
  const server = createServer(RPC_URL, true);
  const channelAuthWasm = await Deno.readFile(CHANNEL_AUTH_WASM);
  const channelAuthHash = await uploadWasm(
    server,
    admin,
    NETWORK_PASSPHRASE,
    channelAuthWasm,
  );
  console.log(`  Channel Auth WASM hash: ${channelAuthHash.toString("hex")}`);

  const privacyChannelWasm = await Deno.readFile(PRIVACY_CHANNEL_WASM);
  const privacyChannelHash = await uploadWasm(
    server,
    admin,
    NETWORK_PASSPHRASE,
    privacyChannelWasm,
  );
  console.log(
    `  Privacy Channel WASM hash: ${privacyChannelHash.toString("hex")}`,
  );

  const assetContractId = await getOrDeployNativeSac(
    server,
    admin,
    NETWORK_PASSPHRASE,
  );
  console.log(`  XLM SAC: ${assetContractId}`);

  console.log(`\n[4/4] Setting up ${COUNCILS.length} councils`);
  const deployed: DeployedCouncil[] = [];
  for (let i = 0; i < COUNCILS.length; i++) {
    deployed.push(
      await setupOneCouncil(
        COUNCILS[i],
        i,
        admin,
        server,
        assetContractId,
        channelAuthHash,
        privacyChannelHash,
      ),
    );
  }

  console.log("\nWriting state file…");
  const state: Record<string, string> = {
    ADMIN_PK: admin.publicKey(),
    ADMIN_SK: admin.secret(),
    ASSET_ID: assetContractId,
    COUNCIL_URL,
    NETWORK_PASSPHRASE,
    RPC_URL,
    FRIENDBOT_URL,
    COUNCIL_COUNT: String(deployed.length),
  };
  for (const d of deployed) {
    const i = d.index + 1;
    state[`COUNCIL_${i}_ID`] = d.channelAuthId;
    state[`COUNCIL_${i}_NAME`] = d.spec.name;
    state[`COUNCIL_${i}_CHANNEL`] = d.channelContractId;
    state[`COUNCIL_${i}_JURISDICTIONS`] = d.spec.jurisdictions.join(",");
  }
  await writeStateFile(state);
  console.log(`  State written to ${STATE_FILE}`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Council setup complete in ${elapsed}s ===\n`);
  for (const d of deployed) {
    console.log(`  ${d.spec.name}`);
    console.log(`    Council ID:      ${d.channelAuthId}`);
    console.log(`    Privacy Channel: ${d.channelContractId}`);
    console.log(`    Jurisdictions:   ${d.spec.jurisdictions.join(", ")}`);
  }
  console.log("");
  console.log(
    "Next: ./setup-pp.sh to register the 12 PPs across the councils.",
  );
}

main().catch((err) => {
  console.error("\n=== Council setup FAILED ===");
  console.error(err);
  Deno.exit(1);
});
