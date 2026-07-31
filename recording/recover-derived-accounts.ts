// Recover funds from the accounts a recording run's consoles derived.
//
// Council and provider consoles never store their operational keys. Each is
// derived from a single wallet signature:
//
//   masterSeed = SHA-256( sign( SHA-256("Stellar Signed Message:\n" + MESSAGE) ) )
//   key        = Ed25519FromRawSeed( SHA-256( masterSeed || purpose || index ) )
//
// where the signing wallet is the run's admin (council console, purpose "opex")
// or provider operator (provider console, purpose "pp"). Both wallets derive in
// turn from MASTER_SECRET plus the run id, so a run's OpEx balances are
// recoverable from the run id alone. Without this, those funds look stranded:
// nothing in the run output records the derived addresses.
//
// Usage — every value is required, there are no defaults:
//
//   MASTER_SECRET=S... RUN_ID=mainnet-run2-... DEST=G... MODE=payment \
//     deno run --allow-env --allow-net recording/recover-derived-accounts.ts
//
//   MODE=payment  send the spendable balance, leave the account open
//   MODE=merge    close the account, recovering its minimum balance too
//
// Nothing is signed until a derived address is confirmed to exist on-chain,
// and every address and amount is printed before its transaction is submitted.

import { Account, Asset, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder } from "npm:@stellar/stellar-sdk@14.2.0";
import { Buffer } from "node:buffer";
import { deriveRecordingRunKeys } from "./recording-keys.ts";

const HORIZON = "https://horizon.stellar.org";
const MESSAGE = "Moonlight: Derive server key";
const encoder = new TextEncoder();

function required(name: string): string {
  const v = Deno.env.get(name);
  if (!v || v.trim() === "") {
    console.error(`${name} is required. See the usage note at the top of this file.`);
    Deno.exit(1);
  }
  return v.trim();
}

const MASTER_SECRET = required("MASTER_SECRET");
const RUN_ID = required("RUN_ID");
const DEST = required("DEST");
const MODE = required("MODE");

if (MODE !== "payment" && MODE !== "merge") {
  console.error(`MODE must be "payment" or "merge", got "${MODE}".`);
  Deno.exit(1);
}
if (!/^G[A-Z2-7]{55}$/.test(DEST)) {
  console.error(`DEST is not a valid Stellar public key: ${DEST}`);
  Deno.exit(1);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Reproduce a console's derived key for the given purpose and index. */
async function deriveConsoleKey(
  walletSecret: string,
  purpose: "opex" | "pp",
  index: number,
): Promise<Keypair> {
  const wallet = Keypair.fromSecret(walletSecret);
  const digest = await sha256(
    concat(encoder.encode("Stellar Signed Message:\n"), encoder.encode(MESSAGE)),
  );
  const masterSeed = await sha256(wallet.sign(Buffer.from(digest)));
  const seed = await sha256(
    concat(masterSeed, encoder.encode(purpose), encoder.encode(String(index))),
  );
  return Keypair.fromRawEd25519Seed(Buffer.from(seed));
}

async function loadAccount(publicKey: string) {
  const res = await fetch(`${HORIZON}/accounts/${publicKey}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Horizon ${res.status} for ${publicKey}`);
  return await res.json();
}

async function sweep(kp: Keypair, label: string): Promise<number> {
  const account = await loadAccount(kp.publicKey());
  if (!account) {
    console.log(`  ${label}  ${kp.publicKey()}  does not exist, skipping`);
    return 0;
  }

  const balance = Number(
    account.balances.find((b: { asset_type: string }) => b.asset_type === "native").balance,
  );
  const reserve = (2 + account.subentry_count) * 0.5;

  // The fee is charged before the operation applies and may not take the
  // account below its reserve, so a merge has to use the base fee.
  const fee = MODE === "merge" ? BASE_FEE : String(Number(BASE_FEE) * 10);
  const feeXlm = Number(fee) / 1e7;

  console.log(`  ${label}  ${kp.publicKey()}`);
  console.log(`    balance ${balance} | reserve ${reserve} | fee ${feeXlm}`);

  if (MODE === "merge" && account.subentry_count > 0) {
    console.log(`    ${account.subentry_count} subentries, cannot merge, skipping`);
    return 0;
  }

  const amount = MODE === "merge" ? balance - feeXlm : Number((balance - reserve - feeXlm).toFixed(7));
  if (amount <= 0) {
    console.log("    nothing recoverable, skipping");
    return 0;
  }

  const builder = new TransactionBuilder(
    new Account(kp.publicKey(), account.sequence),
    { fee, networkPassphrase: Networks.PUBLIC },
  );
  builder.addOperation(
    MODE === "merge"
      ? Operation.accountMerge({ destination: DEST })
      : Operation.payment({ destination: DEST, asset: Asset.native(), amount: amount.toFixed(7) }),
  );
  const tx = builder.setTimeout(120).build();
  tx.sign(kp);

  console.log(`    ${MODE} ${amount.toFixed(7)} XLM -> ${DEST}`);
  const res = await fetch(`${HORIZON}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: tx.toXDR() }),
  });
  const body = await res.json();
  if (!res.ok || body.successful === false) {
    console.log(`    FAILED: ${JSON.stringify(body.extras?.result_codes ?? body.title ?? body)}`);
    return 0;
  }
  console.log(`    submitted ${body.hash}`);
  return amount;
}

console.log(`run ${RUN_ID}`);
console.log(`mode ${MODE}, destination ${DEST}\n`);

const runKeys = await deriveRecordingRunKeys(MASTER_SECRET, RUN_ID);
let total = 0;

console.log("council console (admin wallet, purpose \"opex\"):");
total += await sweep(await deriveConsoleKey(runKeys.admin.secretKey, "opex", 0), "index 0");

console.log("\nprovider console (operator wallet, purpose \"pp\"):");
total += await sweep(await deriveConsoleKey(runKeys.pp.secretKey, "pp", 0), "index 0");

console.log(`\nrecovered ~${total.toFixed(7)} XLM`);
