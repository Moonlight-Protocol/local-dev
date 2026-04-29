/**
 * Local Dev — Browser Extension Account Funder
 *
 * Specialized helper that reads the browser-wallet's dev-seed files,
 * derives the Stellar account keypair from each seed mnemonic at index 0
 * (matching `Keys.deriveStellarAccountFromMnemonic` in browser-wallet/src/keys/keys.ts),
 * and funds those accounts via Friendbot.
 *
 * Why a separate script: setup-accounts.ts is generic (takes pubkeys
 * directly). This wrapper knows where the wallet's seed mnemonics live
 * and how the wallet derives accounts from them, so the typical manual
 * test cycle never needs to copy-paste a Stellar address.
 *
 * Usage (preferred — via wrapper):
 *   ./setup-accounts-extension.sh
 *
 * Usage (direct):
 *   deno run --allow-all setup-accounts-extension.ts
 *
 * Env overrides:
 *   FRIENDBOT_URL                 default http://localhost:8000/friendbot
 *   WALLET_SEED_DIR               default ../browser-wallet
 *   SEED_FILES                    comma-separated, default ".env.seed.user1,.env.seed.user2"
 *   DERIVATION_INDEX              default 0
 */
import { Keypair } from "npm:@stellar/stellar-sdk@14.2.0";
import { Buffer } from "node:buffer";
import { mnemonicToSeed } from "npm:bip39@3.1.0";
import { formatResults, fundAccounts } from "./setup-accounts.ts";

const FRIENDBOT_URL = Deno.env.get("FRIENDBOT_URL") ??
  "http://localhost:8000/friendbot";
const WALLET_SEED_DIR = Deno.env.get("WALLET_SEED_DIR") ??
  new URL("../browser-wallet", import.meta.url).pathname;
const SEED_FILES =
  (Deno.env.get("SEED_FILES") ?? ".env.seed.user1,.env.seed.user2")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
const DERIVATION_INDEX = Number(Deno.env.get("DERIVATION_INDEX") ?? "0");

// ─── SLIP-0010 derivation (matches browser-wallet/src/keys/keys.ts) ────
//
// We can't import from the wallet directly (different repo, different
// import map), so we replicate the derivation. Verified to match the
// wallet's `Keys.deriveStellarAccountFromMnemonic(mnemonic, index)`:
//   - bip39 mnemonic → 64-byte seed
//   - SLIP-0010 ed25519 master key from seed (HMAC-SHA512 with "ed25519 seed")
//   - Hardened derivation along m/44'/148'/index'
//   - Stellar Keypair.fromRawEd25519Seed(node.key)

const ED25519_CURVE_SEED = new TextEncoder().encode("ed25519 seed");
const HARDENED_OFFSET = 0x80000000;

interface ExtendedKey {
  key: Uint8Array;
  chainCode: Uint8Array;
}

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

async function slip10MasterKeyFromSeed(seed: Uint8Array): Promise<ExtendedKey> {
  const i = await hmacSha512(ED25519_CURVE_SEED, seed);
  return { key: i.slice(0, 32), chainCode: i.slice(32, 64) };
}

async function ckdPriv(
  parent: ExtendedKey,
  index: number,
): Promise<ExtendedKey> {
  if (index < HARDENED_OFFSET) {
    throw new Error("ed25519 derivation requires hardened index");
  }
  const data = concatBytes(new Uint8Array([0]), parent.key, u32be(index));
  const i = await hmacSha512(parent.chainCode, data);
  return { key: i.slice(0, 32), chainCode: i.slice(32, 64) };
}

async function deriveStellarKeypairFromMnemonic(
  mnemonic: string,
  index = 0,
): Promise<Keypair> {
  const seed = await mnemonicToSeed(mnemonic);
  const seedBytes = new Uint8Array(seed);

  let node = await slip10MasterKeyFromSeed(seedBytes);
  // m/44'/148'/index'
  const path = [44, 148, index];
  for (const segment of path) {
    node = await ckdPriv(node, segment + HARDENED_OFFSET);
  }

  return Keypair.fromRawEd25519Seed(Buffer.from(node.key));
}

// ─── Seed file parsing ─────────────────────────────────────────────────

interface SeedFileEntry {
  path: string;
  mnemonic: string;
  publicKey?: string;
}

async function readSeedFile(path: string): Promise<SeedFileEntry | null> {
  let content: string;
  try {
    content = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return null;
    }
    throw err;
  }

  let mnemonic: string | undefined;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("SEED_MNEMONIC=")) {
      mnemonic = trimmed.slice("SEED_MNEMONIC=".length).trim();
      break;
    }
  }

  if (!mnemonic) {
    throw new Error(`Seed file ${path} has no SEED_MNEMONIC entry`);
  }

  return { path, mnemonic };
}

async function main() {
  console.log("\n=== local-dev — Browser Extension Account Funder ===\n");
  console.log(`  Friendbot:        ${FRIENDBOT_URL}`);
  console.log(`  Wallet seed dir:  ${WALLET_SEED_DIR}`);
  console.log(`  Seed files:       ${SEED_FILES.join(", ")}`);
  console.log(`  Derivation index: ${DERIVATION_INDEX}`);
  console.log("");

  // 1. Read each seed file and derive the Stellar pubkey
  const entries: SeedFileEntry[] = [];
  for (const fileName of SEED_FILES) {
    const fullPath = `${WALLET_SEED_DIR}/${fileName}`;
    const entry = await readSeedFile(fullPath);
    if (!entry) {
      console.error(`  ✗ ${fileName}: not found at ${fullPath}`);
      continue;
    }
    const kp = await deriveStellarKeypairFromMnemonic(
      entry.mnemonic,
      DERIVATION_INDEX,
    );
    entry.publicKey = kp.publicKey();
    entries.push(entry);
    console.log(`  ${fileName.padEnd(20)} → ${entry.publicKey}`);
  }

  if (entries.length === 0) {
    console.error(
      "\nNo seed files found. Set WALLET_SEED_DIR or SEED_FILES env vars.",
    );
    Deno.exit(1);
  }

  // 2. Fund all derived pubkeys via Friendbot (delegates to setup-accounts.ts)
  console.log("\nFunding via Friendbot...\n");
  const pubkeys = entries.map((e) => e.publicKey!);
  const results = await fundAccounts(pubkeys);
  console.log(formatResults(results));

  const failed = results.filter((r) => r.status === "FAILED");
  if (failed.length > 0) {
    console.error(`\n${failed.length} account(s) failed to fund.`);
    Deno.exit(1);
  }

  console.log(`\n=== Funded ${results.length} extension account(s) ===\n`);
  console.log(
    "Both browser extensions can now deposit XLM into the privacy channel.",
  );
  console.log(
    "Refresh chain state in each extension to pick up the new balance.\n",
  );
}

if (import.meta.main) {
  main();
}
