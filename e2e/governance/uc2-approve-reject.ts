import { Keypair, Address, Contract, TransactionBuilder, rpc } from "npm:@stellar/stellar-sdk";
import { Buffer } from "node:buffer";

const PROVIDER_API = Deno.env.get("PROVIDER_API") ?? "http://localhost:3010/api/v1";
const COUNCIL_API = Deno.env.get("COUNCIL_API") ?? "http://localhost:3015/api/v1";
const COUNCIL_URL = Deno.env.get("COUNCIL_URL") ?? COUNCIL_API.replace("/api/v1", "");
const STELLAR_RPC_URL = Deno.env.get("STELLAR_RPC_URL") ?? "http://localhost:8000/soroban/rpc";
const NETWORK_PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ?? "Standalone Network ; February 2017";

function loadEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const line of Deno.readTextFileSync(path).split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      env[t.slice(0, eq)] = t.slice(eq + 1);
    }
  } catch { }
  return env;
}

const BASE = Deno.env.get("BASE_DIR") ?? `${Deno.env.get("HOME")}/repos`;
const councilEnv = loadEnv(`${BASE}/council-platform/.env`);
const providerEnv = loadEnv(`${BASE}/provider-platform/.env`);

const COUNCIL_SK = Deno.env.get("E2E_COUNCIL_SK") ?? Deno.env.get("COUNCIL_SK") ?? councilEnv["COUNCIL_SK"]!;
const AUTH_ID = Deno.env.get("E2E_CHANNEL_AUTH_ID") ?? Deno.env.get("CHANNEL_AUTH_ID") ?? councilEnv["CHANNEL_AUTH_ID"]!;
const CHANNEL_ID = Deno.env.get("E2E_CHANNEL_CONTRACT_ID") ?? Deno.env.get("CHANNEL_CONTRACT_ID") ?? providerEnv["CHANNEL_CONTRACT_ID"]!;
const councilKp = Keypair.fromSecret(COUNCIL_SK);

async function auth(api: string, kp: Keypair, path: string): Promise<string> {
  const c = await (await fetch(`${api}${path}/challenge`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: kp.publicKey() }),
  })).json();
  const raw = Uint8Array.from(atob(c.data.nonce), c => c.charCodeAt(0));
  const sig = btoa(String.fromCharCode(...kp.sign(Buffer.from(raw))));
  const v = await (await fetch(`${api}${path}/verify`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce: c.data.nonce, signature: sig, publicKey: kp.publicKey() }),
  })).json();
  return v.data.token;
}

async function post(api: string, path: string, body: unknown, token: string) {
  const res = await fetch(`${api}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : {} };
}

async function put(api: string, path: string, body: unknown, token: string) {
  const res = await fetch(`${api}${path}`, {
    method: "PUT", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : {} };
}

async function signJoinPayload(payload: Record<string, unknown>, kp: Keypair) {
  const timestamp = Date.now();
  const canonical = JSON.stringify({ payload, timestamp });
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  const sig = Buffer.from(kp.sign(Buffer.from(hash))).toString("base64");
  return { payload, signature: sig, publicKey: kp.publicKey(), timestamp };
}

async function get(api: string, path: string, token: string) {
  const res = await fetch(`${api}${path}`, { headers: { "Authorization": `Bearer ${token}` } });
  return { status: res.status, data: await res.json() };
}

async function addProviderOnChain(adminKp: Keypair, channelAuthId: string, providerPk: string): Promise<void> {
  const server = new rpc.Server(STELLAR_RPC_URL, { allowHttp: true });
  const contract = new Contract(channelAuthId);
  const op = contract.call("add_provider", new Address(providerPk).toScVal());

  const account = await server.getAccount(adminKp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if ("error" in sim && sim.error) throw new Error(`add_provider simulation failed: ${sim.error}`);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(adminKp);
  const sent = await server.sendTransaction(prepared);

  // Wait for confirmation
  for (let i = 0; i < 30; i++) {
    const status = await server.getTransaction(sent.hash);
    if (status.status === "SUCCESS") return;
    if (status.status === "FAILED") throw new Error("add_provider tx failed");
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("add_provider tx timed out");
}

async function waitForMembershipStatus(ppPublicKey: string, expectedStatus: string, token: string, timeoutMs = 60000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const m = await get(PROVIDER_API, `/dashboard/council/membership?ppPublicKey=${ppPublicKey}`, token);
    if (m.data.data?.status === expectedStatus) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
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

// --- Setup ---
console.log("\n\x1b[34m=== Setup: Create Council ===\x1b[0m");
const councilToken = await auth(COUNCIL_API, councilKp, "/admin/auth");

const metaRes = await put(COUNCIL_API, "/council/metadata", {
  councilId: AUTH_ID, name: "Test Council", description: "Auto test", contactEmail: "c@t.l",
}, councilToken);
check("Council created", metaRes.status, 200);

await post(COUNCIL_API, `/council/jurisdictions?councilId=${AUTH_ID}`, { countryCode: "UY", label: "Uruguay" }, councilToken);
await post(COUNCIL_API, `/council/channels?councilId=${AUTH_ID}`, { channelContractId: CHANNEL_ID, assetCode: "XLM" }, councilToken);

// PP operator auth
const operatorKp = Keypair.random();
const dashToken = await auth(PROVIDER_API, operatorKp, "/dashboard/auth");

// --- Test 1: Approve flow ---
console.log("\n\x1b[34m=== Test 1: PP → join → approve → ACTIVE ===\x1b[0m");
const pp1 = Keypair.random();
await post(PROVIDER_API, "/dashboard/pp/register", { secretKey: pp1.secret(), derivationIndex: 0, label: "PP-Approve" }, dashToken);

const j1Envelope = await signJoinPayload({ publicKey: pp1.publicKey(), councilId: AUTH_ID, label: "PP-Approve", contactEmail: "a@t", jurisdictions: null }, pp1);
const j1 = await post(PROVIDER_API, "/dashboard/council/join", {
  councilUrl: COUNCIL_URL,
  councilId: AUTH_ID, councilName: "Test Council", councilPublicKey: councilKp.publicKey(),
  ppPublicKey: pp1.publicKey(), signedEnvelope: j1Envelope,
}, dashToken);
check("Join submitted", j1.data.data?.status, "PENDING");

const m1pre = await get(PROVIDER_API, `/dashboard/council/membership?ppPublicKey=${pp1.publicKey()}`, dashToken);
check("Provider: PENDING before approve", m1pre.data.data?.status, "PENDING");

// Verify membership-status endpoint shows PENDING (102)
const ms1pre = await fetch(`${COUNCIL_API}/public/provider/membership-status?councilId=${AUTH_ID}&publicKey=${pp1.publicKey()}`);
check("Membership-status: PENDING (202)", ms1pre.status, 202);

const p1 = await get(COUNCIL_API, `/council/provider-requests?councilId=${AUTH_ID}&status=PENDING`, councilToken);
const r1entry = p1.data.data?.find((r: any) => r.publicKey === pp1.publicKey());
const r1id = r1entry?.id;
check("Council: pending request exists", !!r1id, true);
check("Council: request label matches", r1entry?.label, "PP-Approve");

const a1 = await post(COUNCIL_API, `/council/provider-requests/${r1id}/approve`, {}, councilToken);
check("Approve succeeded", a1.status, 200);

// Council's membership-status should show ACTIVE (200) since approve creates a provider record
const ms1post = await fetch(`${COUNCIL_API}/public/provider/membership-status?councilId=${AUTH_ID}&publicKey=${pp1.publicKey()}`);
check("Membership-status: ACTIVE (200)", ms1post.status, 200);

const cr1 = await get(COUNCIL_API, `/council/provider-requests?councilId=${AUTH_ID}`, councilToken);
const cr1entry = cr1.data.data?.find((r: any) => r.publicKey === pp1.publicKey());
check("Council: shows APPROVED", cr1entry?.status, "APPROVED");

// On-chain: add_provider → event watcher should activate provider-platform's membership
await addProviderOnChain(councilKp, AUTH_ID, pp1.publicKey());
check("add_provider on-chain", true, true);

// Wait for event watcher to detect and activate
const ewActivated = await waitForMembershipStatus(pp1.publicKey(), "ACTIVE", dashToken);
check("Event watcher activated membership", ewActivated, true);

// --- Test 2: Reject flow ---
console.log("\n\x1b[34m=== Test 2: PP → join → reject → REJECTED ===\x1b[0m");
const pp2 = Keypair.random();
await post(PROVIDER_API, "/dashboard/pp/register", { secretKey: pp2.secret(), derivationIndex: 1, label: "PP-Reject" }, dashToken);

const j2Envelope = await signJoinPayload({ publicKey: pp2.publicKey(), councilId: AUTH_ID, label: "PP-Reject", contactEmail: "r@t", jurisdictions: null }, pp2);
const j2 = await post(PROVIDER_API, "/dashboard/council/join", {
  councilUrl: COUNCIL_URL,
  councilId: AUTH_ID, councilName: "Test Council", councilPublicKey: councilKp.publicKey(),
  ppPublicKey: pp2.publicKey(), signedEnvelope: j2Envelope,
}, dashToken);
check("Join submitted", j2.data.data?.status, "PENDING");

const p2 = await get(COUNCIL_API, `/council/provider-requests?councilId=${AUTH_ID}&status=PENDING`, councilToken);
const r2entry = p2.data.data?.find((r: any) => r.publicKey === pp2.publicKey());
const r2id = r2entry?.id;
check("Council: pending request exists", !!r2id, true);

const rej = await post(COUNCIL_API, `/council/provider-requests/${r2id}/reject`, {}, councilToken);
check("Reject succeeded", rej.status, 200);

const cr2 = await get(COUNCIL_API, `/council/provider-requests?councilId=${AUTH_ID}`, councilToken);
const cr2entry = cr2.data.data?.find((r: any) => r.publicKey === pp2.publicKey());
check("Council: shows REJECTED", cr2entry?.status, "REJECTED");

// Membership-status should return 404 (not found — council hides rejected status to prevent enumeration)
const ms2 = await fetch(`${COUNCIL_API}/public/provider/membership-status?councilId=${AUTH_ID}&publicKey=${pp2.publicKey()}`);
check("Membership-status: REJECTED (404)", ms2.status, 404);

// Sync rejection to provider-platform (simulates UI polling)
const sync2 = await post(PROVIDER_API, "/dashboard/council/membership", { ppPublicKey: pp2.publicKey() }, dashToken);
check("Provider synced to REJECTED", sync2.data.data?.status, "REJECTED");


// --- Test 3: PP with no council ---
console.log("\n\x1b[34m=== Test 3: PP with no council ===\x1b[0m");
const pp3 = Keypair.random();
await post(PROVIDER_API, "/dashboard/pp/register", { secretKey: pp3.secret(), derivationIndex: 2, label: "PP-None" }, dashToken);
const m3 = await get(PROVIDER_API, `/dashboard/council/membership?ppPublicKey=${pp3.publicKey()}`, dashToken);
check("No membership", m3.data.data, null);

// --- Test 4: PP list ---
console.log("\n\x1b[34m=== Test 4: PP list ===\x1b[0m");
const list = await get(PROVIDER_API, "/dashboard/pp/list", dashToken);
check("3 PPs", list.data.data?.length, 3);

const la = list.data.data?.find((p: any) => p.label === "PP-Approve");
const lr = list.data.data?.find((p: any) => p.label === "PP-Reject");
const ln = list.data.data?.find((p: any) => p.label === "PP-None");
check("PP-Approve: ACTIVE", la?.councilMembership?.status, "ACTIVE");
check("PP-Reject: REJECTED", lr?.councilMembership?.status, "REJECTED");
check("PP-None: no council", ln?.councilMembership, null);

// --- Test 5: Council shows both ---
console.log("\n\x1b[34m=== Test 5: Council requests list ===\x1b[0m");
const allCr = await get(COUNCIL_API, `/council/provider-requests?councilId=${AUTH_ID}`, councilToken);
check("2 requests total", allCr.data.data?.length, 2);
const approved = allCr.data.data?.find((r: any) => r.label === "PP-Approve");
const rejected = allCr.data.data?.find((r: any) => r.label === "PP-Reject");
check("PP-Approve: APPROVED", approved?.status, "APPROVED");
check("PP-Reject: REJECTED", rejected?.status, "REJECTED");

// --- Test 6: Duplicate join request returns 409 ---
console.log("\n\x1b[34m=== Test 6: Duplicate join request → 409 ===\x1b[0m");
const pp6 = Keypair.random();
await post(PROVIDER_API, "/dashboard/pp/register", { secretKey: pp6.secret(), derivationIndex: 3, label: "PP-Dup" }, dashToken);

const j6aEnvelope = await signJoinPayload({ publicKey: pp6.publicKey(), councilId: AUTH_ID, label: "PP-Dup", contactEmail: "dup@t", jurisdictions: null }, pp6);
const j6a = await post(PROVIDER_API, "/dashboard/council/join", {
  councilUrl: COUNCIL_URL,
  councilId: AUTH_ID, councilName: "Test Council", councilPublicKey: councilKp.publicKey(),
  ppPublicKey: pp6.publicKey(), signedEnvelope: j6aEnvelope,
}, dashToken);
check("First join succeeds", j6a.data.data?.status, "PENDING");

const j6bEnvelope = await signJoinPayload({ publicKey: pp6.publicKey(), councilId: AUTH_ID, label: "PP-Dup", contactEmail: "dup@t", jurisdictions: null }, pp6);
const j6b = await post(PROVIDER_API, "/dashboard/council/join", {
  councilUrl: COUNCIL_URL,
  councilId: AUTH_ID, councilName: "Test Council", councilPublicKey: councilKp.publicKey(),
  ppPublicKey: pp6.publicKey(), signedEnvelope: j6bEnvelope,
}, dashToken);
check("Duplicate join returns 409", j6b.status, 409);

// --- Test 7: Membership-status edge cases ---
console.log("\n\x1b[34m=== Test 7: Membership-status endpoint ===\x1b[0m");
// Missing params
const msBad = await fetch(`${COUNCIL_API}/public/provider/membership-status`);
check("Missing params → 400", msBad.status, 400);

// Unknown PP → 404
const msUnknown = await fetch(`${COUNCIL_API}/public/provider/membership-status?councilId=${AUTH_ID}&publicKey=${Keypair.random().publicKey()}`);
check("Unknown PP → 404", msUnknown.status, 404);

// --- Test 8: Multiple PPs join same council ---
console.log("\n\x1b[34m=== Test 8: Multiple PPs join same council ===\x1b[0m");
const pp8a = Keypair.random();
const pp8b = Keypair.random();
await post(PROVIDER_API, "/dashboard/pp/register", { secretKey: pp8a.secret(), derivationIndex: 4, label: "PP-Multi-A" }, dashToken);
await post(PROVIDER_API, "/dashboard/pp/register", { secretKey: pp8b.secret(), derivationIndex: 5, label: "PP-Multi-B" }, dashToken);

const j8aEnvelope = await signJoinPayload({ publicKey: pp8a.publicKey(), councilId: AUTH_ID, label: "PP-Multi-A", contactEmail: null, jurisdictions: null }, pp8a);
const j8a = await post(PROVIDER_API, "/dashboard/council/join", {
  councilUrl: COUNCIL_URL,
  councilId: AUTH_ID, councilName: "Test Council", councilPublicKey: councilKp.publicKey(),
  ppPublicKey: pp8a.publicKey(), signedEnvelope: j8aEnvelope,
}, dashToken);
check("PP-Multi-A join", j8a.data.data?.status, "PENDING");

const j8bEnvelope = await signJoinPayload({ publicKey: pp8b.publicKey(), councilId: AUTH_ID, label: "PP-Multi-B", contactEmail: null, jurisdictions: null }, pp8b);
const j8b = await post(PROVIDER_API, "/dashboard/council/join", {
  councilUrl: COUNCIL_URL,
  councilId: AUTH_ID, councilName: "Test Council", councilPublicKey: councilKp.publicKey(),
  ppPublicKey: pp8b.publicKey(), signedEnvelope: j8bEnvelope,
}, dashToken);
check("PP-Multi-B join", j8b.data.data?.status, "PENDING");

// Approve both
const pendingMulti = await get(COUNCIL_API, `/council/provider-requests?councilId=${AUTH_ID}&status=PENDING`, councilToken);
const multiReqs = pendingMulti.data.data?.filter((r: any) => r.label === "PP-Multi-A" || r.label === "PP-Multi-B");
check("Multiple pending requests", multiReqs?.length >= 2, true);

for (const req of multiReqs || []) {
  await post(COUNCIL_API, `/council/provider-requests/${req.id}/approve`, {}, councilToken);
}

// Both PPs should be ACTIVE via membership-status
const ms8a = await fetch(`${COUNCIL_API}/public/provider/membership-status?councilId=${AUTH_ID}&publicKey=${pp8a.publicKey()}`);
const ms8b = await fetch(`${COUNCIL_API}/public/provider/membership-status?councilId=${AUTH_ID}&publicKey=${pp8b.publicKey()}`);
check("PP-Multi-A ACTIVE", ms8a.status, 200);
check("PP-Multi-B ACTIVE", ms8b.status, 200);

// Both show in council
const allProviders = await get(COUNCIL_API, `/council/provider-requests?councilId=${AUTH_ID}`, councilToken);
const multiA = allProviders.data.data?.find((r: any) => r.label === "PP-Multi-A");
const multiB = allProviders.data.data?.find((r: any) => r.label === "PP-Multi-B");
check("Council: PP-Multi-A APPROVED", multiA?.status, "APPROVED");
check("Council: PP-Multi-B APPROVED", multiB?.status, "APPROVED");

// --- Test 9: Second council ---
console.log("\n\x1b[34m=== Test 9: PP joins a different council ===\x1b[0m");
const council2Id = "CFAKECOUNCIL2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const meta2 = await put(COUNCIL_API, "/council/metadata", {
  councilId: council2Id, name: "Council 2", description: "Second council",
}, councilToken);
check("Council 2 created", meta2.status, 200);

await post(COUNCIL_API, `/council/jurisdictions?councilId=${council2Id}`, { countryCode: "BR", label: "Brazil" }, councilToken);

const pp9 = Keypair.random();
await post(PROVIDER_API, "/dashboard/pp/register", { secretKey: pp9.secret(), derivationIndex: 6, label: "PP-Council2" }, dashToken);

const j9Envelope = await signJoinPayload({ publicKey: pp9.publicKey(), councilId: council2Id, label: "PP-Council2", contactEmail: null, jurisdictions: null }, pp9);
const j9 = await post(PROVIDER_API, "/dashboard/council/join", {
  councilUrl: COUNCIL_URL,
  councilId: council2Id, councilName: "Council 2", councilPublicKey: councilKp.publicKey(),
  ppPublicKey: pp9.publicKey(), signedEnvelope: j9Envelope,
}, dashToken);
check("Join council 2", j9.data.data?.status, "PENDING");

// Council 2 requests should only show PP-Council2
const c2reqs = await get(COUNCIL_API, `/council/provider-requests?councilId=${council2Id}`, councilToken);
check("Council 2: 1 request", c2reqs.data.data?.length, 1);
check("Council 2: correct PP", c2reqs.data.data?.[0]?.label, "PP-Council2");

// Council 1 requests should NOT include PP-Council2
const c1reqs = await get(COUNCIL_API, `/council/provider-requests?councilId=${AUTH_ID}`, councilToken);
const c1HasC2pp = c1reqs.data.data?.find((r: any) => r.label === "PP-Council2");
check("Council 1: does NOT have Council2's PP", c1HasC2pp, undefined);

// --- Summary ---
console.log(`\n\x1b[34m=== ${failures === 0 ? "\x1b[32mALL PASSED" : `\x1b[31m${failures} FAILED`} \x1b[34m===\x1b[0m\n`)
if (failures > 0) Deno.exit(1);
