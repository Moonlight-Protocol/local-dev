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
 * Submits a well-formed bundle whose SPEND signature has already expired:
 * its expiration ledger is behind the current one. The platform derives a
 * bundle's TTL from its earliest spend-signature expiration, so this bundle
 * is past its TTL the moment it is admitted and the platform expires it
 * through its ordinary TTL path. Result: the bundle lands as EXPIRED,
 * with no database access from this script.
 */
export async function injectExpiringBundle(
  senderSecret: string,
  jwt: string,
  config: Config,
  tracer?: MoonlightTracer,
): Promise<string> {
  // Same clean-float sizing as the fail injection.
  const EXPIRE_DEPOSIT = 0.5;
  const FEE = 1_000_000n; // 0.1 XLM

  // 1. Deposit so there is a fresh on-chain UTXO to spend.
  await deposit(senderSecret, EXPIRE_DEPOSIT, jwt, config, tracer);

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
      "No UNSPENT UTXO found after deposit — can't build an expiring bundle",
    );
  }

  const free = accountHandler.getUTXOsByState(UTXOStatus.FREE);
  if (free.length < 1) {
    throw new Error("No FREE UTXO available to sink the CREATE");
  }
  const sink = free[0];

  // 3. Balanced amounts and a correct signature — the only defect is the
  //    expiration ledger, already in the past at submission time.
  const createOp = MoonlightOperation.create(
    sink.publicKey,
    source.balance - FEE,
  );

  const ledgerSequence = await getLatestLedger(config.rpcUrl);
  const expiration = ledgerSequence - 1;

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
