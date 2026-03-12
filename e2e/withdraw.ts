import { MoonlightOperation, type MoonlightTracer } from "@moonlight/moonlight-sdk";
import { fromDecimals, type Ed25519PublicKey } from "@colibri/core";
import type { Config } from "./config.ts";
import { setupAccount, getLatestLedger } from "./account.ts";
import { submitBundle, waitForBundle } from "./bundle.ts";

const WITHDRAW_FEE = 0.1; // LOW entropy fee

export async function withdraw(
  secretKey: string,
  destinationAddress: string,
  amount: number,
  jwt: string,
  config: Config,
  tracer?: MoonlightTracer,
): Promise<void> {
  const feeBigInt = fromDecimals(WITHDRAW_FEE, 7);
  const amountBigInt = fromDecimals(amount, 7);
  const totalToSpend = amountBigInt + feeBigInt;

  // 1. Setup account
  const { accountHandler } = await setupAccount(secretKey, config, 1, tracer);

  // 2. Select UTXOs to spend
  const selection = accountHandler.selectUTXOsForTransfer(
    totalToSpend,
    // deno-lint-ignore no-explicit-any
    "random" as any,
  );
  if (!selection) {
    throw new Error("Insufficient balance for withdraw");
  }

  // 3. Build WITHDRAW operation
  const withdrawOp = MoonlightOperation.withdraw(
    destinationAddress as Ed25519PublicKey,
    amountBigInt,
  );

  // 4. Build change CREATE operations if needed
  const changeCreateOps = [];
  if (selection.changeAmount > 0n) {
    const changeReserved = accountHandler.reserveUTXOs(1);
    if (!changeReserved || changeReserved.length === 0) {
      throw new Error("Failed to reserve UTXO for change");
    }
    changeCreateOps.push(
      MoonlightOperation.create(
        changeReserved[0].publicKey,
        selection.changeAmount,
      ),
    );
  }

  // 5. Get expiration
  const ledgerSequence = await getLatestLedger(config.rpcUrl);
  const expiration = ledgerSequence + 1000;

  // 6. Build and sign SPEND operations
  const spendOps = [];
  for (const utxo of selection.selectedUTXOs) {
    let spendOp = MoonlightOperation.spend(utxo.publicKey);
    // Add WITHDRAW as condition first
    spendOp = spendOp.addCondition(withdrawOp.toCondition());
    // Add change CREATEs as conditions
    for (const createOp of changeCreateOps) {
      spendOp = spendOp.addCondition(createOp.toCondition());
    }
    const signedSpend = await spendOp.signWithUTXO(
      utxo,
      config.channelContractId,
      expiration,
    );
    spendOps.push(signedSpend);
  }

  // 7. Submit bundle: WITHDRAW first, then CREATEs, then SPENDs
  const operationsMLXDR = [
    withdrawOp.toMLXDR(),
    ...changeCreateOps.map((op) => op.toMLXDR()),
    ...spendOps.map((op) => op.toMLXDR()),
  ];
  const bundleId = await submitBundle(jwt, operationsMLXDR, config);
  console.log(`  Bundle submitted: ${bundleId}`);

  await waitForBundle(jwt, bundleId, config);
  console.log(`  Bundle completed`);
}
