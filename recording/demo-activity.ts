// Generate minimal-amount confidential activity on a mainnet privacy channel so
// the network dashboard shows deposit / transfer / withdraw events + volume.
// Headless (no browser), sdk-driven. Amounts round-trip (recoverable); only the
// per-op settlement gas (~0.05-0.17 XLM, opex-paid) is truly spent.
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
const FEE = 0.1; // LOW entropy

// small amounts — round-trip, only gas is spent
const BOB_SK = Deno.env.get("BOB_SK")!;
const ALICE_SK = Deno.env.get("ALICE_SK")!;
const ALICE_PK = Keypair.fromSecret(ALICE_SK).publicKey();
const DEPOSIT = Number(Deno.env.get("DEPOSIT") ?? "5");
const SEND = Number(Deno.env.get("SEND") ?? "3");
const WITHDRAW = Number(Deno.env.get("WITHDRAW") ?? "2");

const nc = NetworkConfig.CustomNet({ networkPassphrase: PASSPHRASE, rpcUrl: RPC, horizonUrl: "https://horizon.stellar.org" });

async function latestLedger(): Promise<number> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }) });
  return (await r.json()).result.sequence as number;
}
let ASSET = "";
async function assetId(): Promise<string> {
  if (ASSET) return ASSET;
  const p = new PrivacyChannel(nc, CHANNEL as never, QUORUM as never, CHANNEL as never);
  ASSET = String(await p.read({ method: ChannelReadMethods.asset, methodArgs: {} }));
  return ASSET;
}
async function mkAccount(secret: string) {
  const asset = await assetId();
  const derivator = new StellarDerivator().withNetworkAndContract(PASSPHRASE as never, CHANNEL as never);
  const channelClient = new PrivacyChannel(nc, CHANNEL as never, QUORUM as never, asset as never);
  const acct = new UtxoBasedStellarAccount({
    root: secret as never,
    derivator,
    options: {
      batchSize: 50,
      fetchBalances(pks: Uint8Array[]) {
        return channelClient.read({ method: ChannelReadMethods.utxo_balances, methodArgs: { utxos: pks.map((pk) => Buffer.from(pk)) } });
      },
    },
  });
  let s = 0;
  while (acct.getUTXOsByState(UTXOStatus.FREE).length < 10 && s < 12) { await acct.deriveBatch({}); await acct.batchLoad(); s++; }
  return acct;
}
function partition(total: bigint, parts: number): bigint[] {
  const base = total / BigInt(parts);
  const out = Array(parts).fill(base);
  out[0] += total - base * BigInt(parts);
  return out;
}
async function auth(kp: Keypair): Promise<string> {
  const ch = await (await fetch(`${PP_BASE}/api/v1/stellar/auth?account=${kp.publicKey()}`)).json();
  const tx = TransactionBuilder.fromXDR(ch.data.challenge, Networks.PUBLIC);
  tx.sign(kp);
  const a = await (await fetch(`${PP_BASE}/api/v1/stellar/auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedChallenge: tx.toXDR(), ppPublicKey: PP_PUBKEY }) })).json();
  if (!a.data?.jwt) throw new Error(`auth failed: ${JSON.stringify(a)}`);
  return a.data.jwt;
}
async function submit(jwt: string, mlxdr: string[], label: string) {
  const r = await (await fetch(`${PP_BASE}/api/v1/providers/${PP_PUBKEY}/entity/bundles`, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` }, body: JSON.stringify({ operationsMLXDR: mlxdr, channelContractId: CHANNEL }) })).json();
  const id = r.data?.operationsBundleId;
  if (!id) throw new Error(`${label} submit failed: ${JSON.stringify(r)}`);
  const start = Date.now();
  while (Date.now() - start < 180_000) {
    await new Promise((x) => setTimeout(x, 5000));
    const pj = await (await fetch(`${PP_BASE}/api/v1/providers/${PP_PUBKEY}/entity/bundles/${id}`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
    if (pj.data?.status === "COMPLETED") { console.log(`  ${label}: COMPLETED (${id.slice(0, 8)})`); return; }
    if (["FAILED", "EXPIRED"].includes(pj.data?.status)) throw new Error(`${label} ${pj.data.status}: ${JSON.stringify(pj.data?.failureDetail)}`);
  }
  throw new Error(`${label} poll timeout`);
}

async function deposit(secret: string, amountXlm: number) {
  console.log(`deposit ${amountXlm} XLM (${Keypair.fromSecret(secret).publicKey().slice(0, 8)})`);
  const kp = Keypair.fromSecret(secret);
  const acct = await mkAccount(secret);
  const reserved = acct.reserveUTXOs(1);
  if (!reserved) throw new Error("reserve failed");
  const amt = fromDecimals(amountXlm, 7);
  const total = fromDecimals(amountXlm + FEE, 7);
  const amts = partition(amt, reserved.length);
  const createOps = reserved.map((u: any, i: number) => MoonlightOperation.create(u.publicKey, amts[i]));
  const asset = await assetId();
  const exp = (await latestLedger()) + 1000;
  const depositOp = await MoonlightOperation.deposit(kp.publicKey() as never, total)
    .addConditions(createOps.map((o: any) => o.toCondition()))
    .signWithEd25519(kp as never, exp, CHANNEL as never, asset as never, PASSPHRASE);
  const mlxdr = [depositOp.toMLXDR(), ...createOps.map((o: any) => o.toMLXDR())];
  await submit(await auth(kp), mlxdr, "deposit");
}

async function receive(secret: string, amountXlm: number): Promise<string[]> {
  const acct = await mkAccount(secret);
  const reserved = acct.reserveUTXOs(5);
  if (!reserved || reserved.length !== 5) throw new Error("receive reserve failed");
  const amts = partition(fromDecimals(amountXlm, 7), 5);
  const createOps = reserved.map((u: any, i: number) => MoonlightOperation.create(u.publicKey, amts[i]));
  return createOps.map((o: any) => o.toMLXDR());
}

async function send(secret: string, receiverMLXDR: string[], amountXlm: number) {
  console.log(`send ${amountXlm} XLM -> ${ALICE_PK.slice(0, 8)}`);
  const kp = Keypair.fromSecret(secret);
  const acct = await mkAccount(secret);
  const total = fromDecimals(amountXlm + FEE, 7);
  let best: any = null, smallest = Infinity;
  for (let a = 0; a < 5; a++) {
    const sel = acct.selectUTXOsForTransfer(total, "random" as never);
    if (!sel) break;
    if (sel.selectedUTXOs.length < smallest) { smallest = sel.selectedUTXOs.length; best = sel; }
    if (sel.selectedUTXOs.length <= 10) break;
  }
  if (!best) throw new Error("insufficient balance for send");
  const receiverOps = receiverMLXDR.map((m) => MoonlightOperation.fromMLXDR(m));
  const createOps: any[] = receiverOps.map((op: any) => MoonlightOperation.create(op.getUtxo(), op.getAmount()));
  if (best.changeAmount > 0n) {
    const changeUtxos = acct.reserveUTXOs(1);
    if (changeUtxos?.length) createOps.push(MoonlightOperation.create(changeUtxos[0].publicKey, best.changeAmount));
  }
  const exp = (await latestLedger()) + 1000;
  const spendOps: any[] = [];
  for (const utxo of best.selectedUTXOs) {
    const sp = MoonlightOperation.spend(utxo.publicKey);
    for (const c of createOps) sp.addCondition(c.toCondition());
    await sp.signWithUTXO(utxo, CHANNEL as never, exp);
    spendOps.push(sp);
  }
  const mlxdr = [...createOps.map((o: any) => o.toMLXDR()), ...spendOps.map((o: any) => o.toMLXDR())];
  await submit(await auth(kp), mlxdr, "send");
}

async function withdraw(secret: string, dest: string, amountXlm: number) {
  console.log(`withdraw ${amountXlm} XLM -> ${dest.slice(0, 8)}`);
  const kp = Keypair.fromSecret(secret);
  const acct = await mkAccount(secret);
  const total = fromDecimals(amountXlm + FEE, 7);
  let best: any = null, smallest = Infinity;
  for (let a = 0; a < 5; a++) {
    const sel = acct.selectUTXOsForTransfer(total, "random" as never);
    if (!sel) break;
    if (sel.selectedUTXOs.length < smallest) { smallest = sel.selectedUTXOs.length; best = sel; }
    if (sel.selectedUTXOs.length <= 10) break;
  }
  if (!best) throw new Error("insufficient balance for withdraw");
  const wOp = MoonlightOperation.withdraw(dest as never, fromDecimals(amountXlm, 7));
  const createOps: any[] = [];
  if (best.changeAmount > 0n) {
    const c = acct.reserveUTXOs(1);
    if (c?.length) createOps.push(MoonlightOperation.create(c[0].publicKey, best.changeAmount));
  }
  const exp = (await latestLedger()) + 1000;
  const spendOps: any[] = [];
  for (const utxo of best.selectedUTXOs) {
    const sp = MoonlightOperation.spend(utxo.publicKey);
    sp.addCondition(wOp.toCondition());
    for (const c of createOps) sp.addCondition(c.toCondition());
    await sp.signWithUTXO(utxo, CHANNEL as never, exp);
    spendOps.push(sp);
  }
  const mlxdr = [wOp.toMLXDR(), ...createOps.map((o: any) => o.toMLXDR()), ...spendOps.map((o: any) => o.toMLXDR())];
  await submit(await auth(kp), mlxdr, "withdraw");
}

// ---- orchestrate: Bob deposit -> Alice receive -> Bob send -> Alice withdraw ----
console.log(`cycle: deposit ${DEPOSIT} / send ${SEND} / withdraw ${WITHDRAW}\n`);
await deposit(BOB_SK, DEPOSIT);
const rcv = await receive(ALICE_SK, SEND);
await send(BOB_SK, rcv, SEND);
await withdraw(ALICE_SK, ALICE_PK, WITHDRAW);
console.log("\nDONE — dashboard should now show deposit + transfer + withdraw + volume");
