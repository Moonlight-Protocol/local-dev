/**
 * POS Instant Payment E2E test.
 *
 * Calls the actual moonlight-pay `executeInstantPayment` function — the
 * same code path the browser UI uses. The only difference is the signer:
 * a raw-keypair mock instead of Freighter, producing the same output.
 */
import { Keypair } from "stellar-sdk";

const PAY_API = Deno.env.get("PAY_API")!;
const PAY_URL = PAY_API.replace("/api/v1", "");
const PROVIDER_URL = Deno.env.get("PROVIDER_URL")!;
const FRIENDBOT_URL = Deno.env.get("FRIENDBOT_URL")!;
const NETWORK_PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ??
  "Standalone Network ; February 2017";

// Stub window config before importing moonlight-pay modules
// deno-lint-ignore no-explicit-any
(globalThis as any).window = {
  __PAY_CONFIG__: {
    environment: "test",
    stellarNetwork: "standalone",
    payPlatformUrl: PAY_URL,
    rpcUrl: Deno.env.get("STELLAR_RPC_URL") ?? "http://stellar:8000/soroban/rpc",
  },
};

import { executeInstantPayment } from "./moonlight-pay-lib/instant-payment.ts";
import { __resetConfigForTests } from "./moonlight-pay-lib/config.ts";
import {
  createTestSigner,
  deriveTestKeys,
  fundAccount,
  generateP256PublicKey,
  getPayJwt,
  loadContractsEnv,
  payApi,
  walletAuth,
} from "./e2e/pos-helpers.ts";

__resetConfigForTests();

const keys = await deriveTestKeys();

const PAYMENT_XLM = 5;
const PAYMENT_STROOPS = BigInt(PAYMENT_XLM) * 10_000_000n;

const startTime = Date.now();
const elapsed = () => `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

// ─── Main flow ─────────────────────────────────────────────────

console.log("\n=== POS Instant Payment E2E Test ===\n");

const { channelAuthId, privacyChannelId, assetId, councilUrl } = loadContractsEnv();
const COUNCIL_URL = Deno.env.get("COUNCIL_URL") ?? councilUrl;
const COUNCIL_API = Deno.env.get("COUNCIL_API") ?? `${COUNCIL_URL}/api/v1`;
console.log(`  Channel Auth:    ${channelAuthId}`);
console.log(`  Privacy Channel: ${privacyChannelId}`);
console.log(`  Asset:           ${assetId}`);
console.log(`  Council:         ${COUNCIL_URL}`);

// [1] Fund derived accounts
console.log("\n[1/5] Funding accounts...");
const merchant = keys.merchant;
const customer = keys.customer;
console.log(`  Admin:       ${keys.admin.publicKey()}`);
console.log(`  Pay Admin:   ${keys.payAdmin.publicKey()}`);
console.log(`  Pay Service: ${keys.payService.publicKey()}`);
console.log(`  PP:          ${keys.pp.publicKey()}`);
console.log(`  Merchant:    ${merchant.publicKey()}`);
console.log(`  Customer:    ${customer.publicKey()}`);
await Promise.all([
  fundAccount(FRIENDBOT_URL, keys.admin.publicKey()),
  fundAccount(FRIENDBOT_URL, keys.payAdmin.publicKey()),
  fundAccount(FRIENDBOT_URL, keys.payService.publicKey()),
  fundAccount(FRIENDBOT_URL, keys.pp.publicKey()),
  fundAccount(FRIENDBOT_URL, merchant.publicKey()),
  fundAccount(FRIENDBOT_URL, customer.publicKey()),
]);
console.log(`  Funded (${elapsed()})`);

// [2] Create merchant on pay-platform + store UTXOs
console.log("\n[2/5] Creating merchant account + UTXOs...");
const merchantJwt = await getPayJwt(PAY_API, merchant.publicKey(), merchant.secret());
const createRes = await payApi(PAY_API, "/account", {
  method: "POST",
  headers: { Authorization: `Bearer ${merchantJwt}` },
  body: JSON.stringify({
    email: "merchant@test.local",
    jurisdictionCountryCode: "US",
    displayName: "Test Merchant",
  }),
});
if (createRes.status !== 201 && createRes.status !== 200) {
  throw new Error(`Create merchant failed: ${createRes.status} ${await createRes.text()}`);
}

const utxoPayloads = [];
for (let i = 0; i < 5; i++) {
  const pk = await generateP256PublicKey();
  utxoPayloads.push({
    utxoPublicKey: btoa(String.fromCharCode(...pk)),
    derivationIndex: i,
  });
}
const utxoRes = await payApi(PAY_API, "/utxo/receive", {
  method: "POST",
  headers: { Authorization: `Bearer ${merchantJwt}` },
  body: JSON.stringify({ utxos: utxoPayloads }),
});
if (utxoRes.status !== 201 && utxoRes.status !== 200) {
  throw new Error(`Store UTXOs failed: ${utxoRes.status} ${await utxoRes.text()}`);
}
// Register OpEx account for the merchant (instant flow requires this)
const opexKeypair = Keypair.random();
await fundAccount(FRIENDBOT_URL, opexKeypair.publicKey());
const opexRes = await payApi(PAY_API, "/account/opex", {
  method: "POST",
  headers: { Authorization: `Bearer ${merchantJwt}` },
  body: JSON.stringify({
    secretKey: opexKeypair.secret(),
    publicKey: opexKeypair.publicKey(),
    feePct: 1,
  }),
});
if (!opexRes.ok) throw new Error(`OpEx registration failed: ${opexRes.status} ${await opexRes.text()}`);
console.log(`  Merchant + ${utxoPayloads.length} UTXOs + OpEx created (${elapsed()})`);

// [3] Seed council via council-platform + pay-platform (production-like flow)
console.log("\n[3/5] Seeding council config...");

// 3a. Admin authenticates to council-platform
const councilAdminJwt = await walletAuth(
  COUNCIL_API, "/admin/auth",
  keys.admin.publicKey(), keys.admin.secret(),
);

// 3b. Create council metadata on council-platform
const metaRes = await fetch(`${COUNCIL_API}/council/metadata`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${councilAdminJwt}` },
  body: JSON.stringify({ councilId: channelAuthId, name: "Test Council" }),
});
if (!metaRes.ok) throw new Error(`Council metadata failed: ${metaRes.status} ${await metaRes.text()}`);

// 3c. Add jurisdictions + channel
for (const code of ["US", "GB", "DE"]) {
  await fetch(`${COUNCIL_API}/council/jurisdictions?councilId=${channelAuthId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${councilAdminJwt}` },
    body: JSON.stringify({ countryCode: code, label: code }),
  });
}
await fetch(`${COUNCIL_API}/council/channels?councilId=${channelAuthId}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${councilAdminJwt}` },
  body: JSON.stringify({ channelContractId: privacyChannelId, assetCode: "XLM" }),
});

// 3d. PP submits join request with callbackEndpoint (council stores service_url)
const joinRes = await fetch(`${COUNCIL_API}/public/provider/join-request`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    publicKey: keys.pp.publicKey(),
    councilId: channelAuthId,
    label: "Test PP",
    callbackEndpoint: PROVIDER_URL,
  }),
});
if (!joinRes.ok) throw new Error(`Join request failed: ${joinRes.status} ${await joinRes.text()}`);
const { data: joinData } = await joinRes.json();

// 3e. Admin approves → council-platform creates provider record with service_url
const approveRes = await fetch(`${COUNCIL_API}/council/provider-requests/${joinData.id}/approve`, {
  method: "POST",
  headers: { Authorization: `Bearer ${councilAdminJwt}` },
});
if (!approveRes.ok) throw new Error(`Approve failed: ${approveRes.status} ${await approveRes.text()}`);

// 3f. Create council on pay-platform (councilUrl tells it where to fetch PP data)
const payAdminJwt = await getPayJwt(PAY_API, keys.payAdmin.publicKey(), keys.payAdmin.secret());
const councilRes = await payApi(PAY_API, "/admin/councils", {
  method: "POST",
  headers: { Authorization: `Bearer ${payAdminJwt}` },
  body: JSON.stringify({
    name: "Test Council",
    channelAuthId,
    councilUrl: COUNCIL_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    channels: [{ assetCode: "XLM", assetContractId: assetId, privacyChannelId }],
    jurisdictions: ["US", "GB", "DE"],
    active: true,
  }),
});
if (!councilRes.ok) throw new Error(`Council failed: ${councilRes.status} ${await councilRes.text()}`);
console.log(`  Council seeded (${elapsed()})`);

// [4] Execute instant payment via the actual moonlight-pay function
console.log("\n[4/5] Executing instant payment...");
const signer = createTestSigner(customer, NETWORK_PASSPHRASE);
const result = await executeInstantPayment({
  customerWallet: customer.publicKey(),
  merchantWallet: merchant.publicKey(),
  amountXlm: String(PAYMENT_XLM),
  assetCode: "XLM",
  description: "POS instant e2e test",
  signer,
  onStatus: (msg) => console.log(`  [status] ${msg}`),
});
console.log(`  Transaction: ${result.transactionId} (${elapsed()})`);
console.log(`  Status: ${result.status}`);

// [5] Verify merchant balance
console.log("\n[5/5] Verifying merchant balance...");
const balanceRes = await payApi(PAY_API, "/transactions/balance", {
  headers: { Authorization: `Bearer ${merchantJwt}` },
});
if (!balanceRes.ok) throw new Error(`Balance check failed: ${balanceRes.status}`);
const { data: balance } = await balanceRes.json();
console.log(`  Merchant balance: ${balance.balanceXlm} XLM`);
// With 1% fee, merchant receives 99% of the payment
const expectedMin = PAYMENT_STROOPS * 99n / 100n;
if (BigInt(balance.balanceStroops) >= expectedMin) {
  console.log("  ✅ Merchant received funds");
} else {
  throw new Error(`Expected balance >= ${expectedMin}, got ${balance.balanceStroops}`);
}

console.log(`\n✅ POS instant payment test passed in ${elapsed()}`);
