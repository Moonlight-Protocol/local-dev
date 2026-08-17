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
 * membership OK, positive fee, UTXO exists on chain) but that fails at
 * execution: the SPEND is signed with the wrong UTXO keypair, so the
 * on-chain channel contract rejects the signature. Result: the bundle
 * settles as FAILED.
 *
 * Admission cannot catch this — verifying inner signatures would mean
 * emulating the contract — so the bundle reaches a slot and dies there,
 * exactly the execution-time failure stage this injection exists to show.
 *
 * NOTE: while this bundle is pending, any bundle sharing its slot fails
 * with it. Callers must wait for it to land FAILED before submitting
 * anything else on the same channel.
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
  const FEE = 1_000_000n; // 0.1 XLM, the LOW-entropy fee convention

  // 1. Deposit a small amount so the executor sees an on-chain UTXO.
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
      "No UNSPENT UTXO found after deposit — can't forge a failing bundle",
    );
  }

  const free = accountHandler.getUTXOsByState(UTXOStatus.FREE);
  if (free.length < 1) {
    throw new Error("No FREE UTXO available to sink the CREATE");
  }
  const sink = free[0];

  // 3. Balanced amounts (spend = create + fee) so admission's balance check
  //    passes — the defect is the signature, not the sums.
  const createOp = MoonlightOperation.create(
    sink.publicKey,
    source.balance - FEE,
  );

  const ledgerSequence = await getLatestLedger(config.rpcUrl);
  const expiration = ledgerSequence + 1000;

  // 4. Sign the SPEND of `source` with the WRONG keypair (the sink's). The
  //    signature envelope is present and well-formed, so admission accepts
  //    it; the contract verifies it against `source`'s key and reverts.
  let spendOp = MoonlightOperation.spend(source.publicKey);
  spendOp = spendOp.addCondition(createOp.toCondition());
  const signedSpend = await spendOp.signWithUTXO(
    sink,
    config.channelContractId,
    expiration,
  );

  const operationsMLXDR = [createOp.toMLXDR(), signedSpend.toMLXDR()];
  return await submitBundle(jwt, operationsMLXDR, config);
}
