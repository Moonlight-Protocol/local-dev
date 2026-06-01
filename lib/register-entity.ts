import { Buffer } from "node:buffer";
import type { Keypair } from "stellar-sdk";

/**
 * Registers a user (the submitter) as an APPROVED entity against a specific
 * PP. Replaces the old POST /api/v1/entities flat-pubkey call: the new
 * endpoint is per-PP and requires a SEP-53/raw signed challenge proving
 * the submitter controls the wallet.
 *
 * Flow:
 *   1. POST /providers/:ppPublicKey/entities/challenge {pubkey}  → {nonce}
 *   2. Sign the raw base64-decoded nonce bytes with the user's Ed25519 key
 *   3. POST /providers/:ppPublicKey/entities {pubkey, name, jurisdictions,
 *      signedChallenge: {nonce, signature}}
 *
 * Idempotent: 409 from the submit step means the entity is already APPROVED
 * (treated as success).
 */
export async function registerEntity(
  providerUrl: string,
  ppPublicKey: string,
  user: Keypair,
  name: string,
  jurisdictions: string[] = [],
): Promise<void> {
  const base = `${providerUrl}/api/v1/providers/${
    encodeURIComponent(ppPublicKey)
  }/entities`;

  const challengeRes = await fetch(`${base}/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: user.publicKey() }),
  });
  if (!challengeRes.ok) {
    throw new Error(
      `Entity challenge failed for ${user.publicKey()}: ${challengeRes.status} ${await challengeRes
        .text()}`,
    );
  }
  const { data: { nonce } } = await challengeRes.json();

  const nonceBytes = Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0));
  const sigBytes = user.sign(Buffer.from(nonceBytes));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));

  const res = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pubkey: user.publicKey(),
      name,
      jurisdictions,
      signedChallenge: { nonce, signature },
    }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(
      `Entity registration failed for ${user.publicKey()}: ${res.status} ${await res
        .text()}`,
    );
  }
}
