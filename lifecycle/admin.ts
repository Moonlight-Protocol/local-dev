import { Address, Contract, Keypair, rpc } from "stellar-sdk";
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
