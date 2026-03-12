import { Keypair } from "stellar-sdk";
import { MoonlightOperation, type MoonlightTracer } from "@moonlight/moonlight-sdk";
import { fromDecimals, type Ed25519PublicKey } from "@colibri/core";
import type { Config } from "./config.ts";
import { setupAccount, getLatestLedger } from "./account.ts";
import { submitBundle, waitForBundle } from "./bundle.ts";

const DEPOSIT_FEE = 0.05; // LOW entropy fee

export async function deposit(
  secretKey: string,
  amount: number,
  jwt: string,
  config: Config,
  tracer?: MoonlightTracer,
): Promise<void> {
  const keypair = Keypair.fromSecret(secretKey);
  const totalAmount = fromDecimals(amount + DEPOSIT_FEE, 7);
  const depositAmount = fromDecimals(amount, 7);

  // 1. Setup UTXO account and reserve 1 UTXO
  const { accountHandler } = await setupAccount(secretKey, config, 1, tracer);
  const reserved = accountHandler.reserveUTXOs(1);
  if (!reserved || reserved.length === 0) {
    throw new Error("Failed to reserve UTXO for deposit");
  }

  // 2. Create CREATE operation for the reserved UTXO
  const createOp = MoonlightOperation.create(reserved[0].publicKey, depositAmount);

  // 3. Get expiration
  const ledgerSequence = await getLatestLedger(config.rpcUrl);
  const expiration = ledgerSequence + 1000;

  // 4. Create and sign DEPOSIT operation
  const depositOp = await MoonlightOperation.deposit(
    keypair.publicKey() as Ed25519PublicKey,
    totalAmount,
  )
    .addConditions([createOp.toCondition()])
    .signWithEd25519(
      keypair,
      expiration,
      config.channelContractId,
      config.channelAssetContractId,
      config.networkPassphrase,
    );

  // 5. Submit bundle
  const operationsMLXDR = [depositOp.toMLXDR(), createOp.toMLXDR()];
  const bundleId = await submitBundle(jwt, operationsMLXDR, config);
  console.log(`  Bundle submitted: ${bundleId}`);

  await waitForBundle(jwt, bundleId, config);
  console.log(`  Bundle completed`);
}
