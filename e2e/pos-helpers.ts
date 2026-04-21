/**
 * Shared test utilities for POS e2e tests.
 *
 * Provides:
 *   - deriveTestKeys: derive all identity keys from a single master seed
 *   - walletAuth: generic wallet challenge-response auth for any platform
 *   - createTestSigner: mock Signer that replaces Freighter with a raw Keypair
 *   - payApi: HTTP helper for pay-platform API calls
 *   - getPayJwt: authenticate with pay-platform and return JWT
 *   - fundAccount: fund a Stellar account via Friendbot
 *   - generateP256PublicKey: generate a random P256 public key for merchant UTXOs
 */
import { Keypair, authorizeEntry } from "stellar-sdk";
import { Buffer } from "node:buffer";
import {
  masterSeedFromSecret,
  deriveKeypair,
  ROLES,
  LOCAL_DEV_MASTER_SECRET,
} from "../lib/master-seed.ts";

// ─── Master seed key derivation ───────────────────────────────

export interface TestKeys {
  admin: Keypair;
  pp: Keypair;
  payAdmin: Keypair;
  payService: Keypair;
  merchant: Keypair;
  customer: Keypair;
}

/**
 * Derive all identity keys from a single master seed.
 * One secret → all roles, no copy-paste errors.
 */
export async function deriveTestKeys(
  masterSecret?: string,
): Promise<TestKeys> {
  const seed = await masterSeedFromSecret(
    masterSecret ?? LOCAL_DEV_MASTER_SECRET,
  );
  return {
    admin: await deriveKeypair(seed, ROLES.ADMIN, 0),
    pp: await deriveKeypair(seed, ROLES.PP, 0),
    payAdmin: await deriveKeypair(seed, ROLES.PAY_ADMIN, 0),
    payService: await deriveKeypair(seed, ROLES.PAY_SERVICE, 0),
    merchant: await deriveKeypair(seed, ROLES.ALICE, 0),
    customer: await deriveKeypair(seed, ROLES.BOB, 0),
  };
}

// ─── Pay-platform API helpers ──────────────────────────────────

export async function fundAccount(
  friendbotUrl: string,
  publicKey: string,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await fetch(`${friendbotUrl}?addr=${publicKey}`);
      if (res.ok || res.status === 400) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Friendbot failed for ${publicKey}`);
}

export async function payApi(
  payApiUrl: string,
  path: string,
  opts: RequestInit = {},
): Promise<Response> {
  return fetch(`${payApiUrl}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers as Record<string, string> ?? {}),
    },
  });
}

export async function getPayJwt(
  payApiUrl: string,
  publicKey: string,
  secretKey: string,
): Promise<string> {
  const kp = Keypair.fromSecret(secretKey);
  const chRes = await payApi(payApiUrl, "/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ publicKey }),
  });
  const { data: { nonce } } = await chRes.json();
  const sig = Buffer.from(kp.sign(Buffer.from(nonce, "base64"))).toString(
    "base64",
  );
  const vfRes = await payApi(payApiUrl, "/auth/verify", {
    method: "POST",
    body: JSON.stringify({ publicKey, nonce, signature: sig }),
  });
  const { data: { token } } = await vfRes.json();
  return token;
}

// ─── Mock signer (replaces Freighter) ──────────────────────────

/**
 * Creates a Signer-compatible object from a raw Keypair.
 * Same interface as createWalletSigner in moonlight-pay, but signs
 * with the keypair directly instead of going through Freighter.
 *
 * signSorobanAuthEntry uses the Stellar SDK's authorizeEntry — the same
 * signing logic the SDK uses internally for Keypair signers — ensuring
 * the mock doesn't diverge from the real implementation.
 */
export function createTestSigner(
  keypair: Keypair,
  networkPassphrase: string,
) {
  return {
    publicKey: () => keypair.publicKey(),

    sign: (data: Uint8Array) => {
      return Promise.resolve(keypair.sign(Buffer.from(data)));
    },

    signTransaction: async (
      xdr: string,
      opts?: { networkPassphrase?: string },
    ) => {
      const { TransactionBuilder } = await import("stellar-sdk");
      const tx = TransactionBuilder.fromXDR(
        xdr,
        opts?.networkPassphrase ?? networkPassphrase,
      );
      tx.sign(keypair);
      return { signedTxXdr: tx.toXDR() };
    },

    signSorobanAuthEntry: async (
      authEntry: unknown,
      signatureExpirationLedger: number,
      entryNetworkPassphrase: string,
    ) => {
      // Use the SDK's authorizeEntry — same code path as when
      // signWithEd25519 receives a Keypair instead of a Signer.
      return await authorizeEntry(
        authEntry,
        keypair,
        signatureExpirationLedger,
        entryNetworkPassphrase,
      );
    },

    signsFor: (pk: string) => pk === keypair.publicKey(),
  };
}

// ─── P256 key generation (for merchant UTXOs) ──────────────────

function buildPkcs8P256(rawPrivateKey: Uint8Array): ArrayBuffer {
  const header = new Uint8Array([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48,
    0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
    0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20,
  ]);
  const result = new Uint8Array(header.length + 32);
  result.set(header);
  result.set(rawPrivateKey, header.length);
  return result.buffer as ArrayBuffer;
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const binary = atob(b64 + "=".repeat(pad));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export async function generateP256PublicKey(): Promise<Uint8Array> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const seedBuf = new ArrayBuffer(32);
  new Uint8Array(seedBuf).set(seed);
  const expandKey = await crypto.subtle.importKey(
    "raw",
    seedBuf,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const expanded = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("moonlight-p256"),
    },
    expandKey,
    384,
  );
  const privateKeyBytes = new Uint8Array(expanded).slice(0, 32);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    buildPkcs8P256(privateKeyBytes),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", cryptoKey);
  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(base64UrlToBytes(jwk.x!), 1);
  publicKey.set(base64UrlToBytes(jwk.y!), 33);
  return publicKey;
}

// ─── Generic wallet challenge-response auth ───────────────────

/**
 * Wallet challenge-response auth for any platform.
 * authPath is relative to apiBaseUrl, e.g. "/admin/auth" or "/auth".
 */
export async function walletAuth(
  apiBaseUrl: string,
  authPath: string,
  publicKey: string,
  secretKey: string,
): Promise<string> {
  const kp = Keypair.fromSecret(secretKey);
  const chRes = await fetch(`${apiBaseUrl}${authPath}/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey }),
  });
  if (!chRes.ok) {
    throw new Error(
      `Auth challenge failed (${apiBaseUrl}${authPath}): ${chRes.status} ${await chRes.text()}`,
    );
  }
  const { data: { nonce } } = await chRes.json();
  const sig = Buffer.from(kp.sign(Buffer.from(nonce, "base64"))).toString(
    "base64",
  );
  const vfRes = await fetch(`${apiBaseUrl}${authPath}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey, nonce, signature: sig }),
  });
  if (!vfRes.ok) {
    throw new Error(
      `Auth verify failed (${apiBaseUrl}${authPath}): ${vfRes.status} ${await vfRes.text()}`,
    );
  }
  const { data: { token } } = await vfRes.json();
  return token;
}

// ─── Contract config loader ────────────────────────────────────

export function loadContractsEnv(
  path = "/config/contracts.env",
): {
  channelAuthId: string;
  privacyChannelId: string;
  assetId: string;
  councilUrl: string;
} {
  const env: Record<string, string> = {};
  try {
    for (
      const line of Deno.readTextFileSync(path).split("\n")
    ) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq !== -1) env[t.slice(0, eq)] = t.slice(eq + 1);
    }
  } catch {
    throw new Error(`Failed to read ${path}`);
  }
  return {
    channelAuthId: env["E2E_CHANNEL_AUTH_ID"],
    privacyChannelId: env["E2E_CHANNEL_CONTRACT_ID"],
    assetId: env["E2E_CHANNEL_ASSET_CONTRACT_ID"],
    councilUrl: env["E2E_COUNCIL_URL"],
  };
}
