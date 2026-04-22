/**
 * Master seed key derivation — Node.js port of lib/master-seed.ts.
 *
 * All identity keys derive from a single master secret so that one env var
 * produces all the test accounts. Same derivation as the Deno version in
 * local-dev/lib/master-seed.ts.
 *
 * Derivation: SHA-256(stellarSecret.rawSeed) → masterSeed
 *             SHA-256(masterSeed || role || index) → Ed25519 keypair
 */
import { Keypair } from "@stellar/stellar-sdk";
import { createHash } from "crypto";

/** Standard role names — must match lib/master-seed.ts ROLES exactly. */
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
 * Create a 32-byte master seed from a Stellar secret key.
 * SHA-256 of the raw 32-byte Ed25519 seed.
 */
export function masterSeedFromSecret(stellarSecret: string): Buffer {
  const keypair = Keypair.fromSecret(stellarSecret);
  return createHash("sha256").update(keypair.rawSecretKey()).digest();
}

/**
 * Derive a Stellar keypair from a master seed, role, and index.
 * SHA-256(masterSeed || role || index) → Ed25519 seed → Keypair.
 */
export function deriveKeypair(
  masterSeed: Buffer,
  role: string,
  index: number,
): Keypair {
  const hash = createHash("sha256");
  hash.update(masterSeed);
  hash.update(role);
  hash.update(String(index));
  const seed = hash.digest();
  return Keypair.fromRawEd25519Seed(seed);
}

/**
 * User profiles needed for the full flow test.
 * Maps role names to the Playwright user context names.
 */
export interface DerivedProfiles {
  council: { name: string; publicKey: string; secretKey: string };
  provider: { name: string; publicKey: string; secretKey: string };
  admin: { name: string; publicKey: string; secretKey: string };
  merchant: { name: string; publicKey: string; secretKey: string };
  pos: { name: string; publicKey: string; secretKey: string };
}

/**
 * Derive all user profiles from a master secret.
 *
 * Role mapping:
 *   council  → ADMIN   (council admin, deploys contracts)
 *   provider → PP      (PP operator)
 *   admin    → PAY_ADMIN (moonlight-pay admin)
 *   merchant → ALICE   (test merchant)
 *   pos      → BOB     (test POS payer)
 */
export function deriveAllProfiles(masterSecret?: string): DerivedProfiles {
  const secret = masterSecret || LOCAL_DEV_MASTER_SECRET;
  const seed = masterSeedFromSecret(secret);

  const council = deriveKeypair(seed, ROLES.ADMIN, 0);
  const provider = deriveKeypair(seed, ROLES.PP, 0);
  const admin = deriveKeypair(seed, ROLES.PAY_ADMIN, 0);
  const merchant = deriveKeypair(seed, ROLES.ALICE, 0);
  const pos = deriveKeypair(seed, ROLES.BOB, 0);

  return {
    council: {
      name: "Council User",
      publicKey: council.publicKey(),
      secretKey: council.secret(),
    },
    provider: {
      name: "Provider User",
      publicKey: provider.publicKey(),
      secretKey: provider.secret(),
    },
    admin: {
      name: "Admin User",
      publicKey: admin.publicKey(),
      secretKey: admin.secret(),
    },
    merchant: {
      name: "Merchant User",
      publicKey: merchant.publicKey(),
      secretKey: merchant.secret(),
    },
    pos: {
      name: "POS User",
      publicKey: pos.publicKey(),
      secretKey: pos.secret(),
    },
  };
}
