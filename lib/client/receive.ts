import {
  MoonlightOperation,
  type MoonlightTracer,
} from "@moonlight/moonlight-sdk";
import { fromDecimals } from "@colibri/core";
import type { Config } from "./config.ts";
import { setupAccount } from "./account.ts";

export async function prepareReceive(
  secretKey: string,
  amount: number,
  config: Config,
  tracer?: MoonlightTracer,
): Promise<string[]> {
  const amountBigInt = fromDecimals(amount, 7);

  // 1. Setup UTXO account and reserve 1 UTXO
  const { accountHandler } = await setupAccount(secretKey, config, 1, tracer);
  const reserved = accountHandler.reserveUTXOs(1);
  if (!reserved || reserved.length === 0) {
    throw new Error("Failed to reserve UTXO for receive");
  }

  // 2. Create CREATE operation
  const createOp = MoonlightOperation.create(
    reserved[0].publicKey,
    amountBigInt,
  );

  // 3. Return MLXDR (no submission — shared out-of-band with sender)
  return [createOp.toMLXDR()];
}
