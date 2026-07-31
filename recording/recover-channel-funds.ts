// Recover confidential (UTXO) funds from a moonlight privacy channel to the
// owner's public Stellar account — headless, no browser. Mirrors the wallet's
// prepareWithdrawOperations + PrivacyProviderClient submit path.
//
// Usage:
//   OWNER_SK=S... DEST=G... AMOUNT=4.6 deno run -A recover-channel-funds.ts
//   (DEST defaults to the owner's own public key; AMOUNT="max" auto-computes)
import {
  ChannelReadMethods,
  MoonlightOperation,
  PrivacyChannel,
  StellarDerivator,
  UtxoBasedStellarAccount,
  UTXOStatus,
} from "jsr:@moonlight/moonlight-sdk@^0.13.0";
import { fromDecimals, NetworkConfig } from "jsr:@colibri/core@^0.23.0";
import { Buffer } from "node:buffer";
import { Keypair, Networks, TransactionBuilder } from "npm:@stellar/stellar-sdk@^16.1.0";

const PASSPHRASE = "Public Global Stellar Network ; September 2015";
const RPC = Deno.env.get("SCAN_RPC") ?? "https://mainnet.sorobanrpc.com";
const CHANNEL = "CCLTT2ZJMMSKMUFTMDGZRRT76LFXK6INYM35VFKVZF5ZB4S7LQVEDZZ7";
const QUORUM = "CABD46PWY4NN7VTXETAUZE5MVS5PRGMWCR2UV74RS25GQR3VXMYTTSEV";
const PP_BASE = "https://provider-api.moonlightprotocol.io";
const PP_PUBKEY = "GDIUMTDESAL2CKFHFQZKPTP5OC2RMAHRSV3BDNXA4ZCIFDR6WIB74LAN";
const FEE_XLM = 0.1; // LOW entropy fee
const DRY_RUN = Deno.env.get("DRY_RUN") === "1";

const networkConfig = NetworkConfig.CustomNet({
  networkPassphrase: PASSPHRASE,
  rpcUrl: RPC,
  horizonUrl: "https://horizon.stellar.org",
});

async function rpcLatestLedger(): Promise<number> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
  });
  const j = await res.json();
  return j.result.sequence as number;
}

// ---- SEP-10 auth against the PP ----
async function authenticate(kp: Keypair): Promise<string> {
  const ch = await fetch(`${PP_BASE}/api/v1/stellar/auth?account=${kp.publicKey()}`);
  const chJson = await ch.json();
  const challengeXdr: string = chJson.data.challenge;
  const tx = TransactionBuilder.fromXDR(challengeXdr, Networks.PUBLIC);
  tx.sign(kp);
  const signedChallenge = tx.toXDR();
  const auth = await fetch(`${PP_BASE}/api/v1/stellar/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedChallenge, ppPublicKey: PP_PUBKEY }),
  });
  const authJson = await auth.json();
  const jwt = authJson.data?.jwt;
  if (!jwt) throw new Error(`auth failed: ${JSON.stringify(authJson)}`);
  console.log(`  auth ok (entityStatus=${authJson.data?.entityStatus})`);
  return jwt;
}

// ---- build withdraw operations (mirror of wallet prepareWithdrawOperations) ----
async function buildWithdraw(rootSecret: string, dest: string, amountXlm: number, assetId: string) {
  const derivator = new StellarDerivator().withNetworkAndContract(PASSPHRASE as never, CHANNEL as never);
  const channelClient = new PrivacyChannel(networkConfig, CHANNEL as never, QUORUM as never, assetId as never);
  const acct = new UtxoBasedStellarAccount({
    root: rootSecret as never,
    derivator,
    options: {
      batchSize: 50,
      fetchBalances(pks: Uint8Array[]) {
        return channelClient.read({
          method: ChannelReadMethods.utxo_balances,
          methodArgs: { utxos: pks.map((pk) => Buffer.from(pk)) },
        });
      },
    },
  });

  let safety = 0;
  while (acct.getUTXOsByState(UTXOStatus.FREE).length < 10 && safety < 12) {
    await acct.deriveBatch({});
    await acct.batchLoad();
    safety++;
  }

  const amountBig = fromDecimals(amountXlm, 7);
  const feeBig = fromDecimals(FEE_XLM, 7);
  const totalToSpend = amountBig + feeBig;

  let best: { selectedUTXOs: any[]; totalAmount: bigint; changeAmount: bigint } | null = null;
  let smallest = Infinity;
  for (let a = 0; a < 5; a++) {
    const sel = acct.selectUTXOsForTransfer(totalToSpend, "random" as never);
    if (!sel) break;
    if (sel.selectedUTXOs.length < smallest) { smallest = sel.selectedUTXOs.length; best = sel; }
    if (sel.selectedUTXOs.length <= 10) break;
  }
  if (!best) throw new Error(`insufficient confidential balance for ${amountXlm}+fee`);

  const { selectedUTXOs, changeAmount } = best;
  const withdrawOp = MoonlightOperation.withdraw(dest as never, amountBig);

  const createOps: any[] = [];
  if (changeAmount > 0n) {
    const changeUtxos = acct.reserveUTXOs(1);
    if (changeUtxos?.length) {
      createOps.push(MoonlightOperation.create(changeUtxos[0].publicKey, changeAmount));
    }
  }

  const expiration = (await rpcLatestLedger()) + 1000;
  const spendOps: any[] = [];
  for (const utxo of selectedUTXOs) {
    const spendOp = MoonlightOperation.spend(utxo.publicKey);
    spendOp.addCondition(withdrawOp.toCondition());
    for (const c of createOps) spendOp.addCondition(c.toCondition());
    await spendOp.signWithUTXO(utxo, CHANNEL as never, expiration);
    spendOps.push(spendOp);
  }

  return [withdrawOp.toMLXDR(), ...createOps.map((o) => o.toMLXDR()), ...spendOps.map((o) => o.toMLXDR())];
}

async function submitBundle(jwt: string, mlxdr: string[]): Promise<string> {
  const res = await fetch(`${PP_BASE}/api/v1/providers/${PP_PUBKEY}/entity/bundles`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ operationsMLXDR: mlxdr, channelContractId: CHANNEL }),
  });
  const j = await res.json();
  const id = j.data?.operationsBundleId;
  if (!id) throw new Error(`submit failed (${res.status}): ${JSON.stringify(j)}`);
  console.log(`  bundle ${id} submitted, polling...`);
  const start = Date.now();
  while (Date.now() - start < 180_000) {
    await new Promise((r) => setTimeout(r, 5000));
    const pr = await fetch(`${PP_BASE}/api/v1/providers/${PP_PUBKEY}/entity/bundles/${id}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const pj = await pr.json();
    const st = pj.data?.status;
    if (st === "COMPLETED") return "COMPLETED";
    if (st === "FAILED" || st === "EXPIRED") {
      throw new Error(`bundle ${st}: ${JSON.stringify(pj.data?.failureDetail ?? {})}`);
    }
  }
  throw new Error("bundle poll timeout");
}

// ---- main ----
const kp = Keypair.fromSecret(Deno.env.get("OWNER_SK")!);
const dest = Deno.env.get("DEST") ?? kp.publicKey();
console.log(`owner ${kp.publicKey().slice(0, 8)} -> dest ${dest.slice(0, 8)} | channel ${CHANNEL.slice(0, 8)}`);

// read asset once
const assetProbe = new PrivacyChannel(networkConfig, CHANNEL as never, QUORUM as never, CHANNEL as never);
const assetId = String(await assetProbe.read({ method: ChannelReadMethods.asset, methodArgs: {} }));

const amount = Number(Deno.env.get("AMOUNT"));
if (!Number.isFinite(amount) || amount <= 0) throw new Error("set AMOUNT=<xlm>");

console.log(`building withdraw of ${amount} XLM (+${FEE_XLM} fee)...`);
const mlxdr = await buildWithdraw(Deno.env.get("OWNER_SK")!, dest, amount, assetId);
console.log(`  built ${mlxdr.length} operations`);

if (DRY_RUN) { console.log("DRY_RUN=1 — not submitting."); Deno.exit(0); }

const jwt = await authenticate(kp);
const result = await submitBundle(jwt, mlxdr);
console.log(`DONE: ${result}`);
