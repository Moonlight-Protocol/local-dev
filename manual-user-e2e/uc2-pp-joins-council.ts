/**
 * UC2: PP Joins a Council — Manual User-Flow Simulation
 *
 * Simulates the full UC2 flow that a user would perform through the UI:
 *   1. PP operator authenticates with provider-platform
 *   2. PP discovers a council by pasting its URL
 *   3. PP submits a signed join request
 *   4. Council admin authenticates with council-platform
 *   5. Council admin approves the request (on-chain add_provider is skipped here)
 *   6. PP detects approval via refresh-status (polls membership-status endpoint)
 *   7. PP membership becomes ACTIVE with config
 *
 * Requires: local-dev stack running (./up.sh). Creates its own council.
 *
 * Usage:
 *   deno task uc2
 */
import { Keypair } from "stellar-sdk";
import { Buffer } from "buffer";

// --- Config ---

function loadEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const content = Deno.readTextFileSync(path);
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  } catch { /* file not found */ }
  return env;
}

const BASE_DIR = Deno.env.get("BASE_DIR") ?? `${Deno.env.get("HOME")}/repos`;
const providerEnv = loadEnvFile(`${BASE_DIR}/provider-platform/.env`);
const councilEnv = loadEnvFile(`${BASE_DIR}/council-platform/.env`);

const PROVIDER_API = Deno.env.get("PROVIDER_API") ?? `http://localhost:${providerEnv["PORT"] ?? "3010"}/api/v1`;
const COUNCIL_API = Deno.env.get("COUNCIL_API") ?? `http://localhost:${councilEnv["PORT"] ?? "3015"}/api/v1`;
const COUNCIL_URL = COUNCIL_API.replace("/api/v1", "");

const PROVIDER_SK = providerEnv["PROVIDER_SK"] ?? Deno.env.get("PROVIDER_SK");
const COUNCIL_SK = councilEnv["COUNCIL_SK"] ?? Deno.env.get("COUNCIL_SK");
const CHANNEL_AUTH_ID = councilEnv["CHANNEL_AUTH_ID"] ?? Deno.env.get("CHANNEL_AUTH_ID");
const CHANNEL_CONTRACT_ID = providerEnv["CHANNEL_CONTRACT_ID"] ?? Deno.env.get("CHANNEL_CONTRACT_ID");

if (!PROVIDER_SK) { console.error("PROVIDER_SK not found in provider-platform/.env or env"); Deno.exit(1); }
if (!COUNCIL_SK) { console.error("COUNCIL_SK not found in council-platform/.env or env"); Deno.exit(1); }
if (!CHANNEL_AUTH_ID) { console.error("CHANNEL_AUTH_ID not found in council-platform/.env or env"); Deno.exit(1); }

const providerKp = Keypair.fromSecret(PROVIDER_SK);
const councilKp = Keypair.fromSecret(COUNCIL_SK);

// --- Helpers ---

async function auth(api: string, kp: Keypair, path: string): Promise<string> {
  const challengeRes = await fetch(`${api}${path}/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: kp.publicKey() }),
  });
  if (!challengeRes.ok) throw new Error(`Challenge failed: ${challengeRes.status} ${await challengeRes.text()}`);
  const { data: { nonce } } = await challengeRes.json();

  const raw = Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0));
  const sig = btoa(String.fromCharCode(...kp.sign(Buffer.from(raw))));

  const verifyRes = await fetch(`${api}${path}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, signature: sig, publicKey: kp.publicKey() }),
  });
  if (!verifyRes.ok) throw new Error(`Verify failed: ${verifyRes.status} ${await verifyRes.text()}`);
  const { data: { token } } = await verifyRes.json();
  return token;
}

async function apiPost(api: string, path: string, body: unknown, token: string) {
  const res = await fetch(`${api}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  return { status: res.status, data };
}

async function apiPut(api: string, path: string, body: unknown, token: string) {
  const res = await fetch(`${api}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  return { status: res.status, data };
}

async function apiGet(api: string, path: string, token: string) {
  const res = await fetch(`${api}${path}`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  return { status: res.status, data: await res.json() };
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    failures++;
  }
}

// --- Flow ---

console.log("\n\x1b[34m=== UC2: PP Joins a Council ===\x1b[0m\n");
console.log(`Provider API: ${PROVIDER_API}`);
console.log(`Council API:  ${COUNCIL_API}`);
console.log(`Provider PK:  ${providerKp.publicKey()}`);
console.log(`Council PK:   ${councilKp.publicKey()}`);

// Step 0: Set up council (simulates UC1 completion)
console.log("\n\x1b[36m[0/7] Setting up council\x1b[0m");
const setupToken = await auth(COUNCIL_API, councilKp, "/admin/auth");
check("Council admin authenticated for setup", !!setupToken, true);

const metaRes = await apiPut(COUNCIL_API, "/council/metadata", {
  councilId: CHANNEL_AUTH_ID,
  name: "E2E Test Council",
  description: "Created by UC2 manual E2E test",
  contactEmail: "council@test.local",
}, setupToken);
check("Council metadata created", metaRes.status, 200);

const jurRes = await apiPost(COUNCIL_API, `/council/jurisdictions?councilId=${CHANNEL_AUTH_ID}`, {
  countryCode: "UY",
  label: "Uruguay",
}, setupToken);
check("Jurisdiction added", jurRes.status === 200 || jurRes.status === 409, true);

const chRes = await apiPost(COUNCIL_API, `/council/channels?councilId=${CHANNEL_AUTH_ID}`, {
  channelContractId: CHANNEL_CONTRACT_ID,
  assetCode: "XLM",
  label: "XLM Channel",
}, setupToken);
check("Channel registered", chRes.status === 200 || chRes.status === 409, true);

// Step 1: PP operator authenticates and registers
console.log("\n\x1b[36m[1/7] PP operator authenticates\x1b[0m");
const ppToken = await auth(PROVIDER_API, providerKp, "/dashboard/auth");
check("Provider got JWT", !!ppToken, true);

const regRes = await apiPost(PROVIDER_API, "/dashboard/pp/register", {
  secretKey: PROVIDER_SK,
  label: "E2E Test Provider",
}, ppToken);
check("PP registered", regRes.status, 200);

// Step 2: PP discovers council
console.log("\n\x1b[36m[2/7] PP discovers council\x1b[0m");
const discover = await apiPost(PROVIDER_API, "/dashboard/council/discover", { councilUrl: `${COUNCIL_URL}?council=${CHANNEL_AUTH_ID}` }, ppToken);
check("Discovery status", discover.status, 200);
check("Council has name", !!discover.data.data?.council?.name, true);
check("Council has channelAuthId", !!discover.data.data?.council?.channelAuthId, true);
const councilName = discover.data.data?.council?.name;
const channelAuthId = discover.data.data?.council?.channelAuthId;
console.log(`  Council: ${councilName} (${channelAuthId})`);

// Step 3: PP submits join request
console.log("\n\x1b[36m[3/7] PP submits join request\x1b[0m");
const join = await apiPost(PROVIDER_API, "/dashboard/council/join", {
  councilUrl: discover.data.data?.councilUrl,
  councilId: channelAuthId,
  councilName,
  councilPublicKey: councilKp.publicKey(),
  ppPublicKey: providerKp.publicKey(),
  label: "E2E Test Provider",
  contactEmail: "e2e@test.local",
}, ppToken);
check("Join status", join.status, 200);
check("Join is PENDING", join.data.data?.status, "PENDING");

// Step 4: Council admin authenticates
console.log("\n\x1b[36m[4/7] Council admin authenticates\x1b[0m");
const councilToken = await auth(COUNCIL_API, councilKp, "/admin/auth");
check("Council admin got JWT", !!councilToken, true);

// Step 5: Council admin sees pending request
console.log("\n\x1b[36m[5/7] Council admin reviews requests\x1b[0m");
const pending = await apiGet(COUNCIL_API, `/council/provider-requests?councilId=${CHANNEL_AUTH_ID}&status=PENDING`, councilToken);
check("Has pending requests", pending.data.data?.length > 0, true);
const requestId = pending.data.data?.[0]?.id;
const requestPk = pending.data.data?.[0]?.publicKey;
console.log(`  Request: ${requestId} from ${requestPk?.slice(0, 8)}...`);

// Step 6: Council admin approves (on-chain add_provider skipped — requires wallet)
console.log("\n\x1b[36m[6/7] Council admin approves\x1b[0m");
const approve = await apiPost(COUNCIL_API, `/council/provider-requests/${requestId}/approve`, {}, councilToken);
check("Approve status", approve.status, 200);

// Step 7: PP detects approval via refresh-status
console.log("\n\x1b[36m[7/7] PP detects approval\x1b[0m");
const refresh = await apiPost(PROVIDER_API, "/dashboard/council/refresh-status", { ppPublicKey: providerKp.publicKey() }, ppToken);
check("Refresh detects ACTIVE", refresh.data.data?.status, "ACTIVE");

const membership = await apiGet(PROVIDER_API, `/dashboard/council/membership?ppPublicKey=${encodeURIComponent(providerKp.publicKey())}`, ppToken);
check("Membership is ACTIVE", membership.data.data?.status, "ACTIVE");
check("Membership has config", !!membership.data.data?.config, true);

// --- Summary ---
console.log(`\n\x1b[34m=== ${failures === 0 ? "\x1b[32mALL PASSED" : `\x1b[31m${failures} FAILED`} \x1b[34m===\x1b[0m\n`);
if (failures > 0) Deno.exit(1);
