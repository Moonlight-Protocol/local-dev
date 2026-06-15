/**
 * Helpers for issuing and funding a custom-issued classic Stellar asset
 * (e.g. a local `USDC:<issuer>`), so the multi-asset flow can deposit a real
 * non-XLM asset into a privacy channel.
 *
 * On a standalone/local node the asset is minted from a local issuer account.
 * On testnet the asset is Circle's USDC and these helpers are unused for
 * issuance — holders just need a trustline before they can hold/withdraw it.
 *
 * Asset `code`/`issuer` are taken as strings (not an `Asset`) so the `Asset` is
 * always built with this module's stellar-sdk version — an `Asset` constructed
 * by a different SDK version fails `Operation`'s `instanceof Asset` check.
 */
import { Asset, Keypair, Operation, rpc } from "npm:@stellar/stellar-sdk@14.2.0";
import { submitClassicTx } from "./soroban.ts";

/**
 * Add a trustline from `holder` to the `code:issuer` asset. Required before a
 * classic account can hold a custom asset (deposit source, withdraw
 * destination). No-op-safe: re-adding an existing trustline succeeds.
 */
export async function establishTrustline(
  server: rpc.Server,
  holder: Keypair,
  networkPassphrase: string,
  code: string,
  issuer: string,
): Promise<void> {
  await submitClassicTx(server, holder, networkPassphrase, [
    Operation.changeTrust({ asset: new Asset(code, issuer) }),
  ]);
  console.log(`  Trustline ${code} ← ${holder.publicKey().slice(0, 8)}…`);
}

/**
 * Pay `amount` of the `code:issuer` asset from its issuer to `destination`.
 * The destination must already have a trustline. Amount is a decimal string
 * (7-dp asset units), e.g. "100".
 */
export async function payAsset(
  server: rpc.Server,
  issuer: Keypair,
  networkPassphrase: string,
  code: string,
  destination: string,
  amount: string,
): Promise<void> {
  await submitClassicTx(server, issuer, networkPassphrase, [
    Operation.payment({
      destination,
      asset: new Asset(code, issuer.publicKey()),
      amount,
    }),
  ]);
  console.log(`  Paid ${amount} ${code} → ${destination.slice(0, 8)}…`);
}

/**
 * Establish a trustline and fund `holder` with `amount` of the issued asset
 * in one helper — the common "give a user some USDC to spend" step.
 */
export async function issueAssetTo(
  server: rpc.Server,
  issuer: Keypair,
  holder: Keypair,
  networkPassphrase: string,
  code: string,
  amount: string,
): Promise<void> {
  await establishTrustline(
    server,
    holder,
    networkPassphrase,
    code,
    issuer.publicKey(),
  );
  await payAsset(
    server,
    issuer,
    networkPassphrase,
    code,
    holder.publicKey(),
    amount,
  );
}

/**
 * Read a classic account's balance of a specific asset from Horizon.
 * Returns the balance as a number (asset units), or 0 if no trustline exists.
 */
export async function getClassicAssetBalance(
  horizonUrl: string,
  publicKey: string,
  code: string,
  issuer: string,
): Promise<number> {
  const res = await fetch(`${horizonUrl}/accounts/${publicKey}`);
  if (!res.ok) {
    if (res.status === 404) return 0;
    throw new Error(
      `Horizon account fetch failed for ${publicKey}: ${res.status}`,
    );
  }
  const account = await res.json();
  for (const b of account.balances ?? []) {
    if (b.asset_code === code && b.asset_issuer === issuer) {
      return Number(b.balance);
    }
  }
  return 0;
}
