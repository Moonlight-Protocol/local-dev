import { Keypair } from "stellar-sdk";
import { loadConfig } from "./config.ts";
import { authenticate } from "./auth.ts";
import { deposit } from "./deposit.ts";
import { prepareReceive } from "./receive.ts";
import { send } from "./send.ts";
import { withdraw } from "./withdraw.ts";

const DEPOSIT_AMOUNT = 10; // XLM
const SEND_AMOUNT = 5; // XLM
const WITHDRAW_AMOUNT = 4; // XLM

async function fundAccount(
  friendbotUrl: string,
  publicKey: string,
): Promise<void> {
  const res = await fetch(`${friendbotUrl}?addr=${publicKey}`);
  if (!res.ok) {
    throw new Error(
      `Friendbot funding failed for ${publicKey}: ${res.status} ${await res.text()}`,
    );
  }
}

async function main() {
  const startTime = Date.now();

  // Step 1: Load configuration
  console.log("\n[1/8] Loading configuration...");
  const config = loadConfig();
  console.log(`  Channel:  ${config.channelContractId}`);
  console.log(`  Auth:     ${config.channelAuthId}`);
  console.log(`  Asset:    ${config.channelAssetContractId}`);
  console.log(`  Provider: ${config.providerUrl}`);

  // Generate fresh keypairs
  const alice = Keypair.random();
  const bob = Keypair.random();
  console.log(`  Alice:    ${alice.publicKey()}`);
  console.log(`  Bob:      ${bob.publicKey()}`);

  // Step 2: Fund accounts via Friendbot
  console.log("\n[2/8] Funding accounts via Friendbot...");
  await fundAccount(config.friendbotUrl, alice.publicKey());
  console.log(`  Alice funded`);
  await fundAccount(config.friendbotUrl, bob.publicKey());
  console.log(`  Bob funded`);

  // Step 3: Authenticate Alice
  console.log("\n[3/8] Authenticating Alice with provider...");
  const aliceJwt = await authenticate(alice, config);
  console.log(`  Alice authenticated`);

  // Step 4: Authenticate Bob
  console.log("\n[4/8] Authenticating Bob with provider...");
  const bobJwt = await authenticate(bob, config);
  console.log(`  Bob authenticated`);

  // Step 5: Alice deposits into channel
  console.log(`\n[5/8] Alice depositing ${DEPOSIT_AMOUNT} XLM into channel...`);
  await deposit(alice.secret(), DEPOSIT_AMOUNT, aliceJwt, config);
  console.log(`  Deposit complete`);

  // Step 6: Bob prepares to receive
  console.log(`\n[6/8] Bob preparing to receive ${SEND_AMOUNT} XLM...`);
  const receiverOps = await prepareReceive(bob.secret(), SEND_AMOUNT, config);
  console.log(`  Receive prepared (${receiverOps.length} CREATE ops)`);

  // Step 7: Alice sends to Bob
  console.log(`\n[7/8] Alice sending ${SEND_AMOUNT} XLM to Bob...`);
  await send(alice.secret(), receiverOps, SEND_AMOUNT, aliceJwt, config);
  console.log(`  Send complete`);

  // Step 8: Bob withdraws to his Stellar address
  console.log(
    `\n[8/8] Bob withdrawing ${WITHDRAW_AMOUNT} XLM to ${bob.publicKey()}...`,
  );
  await withdraw(bob.secret(), bob.publicKey(), WITHDRAW_AMOUNT, bobJwt, config);
  console.log(`  Withdraw complete`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ E2E test passed in ${elapsed}s`);
}

main().catch((err) => {
  console.error(`\n❌ E2E test failed:`, err);
  Deno.exit(1);
});
