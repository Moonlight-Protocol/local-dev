/**
 * POS Instant Payment E2E test.
 *
 * Exercises the crypto-instant payment flow end-to-end:
 *   1. Create merchant + customer accounts on pay-platform
 *   2. Store merchant receive UTXOs
 *   3. Seed council + PP config via admin API
 *   4. Call /pay/instant/prepare → council config + merchant UTXOs
 *   5. Authenticate customer with provider-platform → JWT
 *   6. Generate temporary P256 keypairs for the one-hop transfer
 *   7. Build ONE atomic bundle:
 *      - DEPOSIT (customer signs, conditioned on temp CREATEs)
 *      - temp CREATEs (at temp P256 keys)
 *      - SPENDs from temp keys (signed with P256, conditioned on merchant CREATEs)
 *      - merchant CREATEs (at merchant receive UTXOs)
 *   8. Submit via pay-platform /pay/instant/submit
 *      (pay-platform proxies to provider-platform, records transaction, marks UTXOs spent)
 *   9. Verify transaction recorded + merchant balance updated
 *
 * This mirrors the flow in moonlight-pay/src/lib/instant-payment.ts
 * but without Freighter — the test signs with the customer's raw keypair.
 */
import { Keypair } from "stellar-sdk";
import { MoonlightOperation } from "@moonlight/moonlight-sdk";
import type { Ed25519PublicKey, ContractId } from "@colibri/core";
import { Buffer } from "node:buffer";

const PAY_API = Deno.env.get("PAY_API")!;
const PROVIDER_URL = Deno.env.get("PROVIDER_URL")!;
const STELLAR_RPC_URL = Deno.env.get("STELLAR_RPC_URL")!;
const FRIENDBOT_URL = Deno.env.get("FRIENDBOT_URL")!;
const NETWORK_PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ??
  "Standalone Network ; February 2017";

const ADMIN_PK = "GB577NO7D3YMZKHFQQ7OEOXXL33BRV3YRJPP3MI7UT5ZF2XNOSEQX7FN";
const ADMIN_SK = "SAKAWUZTXAQTKDYIMWEUGXDIPVVS3CIYEHH5UWFV6NFC7YDMX2G7OWOU";

const PAYMENT_XLM = 5;
const PAYMENT_STROOPS = BigInt(PAYMENT_XLM) * 10_000_000n;
const DEPOSIT_FEE_STROOPS = 500_000n; // 0.05 XLM entropy fee

const startTime = Date.now();
function elapsed(): string {
  return `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
}

// ─── Helpers ───────────────────────────────────────────────────

async function fundAccount(publicKey: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
      if (res.ok || res.status === 400) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Friendbot failed for ${publicKey}`);
}

async function payApi(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${PAY_API}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers as Record<string, string> ?? {}),
    },
  });
}

async function getPayJwt(publicKey: string, secretKey: string): Promise<string> {
  const kp = Keypair.fromSecret(secretKey);
  const chRes = await payApi("/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ publicKey }),
  });
  const { data: { nonce } } = await chRes.json();
  const sig = Buffer.from(kp.sign(Buffer.from(nonce, "base64"))).toString("base64");
  const vfRes = await payApi("/auth/verify", {
    method: "POST",
    body: JSON.stringify({ publicKey, nonce, signature: sig }),
  });
  const { data: { token } } = await vfRes.json();
  return token;
}

async function getLatestLedger(): Promise<number> {
  const res = await fetch(STELLAR_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
  });
  const data = await res.json();
  return data.result.sequence;
}

// ─── P256 key helpers ──────────────────────────────────────────

function buildPkcs8P256(rawPrivateKey: Uint8Array): ArrayBuffer {
  const header = new Uint8Array([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07,
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04,
    0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20,
  ]);
  const result = new Uint8Array(header.length + 32);
  result.set(header);
  result.set(rawPrivateKey, header.length);
  return result.buffer as ArrayBuffer;
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const binary = atob(b64 + "=".repeat(pad));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function generateTempP256(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const seedBuf = new ArrayBuffer(32);
  new Uint8Array(seedBuf).set(seed);
  const expandKey = await crypto.subtle.importKey("raw", seedBuf, "HKDF", false, ["deriveBits"]);
  const expanded = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("moonlight-p256") },
    expandKey, 384,
  );
  const privateKeyBytes = new Uint8Array(expanded).slice(0, 32);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", buildPkcs8P256(privateKeyBytes), { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", cryptoKey);
  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(base64UrlToBytes(jwk.x!), 1);
  publicKey.set(base64UrlToBytes(jwk.y!), 33);
  return { publicKey, privateKey: privateKeyBytes };
}

function makeUtxoAdapter(kp: { publicKey: Uint8Array; privateKey: Uint8Array }) {
  return {
    publicKey: kp.publicKey,
    signPayload: async (hash: Uint8Array) => {
      const hashBuf = new ArrayBuffer(hash.length);
      new Uint8Array(hashBuf).set(hash);
      const key = await crypto.subtle.importKey(
        "pkcs8", buildPkcs8P256(kp.privateKey),
        { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
      );
      return new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, hashBuf));
    },
  };
}

function partitionAmount(total: bigint, parts: number): bigint[] {
  if (parts <= 1) return [total];
  const result: bigint[] = [];
  let remaining = total;
  for (let i = 0; i < parts - 1; i++) {
    const maxForThis = remaining - BigInt(parts - i - 1);
    const portion = 1n + BigInt(Math.floor(Math.random() * Number(maxForThis - 1n)));
    result.push(portion);
    remaining -= portion;
  }
  result.push(remaining);
  return result;
}

// ─── Provider auth (transaction-based challenge) ───────────────

async function authenticateWithProvider(kp: Keypair): Promise<string> {
  const { loadConfig } = await import("./e2e/config.ts");
  const { authenticate } = await import("./e2e/auth.ts");
  return authenticate(kp, loadConfig());
}

// ─── Read contract config ──────────────────────────────────────

function loadContractsEnv(): { channelAuthId: string; privacyChannelId: string; assetId: string } {
  const env: Record<string, string> = {};
  try {
    for (const line of Deno.readTextFileSync("/config/contracts.env").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq !== -1) env[t.slice(0, eq)] = t.slice(eq + 1);
    }
  } catch { throw new Error("Failed to read /config/contracts.env"); }
  return {
    channelAuthId: env["E2E_CHANNEL_AUTH_ID"],
    privacyChannelId: env["E2E_CHANNEL_CONTRACT_ID"],
    assetId: env["E2E_CHANNEL_ASSET_CONTRACT_ID"],
  };
}

// ─── Main flow ─────────────────────────────────────────────────

console.log("\n=== POS Instant Payment E2E Test ===\n");

const { channelAuthId, privacyChannelId, assetId } = loadContractsEnv();
console.log(`  Channel Auth:    ${channelAuthId}`);
console.log(`  Privacy Channel: ${privacyChannelId}`);
console.log(`  Asset:           ${assetId}`);

// [1] Create accounts
console.log("\n[1/9] Creating merchant and customer accounts...");
const merchant = Keypair.random();
const customer = Keypair.random();
console.log(`  Merchant: ${merchant.publicKey()}`);
console.log(`  Customer: ${customer.publicKey()}`);
await fundAccount(merchant.publicKey());
await fundAccount(customer.publicKey());
console.log(`  Funded (${elapsed()})`);

// [2] Create merchant on pay-platform
console.log("\n[2/9] Creating merchant account on pay-platform...");
const merchantJwt = await getPayJwt(merchant.publicKey(), merchant.secret());
const createRes = await payApi("/account", {
  method: "POST",
  headers: { Authorization: `Bearer ${merchantJwt}` },
  body: JSON.stringify({
    email: "merchant@test.local",
    jurisdictionCountryCode: "US",
    displayName: "Test Merchant",
  }),
});
if (createRes.status !== 201 && createRes.status !== 200) {
  throw new Error(`Create merchant account failed: ${createRes.status} ${await createRes.text()}`);
}
console.log(`  Merchant account created (${elapsed()})`);

// [3] Store merchant receive UTXOs (real P256 keys)
console.log("\n[3/9] Generating and storing merchant receive UTXOs...");
const merchantUtxoKeypairs: Array<{ publicKey: Uint8Array; privateKey: Uint8Array }> = [];
const merchantUtxoPayloads = [];
for (let i = 0; i < 5; i++) {
  const kp = await generateTempP256();
  merchantUtxoKeypairs.push(kp);
  merchantUtxoPayloads.push({
    utxoPublicKey: btoa(String.fromCharCode(...kp.publicKey)),
    derivationIndex: i,
  });
}
const utxoRes = await payApi("/utxo/receive", {
  method: "POST",
  headers: { Authorization: `Bearer ${merchantJwt}` },
  body: JSON.stringify({ utxos: merchantUtxoPayloads }),
});
if (utxoRes.status !== 201 && utxoRes.status !== 200) {
  throw new Error(`Store UTXOs failed: ${utxoRes.status} ${await utxoRes.text()}`);
}
console.log(`  ${merchantUtxoPayloads.length} UTXOs stored (${elapsed()})`);

// [4] Seed council + PP config
console.log("\n[4/9] Seeding council and PP config...");
await fundAccount(ADMIN_PK);
const adminJwt = await getPayJwt(ADMIN_PK, ADMIN_SK);
const councilInsertRes = await payApi("/admin/councils", {
  method: "POST",
  headers: { Authorization: `Bearer ${adminJwt}` },
  body: JSON.stringify({
    name: "Test Council",
    channelAuthId,
    privacyChannelId,
    assetId,
    networkPassphrase: NETWORK_PASSPHRASE,
    jurisdictionCodes: "US,GB,DE",
    active: true,
  }),
});
if (!councilInsertRes.ok) throw new Error(`Council insert failed: ${councilInsertRes.status} ${await councilInsertRes.text()}`);
const { data: council } = await councilInsertRes.json();
console.log(`  Council created: ${council.id}`);

const ppInsertRes = await payApi(`/admin/councils/${council.id}/pps`, {
  method: "POST",
  headers: { Authorization: `Bearer ${adminJwt}` },
  body: JSON.stringify({ name: "Test PP", url: PROVIDER_URL, publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", active: true }),
});
if (!ppInsertRes.ok) throw new Error(`PP insert failed: ${ppInsertRes.status} ${await ppInsertRes.text()}`);
const { data: pp } = await ppInsertRes.json();
console.log(`  PP created: ${pp.id} (${elapsed()})`);

// [5] Prepare instant payment
console.log("\n[5/9] Preparing instant payment...");
const prepareRes = await payApi("/pay/instant/prepare", {
  method: "POST",
  body: JSON.stringify({
    merchantWallet: merchant.publicKey(),
    amountXlm: String(PAYMENT_XLM),
    customerWallet: customer.publicKey(),
  }),
});
if (!prepareRes.ok) {
  throw new Error(`Prepare failed: ${prepareRes.status} ${await prepareRes.text()}`);
}
const { data: prepare } = await prepareRes.json();
console.log(`  Prepared: ${prepare.merchantUtxos.length} merchant UTXOs (${elapsed()})`);

// [6] Authenticate customer with provider-platform
console.log("\n[6/9] Authenticating customer with provider-platform...");
const providerJwt = await authenticateWithProvider(customer);
console.log(`  Authenticated (${elapsed()})`);

// [7] Build the atomic instant payment bundle
console.log("\n[7/9] Building instant payment bundle...");
const ledgerSequence = await getLatestLedger();
const expiration = ledgerSequence + 1000;
const tempCount = prepare.merchantUtxos.length;

// Generate temp P256 keypairs
const tempKeypairs: Array<{ publicKey: Uint8Array; privateKey: Uint8Array }> = [];
for (let i = 0; i < tempCount; i++) {
  tempKeypairs.push(await generateTempP256());
}

// Merchant CREATE ops — distribute payment across merchant UTXOs
const merchantAmounts = partitionAmount(PAYMENT_STROOPS, prepare.merchantUtxos.length);
const merchantCreateOps = prepare.merchantUtxos.map(
  (u: { utxoPublicKey: string }, i: number) => {
    const pubKeyBytes = Uint8Array.from(atob(u.utxoPublicKey), (c) => c.charCodeAt(0));
    return MoonlightOperation.create(pubKeyBytes, merchantAmounts[i]);
  },
);

// Temp CREATE ops — distribute payment across temp keys
const tempAmounts = partitionAmount(PAYMENT_STROOPS, tempCount);
const tempCreateOps = tempKeypairs.map((kp, i) =>
  MoonlightOperation.create(kp.publicKey, tempAmounts[i])
);

// DEPOSIT — customer signs, conditioned on temp CREATEs
const depositOp = await MoonlightOperation.deposit(
  customer.publicKey() as Ed25519PublicKey,
  PAYMENT_STROOPS + DEPOSIT_FEE_STROOPS,
)
  .addConditions(tempCreateOps.map((op) => op.toCondition()))
  .signWithEd25519(
    customer,
    expiration,
    privacyChannelId as ContractId,
    assetId as ContractId,
    NETWORK_PASSPHRASE,
  );

// SPEND ops — from temp keys, conditioned on merchant CREATEs
const spendOps = [];
for (let i = 0; i < tempKeypairs.length; i++) {
  const spendOp = MoonlightOperation.spend(tempKeypairs[i].publicKey);
  for (const merchantCreate of merchantCreateOps) {
    spendOp.addCondition(merchantCreate.toCondition());
  }
  await spendOp.signWithUTXO(
    makeUtxoAdapter(tempKeypairs[i]),
    privacyChannelId as ContractId,
    expiration,
  );
  spendOps.push(spendOp);
}

// Assemble: DEPOSIT, temp CREATEs, SPENDs, merchant CREATEs
const operationsMLXDR = [
  depositOp.toMLXDR(),
  ...tempCreateOps.map((op) => op.toMLXDR()),
  ...spendOps.map((op) => op.toMLXDR()),
  ...merchantCreateOps.map((op) => op.toMLXDR()),
];
console.log(`  Bundle: ${operationsMLXDR.length} operations (${elapsed()})`);

// [8] Submit via pay-platform
console.log("\n[8/9] Submitting via pay-platform...");
const submitRes = await payApi("/pay/instant/submit", {
  method: "POST",
  body: JSON.stringify({
    customerWallet: customer.publicKey(),
    merchantWallet: merchant.publicKey(),
    amountStroops: PAYMENT_STROOPS.toString(),
    description: "POS instant e2e test",
    operationsMLXDR,
    merchantUtxoIds: prepare.merchantUtxos.map((u: { id: string }) => u.id),
    ppUrl: PROVIDER_URL,
    ppAuthToken: providerJwt,
    channelContractId: privacyChannelId,
  }),
});
if (!submitRes.ok) {
  const err = await submitRes.text();
  throw new Error(`Submit failed: ${submitRes.status} ${err}`);
}
const { data: submitData } = await submitRes.json();
console.log(`  Transaction recorded: ${submitData.transactionId} (${elapsed()})`);
console.log(`  Bundle ID: ${submitData.bundleId}`);
console.log(`  Status: ${submitData.status}`);

// [9] Verify merchant balance
console.log("\n[9/9] Verifying merchant balance...");
const balanceRes = await payApi("/transactions/balance", {
  headers: { Authorization: `Bearer ${merchantJwt}` },
});
if (!balanceRes.ok) throw new Error(`Balance check failed: ${balanceRes.status}`);
const { data: balance } = await balanceRes.json();
console.log(`  Merchant balance: ${balance.balanceXlm} XLM`);
if (BigInt(balance.balanceStroops) >= PAYMENT_STROOPS) {
  console.log("  ✅ Merchant received funds");
} else {
  throw new Error(`Expected balance >= ${PAYMENT_STROOPS}, got ${balance.balanceStroops}`);
}

console.log(`\n✅ POS instant payment test passed in ${elapsed()}`);
