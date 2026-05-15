import {
  ChannelReadMethods,
  type MoonlightTracer,
  PrivacyChannel,
  StellarDerivator,
  UtxoBasedStellarAccount,
  UTXOStatus,
} from "@moonlight/moonlight-sdk";
import type { Ed25519SecretKey } from "@colibri/core";
import { Buffer } from "node:buffer";
import type { Config } from "./config.ts";

export async function setupAccount(
  secretKey: string,
  config: Config,
  minFreeUtxos: number,
  tracer?: MoonlightTracer,
): Promise<{
  accountHandler: UtxoBasedStellarAccount;
  channelClient: PrivacyChannel;
}> {
  const stellarDerivator = new StellarDerivator().withNetworkAndContract(
    config.networkId,
    config.channelContractId,
  );

  const channelClient = new PrivacyChannel(
    config.networkConfig,
    config.channelContractId,
    config.channelAuthId,
    config.channelAssetContractId,
    tracer ? { tracer } : undefined,
  );

  const accountHandler = new UtxoBasedStellarAccount({
    root: secretKey as Ed25519SecretKey,
    derivator: stellarDerivator,
    options: {
      batchSize: 50,
      tracer,
      fetchBalances(publicKeys: Uint8Array[]) {
        return channelClient.read({
          method: ChannelReadMethods.utxo_balances,
          methodArgs: { utxos: publicKeys.map((pk) => Buffer.from(pk)) },
        });
      },
    },
  });

  // Derive batches until we have enough free UTXOs
  let attempts = 0;
  while (
    accountHandler.getUTXOsByState(UTXOStatus.FREE).length < minFreeUtxos
  ) {
    if (attempts++ > 10) {
      throw new Error(
        `Could not derive enough free UTXOs after ${attempts} attempts`,
      );
    }
    await accountHandler.deriveBatch({});
    await accountHandler.batchLoad();
  }

  return { accountHandler, channelClient };
}

export async function getLatestLedger(
  rpcUrl: string,
): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getLatestLedger",
    }),
  });
  const data = await res.json();
  return data.result.sequence;
}
