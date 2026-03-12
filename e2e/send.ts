import { MoonlightOperation, type MoonlightTracer } from "@moonlight/moonlight-sdk";
import { fromDecimals } from "@colibri/core";
import type { Config } from "./config.ts";
import { setupAccount, getLatestLedger } from "./account.ts";
import { submitBundle, waitForBundle } from "./bundle.ts";

const SEND_FEE = 0.1; // LOW entropy fee

export async function send(
  secretKey: string,
  receiverOperationsMLXDR: string[],
  amount: number,
  jwt: string,
  config: Config,
  tracer?: MoonlightTracer,
): Promise<void> {
  const feeBigInt = fromDecimals(SEND_FEE, 7);
  const amountBigInt = fromDecimals(amount, 7);
  const totalToSpend = amountBigInt + feeBigInt;

  // 1. Parse receiver CREATE operations
  const receiverOps = receiverOperationsMLXDR.map((mlxdr) => {
    const op = MoonlightOperation.fromMLXDR(mlxdr);
    if (!op.isCreate()) {
      throw new Error("Receiver operation is not a CREATE operation");
    }
    return { publicKey: op.getUtxo(), amount: op.getAmount() };
  });

  // 2. Setup sender account
  const { accountHandler } = await setupAccount(secretKey, config, 1, tracer);

  // 3. Select UTXOs to spend
  const selection = accountHandler.selectUTXOsForTransfer(
    totalToSpend,
    // deno-lint-ignore no-explicit-any
    "random" as any,
  );
  if (!selection) {
    throw new Error("Insufficient balance for send");
  }

  // 4. Build receiver CREATE operations
  const createOps = receiverOps.map((op) =>
    MoonlightOperation.create(op.publicKey, op.amount)
  );

  // 5. Build change CREATE operation if needed
  if (selection.changeAmount > 0n) {
    const changeReserved = accountHandler.reserveUTXOs(1);
    if (!changeReserved || changeReserved.length === 0) {
      throw new Error("Failed to reserve UTXO for change");
    }
    createOps.push(
      MoonlightOperation.create(
        changeReserved[0].publicKey,
        selection.changeAmount,
      ),
    );
  }

  // 6. Get expiration
  const ledgerSequence = await getLatestLedger(config.rpcUrl);
  const expiration = ledgerSequence + 1000;

  // 7. Build and sign SPEND operations
  const spendOps = [];
  for (const utxo of selection.selectedUTXOs) {
    let spendOp = MoonlightOperation.spend(utxo.publicKey);
    for (const createOp of createOps) {
      spendOp = spendOp.addCondition(createOp.toCondition());
    }
    const signedSpend = await spendOp.signWithUTXO(
      utxo,
      config.channelContractId,
      expiration,
    );
    spendOps.push(signedSpend);
  }

  // 8. Submit bundle: CREATEs first, then SPENDs
  const operationsMLXDR = [
    ...createOps.map((op) => op.toMLXDR()),
    ...spendOps.map((op) => op.toMLXDR()),
  ];
  const bundleId = await submitBundle(jwt, operationsMLXDR, config);
  console.log(`  Bundle submitted: ${bundleId}`);

  await waitForBundle(jwt, bundleId, config);
  console.log(`  Bundle completed`);
}
