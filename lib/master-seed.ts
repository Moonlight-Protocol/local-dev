/**
 * Master seed key derivation for local-dev and testnet/mainnet scripts.
 *
 * All identity keys derive from a single master seed so that switching
 * to a different master secret (e.g., a funded mainnet wallet) changes
 * all derived keys consistently.
 *
 * Derivation: masterSeed + role + index → SHA-256 → Ed25519 keypair.
 *
 * See /Users/theahaco/repos/pm-theahaco/key-derivation.md for the full spec.
 */
import { Keypair } from "stellar-sdk";
import { Buffer } from "node:buffer";

const encoder = new TextEncoder();

/**
 * Create a 32-byte master seed from a Stellar secret key.
 * The secret key's raw 32-byte Ed25519 seed is hashed to produce
 * the master seed (so the master seed ≠ the secret key itself).
 */
export async function masterSeedFromSecret(stellarSecret: string): Promise<Uint8Array> {
  const keypair = Keypair.fromSecret(stellarSecret);
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(keypair.rawSecretKey())),
  );
}

/**
 * Derive a Stellar keypair from a master seed, role name, and index.
 *
 * The derivation is: SHA-256(masterSeed || role || index) → 32-byte Ed25519 seed.
 * Deterministic: same inputs always produce the same keypair.
 */
export async function deriveKeypair(
  masterSeed: Uint8Array,
  role: string,
  index: number,
): Promise<Keypair> {
  const roleBytes = encoder.encode(role);
  const indexBytes = encoder.encode(String(index));
  const input = new Uint8Array(masterSeed.length + roleBytes.length + indexBytes.length);
  input.set(masterSeed, 0);
  input.set(roleBytes, masterSeed.length);
  input.set(indexBytes, masterSeed.length + roleBytes.length);
  const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Keypair.fromRawEd25519Seed(Buffer.from(seed));
}

/** Standard role names used across local-dev and testnet/lifecycle scripts. */
export const ROLES = {
  ADMIN: "admin",
  PP: "pp",
  OPEX: "opex",
  PAY_ADMIN: "pay-admin",
  PAY_SERVICE: "pay-service",
  ALICE: "alice",
  BOB: "bob",
} as const;

/** Default master secret for local-dev. Not a real secret — local-dev only. */
export const LOCAL_DEV_MASTER_SECRET =
  "SAQCGLJ2JISI67QGG457IBN2DY6YW5GGS2OMQU5KNLXB3TWVUIR2RD74";

/**
 * Derive all standard role keypairs from a master seed.
 * Returns a record keyed by role name.
 */
export async function deriveAllKeys(masterSeed: Uint8Array): Promise<
  Record<string, { publicKey: string; secretKey: string }>
> {
  const result: Record<string, { publicKey: string; secretKey: string }> = {};
  for (const [key, role] of Object.entries(ROLES)) {
    const kp = await deriveKeypair(masterSeed, role, 0);
    result[key] = { publicKey: kp.publicKey(), secretKey: kp.secret() };
  }
  return result;
}
