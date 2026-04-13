/**
 * Local Dev — Privacy Provider Setup
 *
 * Registers a Privacy Provider in the council created by setup-c.sh. This
 * exercises the production join flow end-to-end against the local stack:
 *
 *   1. Load admin SK + council ID from .local-dev-state (written by setup-c.sh)
 *   2. Generate a fresh PP operator keypair, fund via Friendbot
 *   3. PP operator authenticates to provider-platform dashboard → JWT
 *   4. PP operator registers a PP via POST /dashboard/pp/register
 *   5. PP operator submits a signed join envelope via POST /dashboard/council/join
 *      (provider-platform forwards it to council-platform's join-request endpoint)
 *   6. Admin (loaded from state) authenticates to council-platform → JWT
 *   7. Admin lists pending join requests, finds ours, calls
 *      POST /council/provider-requests/:id/approve
 *   8. Admin calls add_provider on-chain (channel-auth contract)
 *   9. Wait for provider-platform's event watcher to flip the membership ACTIVE
 *  10. Append PP info to .local-dev-state
 *
 * Why production-like: every step here is the same one council-console and
 * provider-console make. If a platform release breaks the public surface, this
 * script breaks too — that's the point.
 *
 * Prereqs:
 *   - up.sh has run (Stellar quickstart, postgres, jaeger, both platforms)
 *   - setup-c.sh has run (.local-dev-state exists with admin + council IDs)
 *
 * Idempotency: each run generates a fresh PP keypair. Re-running will register
 * a second PP in the same council (multi-PP). To "reset", run down → up →
 * setup-c → setup-pp.
 *
 * Usage (preferred — via wrapper):
 *   ./setup-pp.sh
 *
 * Usage (direct):
 *   deno run --allow-all setup-pp.ts
 *
 * Env overrides:
 *   STELLAR_RPC_URL          default http://localhost:8000/soroban/rpc
 *   FRIENDBOT_URL            default http://localhost:8000/friendbot
 *   STELLAR_NETWORK_PASSPHRASE default "Standalone Network ; February 2017"
 *   COUNCIL_URL              default (loaded from state file)
 *   PROVIDER_URL             default http://localhost:3010
 *   STATE_FILE               default ./.local-dev-state
 *   PP_LABEL                 default "Local PP"
 */
import { Keypair } from "npm:@stellar/stellar-sdk@14.2.0";
import { Buffer } from "node:buffer";
import { createServer } from "./lib/soroban.ts";
import { addProvider } from "./lib/admin.ts";
import { extractEvents, verifyEvent } from "./lib/events.ts";

const RPC_URL = Deno.env.get("STELLAR_RPC_URL") ?? "http://localhost:8000/soroban/rpc";
const FRIENDBOT_URL = Deno.env.get("FRIENDBOT_URL") ?? "http://localhost:8000/friendbot";
const NETWORK_PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ??
  "Standalone Network ; February 2017";
const PROVIDER_URL = Deno.env.get("PROVIDER_URL") ?? "http://localhost:3010";
const STATE_FILE = Deno.env.get("STATE_FILE") ??
  new URL("./.local-dev-state", import.meta.url).pathname;
const PP_LABEL = Deno.env.get("PP_LABEL") ?? "Local PP";

// ─── DETERMINISTIC LOCAL-DEV PP IDENTITY ───────────────────────────────
//
// Same fixed-secret approach as setup-c.ts. Re-running setup-pp against
// a fresh `up.sh` ledger registers the SAME PP G-address — so any client
// that has the PP's pubkey baked in (the wallet's seed file, manual test
// configs, etc.) keeps working without updates.
//
// SAFETY: local-dev only. See setup-c.ts for the same warning.
//
// PP G-address: GBW7TE4PGNEKFAH7DRZBA3CDQIFLNT22ZQO2G5DJSNRGKCS5PYKTIMWV
const PP_SECRET = Deno.env.get("PP_SECRET") ??
  "SDRTOKYHEEVBDTC3QPFKKGS5EGTFSXM4B6HTGO2JLY6ZRH4XHICZQTLI";

interface State {
  ADMIN_SK: string;
  ADMIN_PK: string;
  COUNCIL_ID: string;
  CHANNEL_ID: string;
  ASSET_ID: string;
  COUNCIL_URL: string;
}

async function loadState(): Promise<State> {
  let content: string;
  try {
    content = await Deno.readTextFile(STATE_FILE);
  } catch {
    throw new Error(
      `State file not found at ${STATE_FILE}. Run setup-c.sh first.`,
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
  const required = ["ADMIN_SK", "ADMIN_PK", "COUNCIL_ID", "CHANNEL_ID", "ASSET_ID", "COUNCIL_URL"];
  for (const key of required) {
    if (!env[key]) {
      throw new Error(
        `State file missing ${key}. Re-run setup-c.sh.`,
      );
    }
  }
  return env as unknown as State;
}

async function appendStateLines(lines: Record<string, string>): Promise<void> {
  const block = [
    "",
    "# Appended by setup-pp.sh",
    `# Created: ${new Date().toISOString()}`,
    ...Object.entries(lines).map(([k, v]) => `${k}=${v}`),
    "",
  ].join("\n");
  await Deno.writeTextFile(STATE_FILE, block, { append: true });
}

async function fundAccount(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(
      `Friendbot failed for ${publicKey}: ${res.status} ${await res.text()}`,
    );
  }
}

async function warmupService(name: string, url: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${url}/api/v1/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${name} not reachable at ${url}`);
}

/** Wallet auth: challenge → sign nonce → verify → JWT. */
async function walletAuth(
  baseUrl: string,
  authRoute: string,
  keypair: Keypair,
): Promise<string> {
  const challengeRes = await fetch(`${baseUrl}${authRoute}/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: keypair.publicKey() }),
  });
  if (!challengeRes.ok) {
    throw new Error(
      `Auth challenge failed (${baseUrl}${authRoute}): ${challengeRes.status} ${await challengeRes.text()}`,
    );
  }
  const { data: { nonce } } = await challengeRes.json();

  const nonceBytes = Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0));
  const sig = keypair.sign(Buffer.from(nonceBytes));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));

  const verifyRes = await fetch(`${baseUrl}${authRoute}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, signature, publicKey: keypair.publicKey() }),
  });
  if (!verifyRes.ok) {
    throw new Error(
      `Auth verify failed (${baseUrl}${authRoute}): ${verifyRes.status} ${await verifyRes.text()}`,
    );
  }
  const { data: { token } } = await verifyRes.json();
  return token;
}

/** Sign a join request envelope (matches council-platform's signed-payload.ts). */
async function signJoinEnvelope<T>(
  payload: T,
  keypair: Keypair,
): Promise<{ payload: T; signature: string; publicKey: string; timestamp: number }> {
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

/** Poll provider-platform until the membership for ppPublicKey becomes ACTIVE. */
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
  throw new Error(
    `Membership for ${ppPublicKey} did not become ACTIVE after ${maxAttempts * intervalMs}ms. ` +
      `Check provider-platform's event watcher logs.`,
  );
}

async function main() {
  const startTime = Date.now();

  console.log("\n=== local-dev — Privacy Provider Setup ===\n");

  console.log("[1/10] Load council state from setup-c.sh");
  const state = await loadState();
  const admin = Keypair.fromSecret(state.ADMIN_SK);
  console.log(`  Admin:      ${state.ADMIN_PK}`);
  console.log(`  Council ID: ${state.COUNCIL_ID}`);
  console.log(`  Council:    ${state.COUNCIL_URL}`);
  console.log(`  Provider:   ${PROVIDER_URL}`);

  console.log("\n[2/10] Warmup provider-platform");
  await warmupService("provider-platform", PROVIDER_URL);
  console.log("  provider-platform reachable");

  // Deterministic PP operator key. Same address every run, so anything that
  // has the PP pubkey baked in (wallet seed, manual configs) keeps working
  // across `down`/`up` cycles. See PP_SECRET comment at the top of the file.
  const ppOperator = Keypair.fromSecret(PP_SECRET);
  console.log(`\n  PP Operator: ${ppOperator.publicKey()}`);

  console.log("\n[3/10] Funding PP operator via Friendbot");
  await fundAccount(ppOperator.publicKey());
  console.log("  PP Operator funded");

  console.log("\n[4/10] PP operator authenticates to provider-platform dashboard");
  const dashboardJwt = await walletAuth(
    PROVIDER_URL,
    "/api/v1/dashboard/auth",
    ppOperator,
  );
  console.log("  Dashboard JWT acquired");

  // For local-dev simplicity, the PP key IS the operator key (derivationIndex 0).
  // In production a PP operator would derive distinct keys per PP from a master
  // seed; here we cheat to keep the script linear.
  const ppKeypair = ppOperator;

  console.log("\n[5/10] Register PP via /dashboard/pp/register");
  const regRes = await fetch(`${PROVIDER_URL}/api/v1/dashboard/pp/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${dashboardJwt}`,
    },
    body: JSON.stringify({
      secretKey: ppKeypair.secret(),
      derivationIndex: 0,
      label: PP_LABEL,
    }),
  });
  if (!regRes.ok) {
    throw new Error(
      `PP register failed: ${regRes.status} ${await regRes.text()}`,
    );
  }
  console.log(`  PP registered: ${ppKeypair.publicKey()}`);

  console.log("\n[6/10] Submit signed join request");
  const joinPayload = {
    publicKey: ppKeypair.publicKey(),
    councilId: state.COUNCIL_ID,
    label: PP_LABEL,
    contactEmail: "pp@local-dev.moonlight.test",
  };
  const signedEnvelope = await signJoinEnvelope(joinPayload, ppKeypair);

  const joinRes = await fetch(`${PROVIDER_URL}/api/v1/dashboard/council/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${dashboardJwt}`,
    },
    body: JSON.stringify({
      councilUrl: state.COUNCIL_URL,
      councilId: state.COUNCIL_ID,
      councilName: "Local Council",
      ppPublicKey: ppKeypair.publicKey(),
      label: PP_LABEL,
      contactEmail: "pp@local-dev.moonlight.test",
      signedEnvelope,
    }),
  });
  if (!joinRes.ok) {
    throw new Error(
      `Join request failed: ${joinRes.status} ${await joinRes.text()}`,
    );
  }
  const joinBody = await joinRes.json();
  console.log(`  Join request submitted: ${joinBody.data?.joinRequestId} (PENDING)`);

  console.log("\n[7/10] Admin authenticates to council-platform");
  const adminJwt = await walletAuth(
    state.COUNCIL_URL,
    "/api/v1/admin/auth",
    admin,
  );
  console.log("  Admin JWT acquired");

  console.log("\n[8/10] Admin approves the join request");
  const listRes = await fetch(
    `${state.COUNCIL_URL}/api/v1/council/provider-requests?councilId=${encodeURIComponent(state.COUNCIL_ID)}`,
    { headers: { "Authorization": `Bearer ${adminJwt}` } },
  );
  if (!listRes.ok) {
    throw new Error(
      `List join requests failed: ${listRes.status} ${await listRes.text()}`,
    );
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
    `${state.COUNCIL_URL}/api/v1/council/provider-requests/${ourRequest.id}/approve`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${adminJwt}` },
    },
  );
  if (!approveRes.ok) {
    throw new Error(
      `Approve failed: ${approveRes.status} ${await approveRes.text()}`,
    );
  }
  console.log("  Join request approved (DB updated)");

  console.log("\n[9/10] Admin calls add_provider on-chain");
  const server = createServer(RPC_URL, true);
  const addTx = await addProvider(
    server,
    admin,
    NETWORK_PASSPHRASE,
    state.COUNCIL_ID,
    ppKeypair.publicKey(),
  );
  if (!verifyEvent(extractEvents(addTx), "provider_added", true).found) {
    throw new Error("provider_added event not emitted");
  }
  console.log("  provider_added event verified");

  console.log("\n[10/10] Wait for membership to become ACTIVE");
  await pollMembershipActive(ppKeypair.publicKey(), dashboardJwt);
  console.log("  Membership ACTIVE");

  await appendStateLines({
    PP_PK: ppKeypair.publicKey(),
    PP_SK: ppKeypair.secret(),
    PROVIDER_URL,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== PP setup complete in ${elapsed}s ===\n`);
  console.log(`  PP public key: ${ppKeypair.publicKey()}`);
  console.log(`  Council ID:    ${state.COUNCIL_ID}`);
  console.log(`  Channel ID:    ${state.CHANNEL_ID}`);
  console.log(`  Provider URL:  ${PROVIDER_URL}`);
  console.log("");
  console.log("The browser-wallet (or any client) can now authenticate against the");
  console.log("provider and submit bundles targeting the privacy channel.");
  console.log("");
}

main().catch((err) => {
  console.error("\n=== PP setup FAILED ===");
  console.error(err);
  Deno.exit(1);
});
