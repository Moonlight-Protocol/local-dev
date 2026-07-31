// Read-only: scan a wallet's confidential (UTXO) balance in a privacy channel.
// No submission, no signing beyond local derivation. Validates the sdk path.
import {
  ChannelReadMethods,
  PrivacyChannel,
  UtxoBasedStellarAccount,
} from "jsr:@moonlight/moonlight-sdk@^0.13.0";
import { NetworkConfig } from "jsr:@colibri/core@^0.23.0";

const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const RPC = Deno.env.get("SCAN_RPC") ?? "https://mainnet.sorobanrpc.com";
const CHANNEL = "CCLTT2ZJMMSKMUFTMDGZRRT76LFXK6INYM35VFKVZF5ZB4S7LQVEDZZ7";
const QUORUM = "CABD46PWY4NN7VTXETAUZE5MVS5PRGMWCR2UV74RS25GQR3VXMYTTSEV";
const TARGET_COUNT = Number(Deno.env.get("SCAN_COUNT") ?? "150");

const networkConfig = NetworkConfig.CustomNet({
  networkPassphrase: MAINNET_PASSPHRASE,
  rpcUrl: RPC,
  horizonUrl: "https://horizon.stellar.org",
});

async function scan(label: string, rootSecret: string) {
  // Resolve the channel's asset contract.
  const probe = new PrivacyChannel(
    networkConfig,
    CHANNEL as never,
    QUORUM as never,
    // asset unknown yet — read it off the channel first via a bare read.
    CHANNEL as never,
  );
  const assetId = await probe.read({
    method: ChannelReadMethods.asset,
    methodArgs: {},
  });

  const channelClient = new PrivacyChannel(
    networkConfig,
    CHANNEL as never,
    QUORUM as never,
    assetId as never,
  );

  const acct = UtxoBasedStellarAccount.fromPrivacyChannel({
    channelClient,
    root: rootSecret as never,
    options: { startIndex: 0, batchSize: 50 },
  });

  for (let s = 0; s < TARGET_COUNT; s += 50) {
    await acct.deriveBatch({ startIndex: s, count: Math.min(50, TARGET_COUNT - s) });
  }
  await acct.batchLoad();

  const all = acct.getAllUTXOs() as unknown as Array<{ index: number; balance: bigint | string }>;
  const funded = all.filter((u) => BigInt(u.balance) > 0n);
  const total = funded.reduce((sum, u) => sum + BigInt(u.balance), 0n);
  console.log(`${label}: ${funded.length} funded UTXOs, balance = ${Number(total) / 1e7} XLM (${total} stroops)`);
  for (const u of funded) console.log(`   idx ${u.index}: ${Number(BigInt(u.balance)) / 1e7} XLM`);
}

const ALICE_SK = Deno.env.get("OLD_ALICE_SK")!;
const BOB_SK = Deno.env.get("OLD_BOB_SK")!;
console.log(`RPC: ${RPC} | channel ${CHANNEL.slice(0, 8)} | scanning ${TARGET_COUNT} indices\n`);
await scan("old Alice", ALICE_SK);
await scan("old Bob", BOB_SK);
