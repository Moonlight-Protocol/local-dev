import {
  Address,
  Asset,
  hash,
  Keypair,
  Operation,
  rpc,
  StrKey,
  xdr,
} from "stellar-sdk";
import { Buffer } from "node:buffer";
import { submitTx } from "./soroban.ts";

/**
 * Upload a contract WASM to the network. Returns the 32-byte WASM hash.
 */
export async function uploadWasm(
  server: rpc.Server,
  signer: Keypair,
  networkPassphrase: string,
  wasmBytes: Uint8Array,
): Promise<Buffer> {
  console.log(`  Uploading WASM (${wasmBytes.length} bytes)...`);

  const op = Operation.uploadContractWasm({ wasm: wasmBytes });
  const result = await submitTx(server, signer, networkPassphrase, op);

  // Return value is SCV_BYTES containing the 32-byte WASM hash
  const wasmHash = Buffer.from(result.returnValue!.bytes());
  console.log(`  WASM hash: ${wasmHash.toString("hex")}`);
  return wasmHash;
}

/**
 * Deploy the Channel Auth contract with constructor(admin).
 * Returns both the contract ID and the full tx response (for event extraction).
 */
export async function deployChannelAuth(
  server: rpc.Server,
  admin: Keypair,
  networkPassphrase: string,
  wasmHash: Buffer,
): Promise<{ contractId: string; txResponse: rpc.Api.GetSuccessfulTransactionResponse }> {
  console.log("  Deploying Channel Auth contract...");

  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  const adminAddress = new Address(admin.publicKey());

  const op = Operation.createCustomContract({
    address: adminAddress,
    wasmHash,
    salt,
    constructorArgs: [adminAddress.toScVal()],
  });

  const txResponse = await submitTx(server, admin, networkPassphrase, op);
  const contractId = Address.fromScVal(txResponse.returnValue!).toString();
  console.log(`  Channel Auth: ${contractId}`);
  return { contractId, txResponse };
}

/**
 * Deploy the Privacy Channel contract with constructor(admin, auth_contract, asset).
 */
export async function deployPrivacyChannel(
  server: rpc.Server,
  admin: Keypair,
  networkPassphrase: string,
  wasmHash: Buffer,
  channelAuthId: string,
  assetContractId: string,
): Promise<string> {
  console.log("  Deploying Privacy Channel contract...");

  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  const adminAddress = new Address(admin.publicKey());
  const authAddress = new Address(channelAuthId);
  const assetAddress = new Address(assetContractId);

  const op = Operation.createCustomContract({
    address: adminAddress,
    wasmHash,
    salt,
    constructorArgs: [
      adminAddress.toScVal(),
      authAddress.toScVal(),
      assetAddress.toScVal(),
    ],
  });

  const result = await submitTx(server, admin, networkPassphrase, op);
  const contractId = Address.fromScVal(result.returnValue!).toString();
  console.log(`  Privacy Channel: ${contractId}`);
  return contractId;
}

/**
 * Deploy the native XLM Stellar Asset Contract.
 * If already deployed, computes and returns the deterministic contract ID.
 */
export async function getOrDeployNativeSac(
  server: rpc.Server,
  admin: Keypair,
  networkPassphrase: string,
): Promise<string> {
  try {
    const op = Operation.createStellarAssetContract({
      asset: Asset.native(),
    });
    const result = await submitTx(server, admin, networkPassphrase, op);
    const contractId = Address.fromScVal(result.returnValue!).toString();
    console.log(`  XLM SAC deployed: ${contractId}`);
    return contractId;
  } catch {
    // Already deployed — compute the deterministic contract ID
    const contractId = computeNativeSacId(networkPassphrase);
    console.log(`  XLM SAC (already deployed): ${contractId}`);
    return contractId;
  }
}

/**
 * Compute the deterministic contract ID for native XLM SAC.
 */
function computeNativeSacId(networkPassphrase: string): string {
  const networkId = hash(Buffer.from(networkPassphrase));
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId,
      contractIdPreimage:
        xdr.ContractIdPreimage.contractIdPreimageFromAsset(
          Asset.native().toXDRObject(),
        ),
    }),
  );
  const contractIdHash = hash(preimage.toXDR());
  return StrKey.encodeContract(contractIdHash);
}
