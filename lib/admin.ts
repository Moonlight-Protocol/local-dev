import {
  Address,
  Contract,
  Keypair,
  rpc,
} from "npm:@stellar/stellar-sdk@14.2.0";
import { submitTx } from "./soroban.ts";

/**
 * Register a Privacy Provider in the Channel Auth contract.
 * Calls add_provider(provider) — requires admin authorization.
 * Returns the transaction response for event extraction.
 */
export async function addProvider(
  server: rpc.Server,
  admin: Keypair,
  networkPassphrase: string,
  channelAuthId: string,
  providerPublicKey: string,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  console.log(`  Registering provider ${providerPublicKey.slice(0, 8)}...`);

  const contract = new Contract(channelAuthId);
  const op = contract.call(
    "add_provider",
    new Address(providerPublicKey).toScVal(),
  );

  const result = await submitTx(server, admin, networkPassphrase, op);
  console.log("  Provider registered");
  return result;
}

/**
 * Deregister a Privacy Provider from the Channel Auth contract.
 * Calls remove_provider(provider) — requires admin authorization.
 * Returns the transaction response for event extraction.
 */
export async function removeProvider(
  server: rpc.Server,
  admin: Keypair,
  networkPassphrase: string,
  channelAuthId: string,
  providerPublicKey: string,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  console.log(`  Removing provider ${providerPublicKey.slice(0, 8)}...`);

  const contract = new Contract(channelAuthId);
  const op = contract.call(
    "remove_provider",
    new Address(providerPublicKey).toScVal(),
  );

  const result = await submitTx(server, admin, networkPassphrase, op);
  console.log("  Provider removed");
  return result;
}

/**
 * Disable an asset channel on the Channel Auth contract.
 * Calls disable_channel(channel, asset) — quorum/admin authorized. Emits a
 * channel_state_changed event (enabled=false). The contract stores no state.
 */
export async function disableChannel(
  server: rpc.Server,
  admin: Keypair,
  networkPassphrase: string,
  channelAuthId: string,
  channelContractId: string,
  assetContractId: string,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  console.log(`  Disabling channel ${channelContractId.slice(0, 8)}...`);

  const contract = new Contract(channelAuthId);
  const op = contract.call(
    "disable_channel",
    new Address(channelContractId).toScVal(),
    new Address(assetContractId).toScVal(),
  );

  const result = await submitTx(server, admin, networkPassphrase, op);
  console.log("  Channel disabled");
  return result;
}

/**
 * Enable (or re-enable) an asset channel on the Channel Auth contract.
 * Calls enable_channel(channel, asset) — quorum/admin authorized. Emits a
 * channel_state_changed event (enabled=true). Re-enable reuses this call.
 */
export async function enableChannel(
  server: rpc.Server,
  admin: Keypair,
  networkPassphrase: string,
  channelAuthId: string,
  channelContractId: string,
  assetContractId: string,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  console.log(`  Enabling channel ${channelContractId.slice(0, 8)}...`);

  const contract = new Contract(channelAuthId);
  const op = contract.call(
    "enable_channel",
    new Address(channelContractId).toScVal(),
    new Address(assetContractId).toScVal(),
  );

  const result = await submitTx(server, admin, networkPassphrase, op);
  console.log("  Channel enabled");
  return result;
}
