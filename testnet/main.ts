import { Keypair } from "stellar-sdk";
import { loadConfig } from "./config.ts";
import { authenticate } from "../e2e/auth.ts";
import { deposit } from "../e2e/deposit.ts";
import { prepareReceive } from "../e2e/receive.ts";
import { send } from "../e2e/send.ts";
import { withdraw } from "../e2e/withdraw.ts";
import { sdkTracer, withE2ESpan, writeTraceIds } from "../e2e/tracer.ts";

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
  console.log("\n[1/8] Loading testnet configuration...");
  const config = loadConfig();
  console.log(`  Channel:  ${config.channelContractId}`);
  console.log(`  Auth:     ${config.channelAuthId}`);
  console.log(`  Asset:    ${config.channelAssetContractId}`);
  console.log(`  Provider: ${config.providerUrl}`);
  console.log(`  RPC:      ${config.rpcUrl}`);

  // Generate fresh keypairs
  const alice = Keypair.random();
  const bob = Keypair.random();
  console.log(`  Alice:    ${alice.publicKey()}`);
  console.log(`  Bob:      ${bob.publicKey()}`);

  // Step 2: Fund accounts via Friendbot
  console.log("\n[2/8] Funding accounts via testnet Friendbot...");
  await withE2ESpan("e2e.fund_accounts", async () => {
    await fundAccount(config.friendbotUrl, alice.publicKey());
    console.log(`  Alice funded`);
    await fundAccount(config.friendbotUrl, bob.publicKey());
    console.log(`  Bob funded`);
  });

  // Step 3: Authenticate Alice
  console.log("\n[3/8] Authenticating Alice with provider...");
  const aliceJwt = await withE2ESpan("e2e.authenticate_alice", () =>
    authenticate(alice, config)
  );
  console.log(`  Alice authenticated`);

  // Step 4: Authenticate Bob
  console.log("\n[4/8] Authenticating Bob with provider...");
  const bobJwt = await withE2ESpan("e2e.authenticate_bob", () =>
    authenticate(bob, config)
  );
  console.log(`  Bob authenticated`);

  // Step 5: Alice deposits into channel
  console.log(`\n[5/8] Alice depositing ${DEPOSIT_AMOUNT} XLM into channel...`);
  await withE2ESpan("e2e.deposit", () =>
    deposit(alice.secret(), DEPOSIT_AMOUNT, aliceJwt, config, sdkTracer)
  );
  console.log(`  Deposit complete`);

  // Step 6: Bob prepares to receive
  console.log(`\n[6/8] Bob preparing to receive ${SEND_AMOUNT} XLM...`);
  const receiverOps = await withE2ESpan("e2e.prepare_receive", () =>
    prepareReceive(bob.secret(), SEND_AMOUNT, config, sdkTracer)
  );
  console.log(`  Receive prepared (${receiverOps.length} CREATE ops)`);

  // Step 7: Alice sends to Bob
  console.log(`\n[7/8] Alice sending ${SEND_AMOUNT} XLM to Bob...`);
  await withE2ESpan("e2e.send", () =>
    send(alice.secret(), receiverOps, SEND_AMOUNT, aliceJwt, config, sdkTracer)
  );
  console.log(`  Send complete`);

  // Step 8: Bob withdraws to his Stellar address
  console.log(
    `\n[8/8] Bob withdrawing ${WITHDRAW_AMOUNT} XLM to ${bob.publicKey()}...`,
  );
  await withE2ESpan("e2e.withdraw", () =>
    withdraw(bob.secret(), bob.publicKey(), WITHDRAW_AMOUNT, bobJwt, config, sdkTracer)
  );
  console.log(`  Withdraw complete`);

  // Write trace IDs for verify-otel to fetch by ID
  await writeTraceIds();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Testnet E2E test passed in ${elapsed}s`);
}

main().catch((err) => {
  console.error(`\n❌ Testnet E2E test failed:`, err);
  Deno.exit(1);
});
