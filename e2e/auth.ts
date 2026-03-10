import { Keypair, TransactionBuilder } from "stellar-sdk";
import type { Config } from "./config.ts";

export async function authenticate(
  keypair: Keypair,
  config: Config,
): Promise<string> {
  const publicKey = keypair.publicKey();

  // 1. Get auth challenge
  const challengeRes = await fetch(
    `${config.providerUrl}/api/v1/stellar/auth?account=${publicKey}`,
  );
  if (!challengeRes.ok) {
    throw new Error(
      `Auth challenge failed: ${challengeRes.status} ${await challengeRes.text()}`,
    );
  }
  const challengeData = await challengeRes.json();
  const challengeXdr: string = challengeData.data.challenge;

  // 2. Co-sign the challenge transaction
  const tx = TransactionBuilder.fromXDR(challengeXdr, config.networkPassphrase);
  tx.sign(keypair);
  const signedXdr = tx.toXDR();

  // 3. Submit signed challenge
  const authRes = await fetch(`${config.providerUrl}/api/v1/stellar/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedChallenge: signedXdr }),
  });
  if (!authRes.ok) {
    throw new Error(
      `Auth verify failed: ${authRes.status} ${await authRes.text()}`,
    );
  }
  const authData = await authRes.json();
  const jwt: string = authData.data.jwt;

  if (!jwt) {
    throw new Error(`No JWT in auth response: ${JSON.stringify(authData)}`);
  }

  return jwt;
}
