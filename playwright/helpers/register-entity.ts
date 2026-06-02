/**
 * Server-side helper to register a wallet as an APPROVED entity on a
 * provider-platform PP. Matches the SEP-43/raw signed-challenge flow that
 * `provider-platform`'s `POST /providers/:pp/entities` requires.
 *
 * Used as test setup in the playwright full-flow: pay-platform submits
 * bundles on behalf of customers via the `pay-service` identity, and
 * provider-platform's add-bundle gate rejects submitters whose entity row
 * is not APPROVED. A real deployment seeds pay-service's entity once at
 * deploy time; for the test we do the equivalent before the POS payment
 * step.
 *
 * This is intentionally an API-direct path, not a UI flow — the test's
 * Freighter setup doesn't include the pay-service identity. The new UI at
 * `provider-console#/entities/register?provider=<pp_pk>` is exercised
 * separately in Step 10.5 using a user identity that IS in Freighter.
 */
import { Keypair } from "@stellar/stellar-sdk";

export async function registerEntityViaApi(
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
  const challengeBody = await challengeRes.json() as {
    data: { nonce: string };
  };
  const nonce = challengeBody.data.nonce;

  // SEP-43 raw nonce-bytes signature — matches verify-stellar-signature.ts's
  // raw fallback used by SDK / E2E flows.
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
