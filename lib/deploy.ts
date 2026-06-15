import {
  Address,
  Asset,
  hash,
  Keypair,
  Operation,
  rpc,
  StrKey,
  xdr,
} from "npm:@stellar/stellar-sdk@14.2.0";
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
 *
 * Soroban contract addresses are derived from
 * Hash(network_id || "ContractInstance" || deployer || salt). Pass an explicit
 * `salt` to get a deterministic contract address (useful for local-dev where
 * we want repeatable IDs across `down`/`up` cycles). Defaults to a fresh
 * random salt for production-like (testnet) deploys.
 */
export async function deployChannelAuth(
  server: rpc.Server,
  admin: Keypair,
  networkPassphrase: string,
  wasmHash: Buffer,
  salt?: Buffer,
): Promise<
  { contractId: string; txResponse: rpc.Api.GetSuccessfulTransactionResponse }
> {
  console.log("  Deploying Channel Auth contract...");

  salt ??= Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
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
 *
 * As with `deployChannelAuth`, pass an explicit `salt` for a deterministic
 * contract address. Defaults to a fresh random salt.
 */
export async function deployPrivacyChannel(
  server: rpc.Server,
  admin: Keypair,
  networkPassphrase: string,
  wasmHash: Buffer,
  channelAuthId: string,
  assetContractId: string,
  salt?: Buffer,
): Promise<string> {
  console.log("  Deploying Privacy Channel contract...");

  salt ??= Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
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
export function getOrDeployNativeSac(
  server: rpc.Server,
  admin: Keypair,
  networkPassphrase: string,
): Promise<string> {
  return getOrDeploySac(server, admin, networkPassphrase, Asset.native());
}

/**
 * Deploy the Stellar Asset Contract for a custom-issued classic asset
 * (e.g. `USDC:GBBD47…`). Sibling of `getOrDeployNativeSac` — the channel is
 * asset-parameterized, so a second channel can bind to this SAC to enable a
 * second asset under the same council.
 *
 * On testnet, pass Circle's USDC (`code="USDC"`, `issuer="GBBD47…"`); locally,
 * pass a custom asset issued from a local issuer (see `lib/classic-asset.ts`).
 * Anyone may deploy a SAC, so `admin` (or any funded account) can call this.
 *
 * `code`/`issuer` are passed as strings (not an `Asset`) so the `Asset` is
 * constructed with this module's stellar-sdk version — passing an `Asset` built
 * by a different SDK version fails `Operation`'s `instanceof Asset` check.
 */
export function getOrDeployCustomSac(
  server: rpc.Server,
  admin: Keypair,
  networkPassphrase: string,
  code: string,
  issuer: string,
): Promise<string> {
  return getOrDeploySac(
    server,
    admin,
    networkPassphrase,
    new Asset(code, issuer),
  );
}

/**
 * Deploy the SAC for any asset (native or custom). If it is already deployed,
 * computes and returns the deterministic contract ID.
 */
async function getOrDeploySac(
  server: rpc.Server,
  admin: Keypair,
  networkPassphrase: string,
  asset: Asset,
): Promise<string> {
  const label = asset.isNative() ? "XLM" : asset.getCode();
  try {
    const op = Operation.createStellarAssetContract({ asset });
    const result = await submitTx(server, admin, networkPassphrase, op);
    const contractId = Address.fromScVal(result.returnValue!).toString();
    console.log(`  ${label} SAC deployed: ${contractId}`);
    return contractId;
  } catch (err) {
    // Typically "contract already exists" — recompute the deterministic ID.
    // Log the underlying reason so a genuine deploy failure isn't masked as
    // "already deployed".
    const contractId = computeSacId(networkPassphrase, asset);
    console.log(
      `  ${label} SAC (already deployed): ${contractId} (deploy skipped: ${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return contractId;
  }
}

/**
 * Compute the deterministic contract ID for an asset's SAC.
 */
function computeSacId(networkPassphrase: string, asset: Asset): string {
  const networkId = hash(Buffer.from(networkPassphrase));
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId,
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(
        asset.toXDRObject(),
      ),
    }),
  );
  const contractIdHash = hash(preimage.toXDR());
  return StrKey.encodeContract(contractIdHash);
}
