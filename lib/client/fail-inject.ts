import {
  MoonlightOperation,
  type MoonlightTracer,
  UTXOStatus,
} from "@moonlight/moonlight-sdk";
import type { Config } from "./config.ts";
import { getLatestLedger, setupAccount } from "./account.ts";
import { submitBundle } from "./bundle.ts";
import { deposit } from "./deposit.ts";

/**
 * Submits a bundle that the server admits (entity APPROVED, channel
 * membership OK, signatures valid, UTXO exists on chain) but the executor's
 * on-chain simulation rejects. Result: bundle settles as FAILED.
 *
 * Trick: we deposit a small known amount to mint a fresh UNSPENT UTXO,
 * then build a SPEND of that UTXO with a CREATE condition for 100× the
 * amount. The server's pre-validation passes (UTXO exists, signatures
 * verify) but the on-chain channel contract enforces sum(SPEND) ==
 * sum(CREATE) and rejects.
 */
export async function injectFailingBundle(
  senderSecret: string,
  jwt: string,
  config: Config,
  tracer?: MoonlightTracer,
): Promise<string> {
  // 0.5 + 0.05 deposit fee = 0.55 (clean float). Using 0.1 would produce
  // 0.15000000000000002 inside Colibri's fromDecimals and trip its
  // fractional-digits guard before the bundle is ever submitted.
  const FAIL_DEPOSIT = 0.5;

  // 1. Deposit a small amount so the executor sees an on-chain UTXO. The
  //    deposit completes normally — we'll overspend its product UTXO next.
  await deposit(senderSecret, FAIL_DEPOSIT, jwt, config, tracer);

  // 2. Re-derive the account so the new UNSPENT UTXO is loaded.
  const { accountHandler } = await setupAccount(
    senderSecret,
    config,
    2,
    tracer,
  );

  const unspent = accountHandler.getUTXOsByState(UTXOStatus.UNSPENT);
  const source = unspent.find((u) => u.balance > 0n);
  if (!source) {
    throw new Error(
      "No UNSPENT UTXO found after deposit — can't forge overspend",
    );
  }

  // 3. Build a CREATE for source.balance × 2. The on-chain channel contract
  //    enforces sum(SPEND) == sum(CREATE), so the executor's fee aggregation
  //    rejects (sum-of-spends − sum-of-creates < 0 → MoonlightOperation.create
  //    asserts amount > 0). Using 2× keeps the amount a clean fixed-point
  //    multiple (avoids the SDK's float-precision-fractional-digits guard
  //    that trips on, e.g., balance + 1n stroop).
  const free = accountHandler.getUTXOsByState(UTXOStatus.FREE);
  if (free.length < 1) {
    throw new Error("No FREE UTXO available to sink the overspend CREATE");
  }
  const sink = free[0];
  const createOp = MoonlightOperation.create(
    sink.publicKey,
    source.balance * 2n,
  );

  const ledgerSequence = await getLatestLedger(config.rpcUrl);
  const expiration = ledgerSequence + 1000;

  let spendOp = MoonlightOperation.spend(source.publicKey);
  spendOp = spendOp.addCondition(createOp.toCondition());
  const signedSpend = await spendOp.signWithUTXO(
    source,
    config.channelContractId,
    expiration,
  );

  const operationsMLXDR = [createOp.toMLXDR(), signedSpend.toMLXDR()];
  return await submitBundle(jwt, operationsMLXDR, config);
}
