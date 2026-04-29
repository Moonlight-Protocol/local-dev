/**
 * Recording-rig key derivation.
 *
 * Derives every identity used during a video-recording run from a single
 * master secret + a per-run namespace, so each recording produces fresh,
 * deterministic keys without colliding with prior runs on shared testnets.
 *
 * Reuses the existing master-seed primitives in master-seed.ts, but replaces
 * the integer `index` argument with a string `runId` so two recordings on
 * the same day don't have to coordinate index counters.
 */
import { Keypair } from "npm:@stellar/stellar-sdk@14.2.0";
import { entropyToMnemonic, mnemonicToSeed } from "npm:bip39@3.1.0";
import { Buffer } from "node:buffer";
import { masterSeedFromSecret } from "../lib/master-seed.ts";

const encoder = new TextEncoder();

const ED25519_CURVE_SEED = encoder.encode("ed25519 seed");
const HARDENED_OFFSET = 0x80000000;
const STELLAR_BIP44_INDEX = 0;

function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hmacSha512(
  key: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    data as unknown as BufferSource,
  );
  return new Uint8Array(sig);
}

/**
 * Derive a Stellar keypair scoped to a recording run.
 *
 * Mirrors deriveKeypair() in master-seed.ts but with the `index` argument
 * replaced by a `runId` string. The runId becomes part of the SHA-256 input,
 * so different recordings produce different keypairs from the same master.
 */
export async function deriveRunKeypair(
  masterSeed: Uint8Array,
  role: string,
  runId: string,
): Promise<Keypair> {
  const roleBytes = encoder.encode(role);
  const runBytes = encoder.encode(runId);
  const input = new Uint8Array(
    masterSeed.length + roleBytes.length + 1 + runBytes.length,
  );
  let offset = 0;
  input.set(masterSeed, offset);
  offset += masterSeed.length;
  input.set(roleBytes, offset);
  offset += roleBytes.length;
  input[offset] = 0x00;
  offset += 1;
  input.set(runBytes, offset);
  const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Keypair.fromRawEd25519Seed(Buffer.from(seed));
}

/**
 * Derive a 12-word BIP39 mnemonic scoped to a recording run.
 * Browser-wallet expects this mnemonic in its `.env.seed.*` files.
 */
export async function deriveRunMnemonic(
  masterSeed: Uint8Array,
  role: string,
  runId: string,
): Promise<string> {
  const roleBytes = encoder.encode("mnemonic:" + role);
  const runBytes = encoder.encode(runId);
  const input = new Uint8Array(
    masterSeed.length + roleBytes.length + 1 + runBytes.length,
  );
  let offset = 0;
  input.set(masterSeed, offset);
  offset += masterSeed.length;
  input.set(roleBytes, offset);
  offset += roleBytes.length;
  input[offset] = 0x00;
  offset += 1;
  input.set(runBytes, offset);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  // 16 bytes of entropy → 12-word mnemonic
  const entropy = digest.slice(0, 16);
  return entropyToMnemonic(Buffer.from(entropy));
}

/**
 * Derive the primary Stellar account from a BIP39 mnemonic at m/44'/148'/0'.
 * Matches browser-wallet's `Keys.deriveStellarAccountFromMnemonic(mnemonic, 0)`.
 */
export async function deriveStellarAccountFromMnemonic(
  mnemonic: string,
): Promise<Keypair> {
  const seed = await mnemonicToSeed(mnemonic);
  const key = await hmacSha512(ED25519_CURVE_SEED, new Uint8Array(seed));
  let chainCode = key.slice(32, 64);
  let priv = key.slice(0, 32);
  for (const segment of [44, 148, STELLAR_BIP44_INDEX]) {
    const data = concatBytes(
      new Uint8Array([0]),
      priv,
      u32be(segment + HARDENED_OFFSET),
    );
    const i = await hmacSha512(chainCode, data);
    priv = i.slice(0, 32);
    chainCode = i.slice(32, 64);
  }
  return Keypair.fromRawEd25519Seed(Buffer.from(priv));
}

export interface RecordingRunKeys {
  runId: string;
  admin: { publicKey: string; secretKey: string };
  pp: { publicKey: string; secretKey: string };
  alice: {
    mnemonic: string;
    primary: { publicKey: string; secretKey: string };
  };
  bob: { mnemonic: string; primary: { publicKey: string; secretKey: string } };
}

/**
 * Derive the full set of identities used during a recording run.
 * `masterSecret` is a Stellar secret seed (S...). For local-dev / demo
 * recordings, defaults to LOCAL_DEV_MASTER_SECRET in master-seed.ts.
 */
export async function deriveRecordingRunKeys(
  masterSecret: string,
  runId: string,
): Promise<RecordingRunKeys> {
  const masterSeed = await masterSeedFromSecret(masterSecret);
  const adminKp = await deriveRunKeypair(masterSeed, "recording-admin", runId);
  const ppKp = await deriveRunKeypair(masterSeed, "recording-pp", runId);
  const aliceMnemonic = await deriveRunMnemonic(
    masterSeed,
    "recording-alice",
    runId,
  );
  const bobMnemonic = await deriveRunMnemonic(
    masterSeed,
    "recording-bob",
    runId,
  );
  const aliceKp = await deriveStellarAccountFromMnemonic(aliceMnemonic);
  const bobKp = await deriveStellarAccountFromMnemonic(bobMnemonic);

  return {
    runId,
    admin: { publicKey: adminKp.publicKey(), secretKey: adminKp.secret() },
    pp: { publicKey: ppKp.publicKey(), secretKey: ppKp.secret() },
    alice: {
      mnemonic: aliceMnemonic,
      primary: { publicKey: aliceKp.publicKey(), secretKey: aliceKp.secret() },
    },
    bob: {
      mnemonic: bobMnemonic,
      primary: { publicKey: bobKp.publicKey(), secretKey: bobKp.secret() },
    },
  };
}
