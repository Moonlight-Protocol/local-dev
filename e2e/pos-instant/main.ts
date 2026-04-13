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
  },
};

import { executeInstantPayment } from "./moonlight-pay-lib/instant-payment.ts";
import { __resetConfigForTests } from "./moonlight-pay-lib/config.ts";
import {
  createTestSigner,
  fundAccount,
  generateP256PublicKey,
  getPayJwt,
  loadContractsEnv,
  payApi,
} from "./e2e/pos-helpers.ts";

__resetConfigForTests();

const ADMIN_PK = "GB577NO7D3YMZKHFQQ7OEOXXL33BRV3YRJPP3MI7UT5ZF2XNOSEQX7FN";
const ADMIN_SK = "SAKAWUZTXAQTKDYIMWEUGXDIPVVS3CIYEHH5UWFV6NFC7YDMX2G7OWOU";
const PAY_SERVICE_SK = Deno.env.get("PAY_SERVICE_SK") ??
  "SCTQUHSGRWMHZZ7XNTQZJZYZTHLBJFUQVRHYVH4N7GJPVXZQ4OMI5IEQ";
const PAY_SERVICE_PK = Keypair.fromSecret(PAY_SERVICE_SK).publicKey();

const PAYMENT_XLM = 5;
const PAYMENT_STROOPS = BigInt(PAYMENT_XLM) * 10_000_000n;

const startTime = Date.now();
const elapsed = () => `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

// ─── Main flow ─────────────────────────────────────────────────

console.log("\n=== POS Instant Payment E2E Test ===\n");

const { channelAuthId, privacyChannelId, assetId } = loadContractsEnv();
console.log(`  Channel Auth:    ${channelAuthId}`);
console.log(`  Privacy Channel: ${privacyChannelId}`);
console.log(`  Asset:           ${assetId}`);

// [1] Create + fund accounts
console.log("\n[1/5] Creating merchant and customer accounts...");
const merchant = Keypair.random();
const customer = Keypair.random();
console.log(`  Merchant: ${merchant.publicKey()}`);
console.log(`  Customer: ${customer.publicKey()}`);
await fundAccount(FRIENDBOT_URL, merchant.publicKey());
await fundAccount(FRIENDBOT_URL, customer.publicKey());
await fundAccount(FRIENDBOT_URL, ADMIN_PK);
await fundAccount(FRIENDBOT_URL, PAY_SERVICE_PK);
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
console.log(`  Merchant + ${utxoPayloads.length} UTXOs created (${elapsed()})`);

// [3] Seed council + PP
console.log("\n[3/5] Seeding council and PP config...");
const adminJwt = await getPayJwt(PAY_API, ADMIN_PK, ADMIN_SK);
const councilRes = await payApi(PAY_API, "/admin/councils", {
  method: "POST",
  headers: { Authorization: `Bearer ${adminJwt}` },
  body: JSON.stringify({
    name: "Test Council",
    channelAuthId,
    networkPassphrase: NETWORK_PASSPHRASE,
    channels: [{ assetCode: "XLM", assetContractId: assetId, privacyChannelId }],
    jurisdictions: ["US", "GB", "DE"],
    active: true,
  }),
});
if (!councilRes.ok) throw new Error(`Council failed: ${councilRes.status} ${await councilRes.text()}`);
const { data: council } = await councilRes.json();

const ppRes = await payApi(PAY_API, `/admin/councils/${council.id}/pps`, {
  method: "POST",
  headers: { Authorization: `Bearer ${adminJwt}` },
  body: JSON.stringify({ name: "Test PP", url: PROVIDER_URL, publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", active: true }),
});
if (!ppRes.ok) throw new Error(`PP failed: ${ppRes.status} ${await ppRes.text()}`);
console.log(`  Council + PP seeded (${elapsed()})`);

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
if (BigInt(balance.balanceStroops) >= PAYMENT_STROOPS) {
  console.log("  ✅ Merchant received funds");
} else {
  throw new Error(`Expected balance >= ${PAYMENT_STROOPS}, got ${balance.balanceStroops}`);
}

console.log(`\n✅ POS instant payment test passed in ${elapsed()}`);
