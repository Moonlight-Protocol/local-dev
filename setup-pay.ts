/**
 * Local Dev — Pay Platform Setup
 *
 * Seeds pay-platform with council + PP routing configuration via the admin API.
 * This runs AFTER setup-c.sh and setup-pp.sh — it reads their outputs from
 * .local-dev-state and combines them with the PAY_ADMIN identity from
 * .local-dev-keys.
 *
 * Steps:
 *   1. Load PAY_ADMIN keypair from env (passed by setup-pay.sh wrapper)
 *   2. Load council/channel/asset IDs + PP info from .local-dev-state
 *   3. Fund PAY_ADMIN via Friendbot (needed for wallet auth challenge)
 *   4. PAY_ADMIN authenticates to pay-platform → JWT
 *   5. Create council record via POST /admin/councils
 *   6. Create PP record via POST /admin/councils/:id/pps
 *
 * Why production-like: the admin API endpoints exercised here are the same
 * ones an admin console would call. If pay-platform's admin surface breaks,
 * this script breaks too — that's the point.
 *
 * Prereqs:
 *   - up.sh has run (pay-platform on :3025 with ADMIN_WALLETS set)
 *   - setup-c.sh has run (.local-dev-state has council IDs)
 *   - setup-pp.sh has run (.local-dev-state has PP_PK + PROVIDER_URL)
 *
 * Env (set by setup-pay.sh wrapper):
 *   PAY_ADMIN_PK              required
 *   PAY_ADMIN_SK              required
 *
 * Env overrides:
 *   PAY_PLATFORM_URL          default http://localhost:3025
 *   FRIENDBOT_URL             default http://localhost:8000/friendbot
 *   STATE_FILE                default ./.local-dev-state
 */
import { Keypair } from "npm:@stellar/stellar-sdk@14.2.0";

const PAY_ADMIN_PK = Deno.env.get("PAY_ADMIN_PK");
const PAY_ADMIN_SK = Deno.env.get("PAY_ADMIN_SK");
if (!PAY_ADMIN_PK || !PAY_ADMIN_SK) {
  throw new Error("PAY_ADMIN_PK and PAY_ADMIN_SK must be set (via setup-pay.sh wrapper)");
}

const PAY_PLATFORM_URL = Deno.env.get("PAY_PLATFORM_URL") ?? "http://localhost:3025";
const PAY_API = `${PAY_PLATFORM_URL}/api/v1`;
const FRIENDBOT_URL = Deno.env.get("FRIENDBOT_URL") ?? "http://localhost:8000/friendbot";
const STATE_FILE = Deno.env.get("STATE_FILE") ??
  new URL("./.local-dev-state", import.meta.url).pathname;

interface State {
  COUNCIL_ID: string;
  CHANNEL_ID: string;
  ASSET_ID: string;
  NETWORK_PASSPHRASE: string;
  PP_PK: string;
  PROVIDER_URL: string;
}

async function loadState(): Promise<State> {
  let content: string;
  try {
    content = await Deno.readTextFile(STATE_FILE);
  } catch {
    throw new Error(
      `State file not found at ${STATE_FILE}. Run setup-c.sh and setup-pp.sh first.`,
    );
  }
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  const required = ["COUNCIL_ID", "CHANNEL_ID", "ASSET_ID", "NETWORK_PASSPHRASE", "PP_PK", "PROVIDER_URL"];
  for (const key of required) {
    if (!env[key]) {
      throw new Error(`State file missing ${key}. Run setup-c.sh and setup-pp.sh first.`);
    }
  }
  return env as unknown as State;
}

async function fundAccount(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(
      `Friendbot failed for ${publicKey}: ${res.status} ${await res.text()}`,
    );
  }
}

async function warmupPay(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${PAY_API}/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`pay-platform not reachable at ${PAY_PLATFORM_URL}`);
}

/** Wallet auth: challenge → sign nonce → verify → JWT. */
async function walletAuth(keypair: Keypair): Promise<string> {
  const challengeRes = await fetch(`${PAY_API}/auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: keypair.publicKey() }),
  });
  if (!challengeRes.ok) {
    throw new Error(
      `Auth challenge failed: ${challengeRes.status} ${await challengeRes.text()}`,
    );
  }
  const { data: { nonce } } = await challengeRes.json();

  const nonceBytes = Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0));
  const sig = keypair.sign(Buffer.from(nonceBytes));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));

  const verifyRes = await fetch(`${PAY_API}/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, signature, publicKey: keypair.publicKey() }),
  });
  if (!verifyRes.ok) {
    throw new Error(
      `Auth verify failed: ${verifyRes.status} ${await verifyRes.text()}`,
    );
  }
  const { data: { token } } = await verifyRes.json();
  return token;
}

async function main() {
  const startTime = Date.now();

  console.log("\n=== local-dev — Pay Platform Setup ===\n");

  console.log("[1/6] Load state from setup-c + setup-pp");
  const state = await loadState();
  console.log(`  Council ID:       ${state.COUNCIL_ID}`);
  console.log(`  Privacy Channel:  ${state.CHANNEL_ID}`);
  console.log(`  XLM SAC:          ${state.ASSET_ID}`);
  console.log(`  PP public key:    ${state.PP_PK}`);
  console.log(`  Provider URL:     ${state.PROVIDER_URL}`);

  console.log("\n[2/6] Warmup pay-platform");
  await warmupPay();
  console.log("  pay-platform reachable");

  const payAdmin = Keypair.fromSecret(PAY_ADMIN_SK);
  console.log(`\n  Pay Admin: ${payAdmin.publicKey()}`);

  console.log("\n[3/6] Fund PAY_ADMIN via Friendbot");
  await fundAccount(payAdmin.publicKey());
  console.log("  PAY_ADMIN funded");

  console.log("\n[4/6] PAY_ADMIN authenticates to pay-platform");
  const jwt = await walletAuth(payAdmin);
  console.log("  JWT acquired");

  console.log("\n[5/8] Create council via POST /admin/councils");
  const councilRes = await fetch(`${PAY_API}/admin/councils`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      name: "Local Council",
      channelAuthId: state.COUNCIL_ID,
      networkPassphrase: state.NETWORK_PASSPHRASE,
      channels: [
        {
          assetCode: "XLM",
          assetContractId: state.ASSET_ID,
          privacyChannelId: state.CHANNEL_ID,
        },
      ],
      jurisdictions: ["US", "UY", "BR", "AR", "FR"],
      active: true,
    }),
  });
  if (!councilRes.ok) {
    throw new Error(
      `Create council failed: ${councilRes.status} ${await councilRes.text()}`,
    );
  }
  const { data: council } = await councilRes.json();
  console.log(`  Council created: ${council.id}`);

  console.log("\n[6/8] Create PP via POST /admin/councils/:id/pps");
  const ppRes = await fetch(`${PAY_API}/admin/councils/${council.id}/pps`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      name: "Local PP",
      url: state.PROVIDER_URL,
      publicKey: state.PP_PK,
      active: true,
    }),
  });
  if (!ppRes.ok) {
    throw new Error(
      `Create PP failed: ${ppRes.status} ${await ppRes.text()}`,
    );
  }
  const { data: pp } = await ppRes.json();
  console.log(`  PP created: ${pp.id}`);

  // Fund the PAY_SERVICE keypair so it can authenticate with provider-platform
  const payServicePk = Deno.env.get("PAY_SERVICE_PK");
  if (payServicePk) {
    console.log("\n[7/8] Fund PAY_SERVICE via Friendbot");
    await fundAccount(payServicePk);
    console.log(`  PAY_SERVICE funded: ${payServicePk}`);
  } else {
    console.log("\n[7/8] PAY_SERVICE_PK not set — skipping fund");
  }

  console.log("\n[8/8] Verify council config");
  const verifyRes = await fetch(`${PAY_API}/admin/councils/${council.id}`, {
    headers: { "Authorization": `Bearer ${jwt}` },
  });
  if (verifyRes.ok) {
    const { data: full } = await verifyRes.json();
    console.log(`  Channels: ${full.channels?.length ?? 0}`);
    console.log(`  Jurisdictions: ${full.jurisdictions?.join(", ") ?? "none"}`);
    console.log(`  PPs: ${full.pps?.length ?? 0}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Pay Platform setup complete in ${elapsed}s ===\n`);
  console.log(`  Council DB ID:  ${council.id}`);
  console.log(`  Council Auth:   ${state.COUNCIL_ID}`);
  console.log(`  PP DB ID:       ${pp.id}`);
  console.log(`  PP public key:  ${state.PP_PK}`);
  console.log(`  Provider URL:   ${state.PROVIDER_URL}`);
  if (payServicePk) {
    console.log(`  Service key:    ${payServicePk}`);
  }
  console.log("");
  console.log("Pay-platform now has the council + PP routing config needed");
  console.log("for the POS instant payment flow.");
  console.log("");
}

main().catch((err) => {
  console.error("\n=== Pay Platform setup FAILED ===");
  console.error(err);
  Deno.exit(1);
});
