#!/usr/bin/env bash
set -euo pipefail

# fund-keys.sh — funds all derived role keys from the master secret.
#
# Two modes:
#   --friendbot  Use Friendbot (local-dev, testnet). Default.
#   --transfer   Transfer XLM from the master account to derived accounts (mainnet).
#                Requires the master account to already be funded.
#
# Usage:
#   ./fund-keys.sh                                   # Friendbot mode (default)
#   ./fund-keys.sh --friendbot                       # Friendbot mode (explicit)
#   MASTER_SECRET=S... ./fund-keys.sh --transfer --amount 100  # Mainnet mode

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DENO_BIN="${DENO_BIN:-$(command -v deno 2>/dev/null || echo "$HOME/.deno/bin/deno")}"

MODE="friendbot"
AMOUNT="10000"  # XLM, only used in transfer mode
FRIENDBOT_URL="${FRIENDBOT_URL:-https://friendbot.stellar.org}"
RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --friendbot) MODE="friendbot"; shift ;;
    --transfer) MODE="transfer"; shift ;;
    --amount) AMOUNT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

export MASTER_SECRET="${MASTER_SECRET:-}"
export FUND_MODE="$MODE"
export FUND_AMOUNT="$AMOUNT"
export FRIENDBOT_URL
export STELLAR_RPC_URL="$RPC_URL"
export STELLAR_NETWORK_PASSPHRASE="$NETWORK_PASSPHRASE"

cd "$SCRIPT_DIR"

"$DENO_BIN" run --allow-all - << 'DENO_SCRIPT'
import { Keypair, Networks, TransactionBuilder, Operation, Asset } from "stellar-sdk";
import { masterSeedFromSecret, deriveKeypair, ROLES, LOCAL_DEV_MASTER_SECRET } from "./lib/master-seed.ts";

const masterSecret = Deno.env.get("MASTER_SECRET") || LOCAL_DEV_MASTER_SECRET;
const mode = Deno.env.get("FUND_MODE") || "friendbot";
const amount = Deno.env.get("FUND_AMOUNT") || "10000";
const friendbotUrl = Deno.env.get("FRIENDBOT_URL")!;
const rpcUrl = Deno.env.get("STELLAR_RPC_URL")!;
const networkPassphrase = Deno.env.get("STELLAR_NETWORK_PASSPHRASE")!;

const masterSeed = await masterSeedFromSecret(masterSecret);

console.log("\n=== Fund Keys ===\n");
console.log(`  Mode:    ${mode}`);
console.log(`  Master:  ${Keypair.fromSecret(masterSecret).publicKey()}`);

const roles = Object.entries(ROLES);
const keypairs: Array<{ role: string; kp: Keypair }> = [];

for (const [key, role] of roles) {
  const kp = await deriveKeypair(masterSeed, role, 0);
  keypairs.push({ role: key, kp });
  console.log(`  ${key.padEnd(12)} ${kp.publicKey()}`);
}

if (mode === "friendbot") {
  console.log(`\n  Funding via Friendbot (${friendbotUrl})...\n`);
  for (const { role, kp } of keypairs) {
    const res = await fetch(`${friendbotUrl}?addr=${kp.publicKey()}`);
    if (res.ok || res.status === 400) {
      console.log(`  ✓ ${role.padEnd(12)} funded`);
    } else {
      console.log(`  ✗ ${role.padEnd(12)} failed: ${res.status}`);
    }
  }
} else if (mode === "transfer") {
  console.log(`\n  Funding via transfer (${amount} XLM each)...\n`);
  const masterKeypair = Keypair.fromSecret(masterSecret);

  // Load master account
  const accountRes = await fetch(`${rpcUrl}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getAccount",
      params: { account: masterKeypair.publicKey() },
    }),
  });
  const accountData = await accountRes.json();

  if (accountData.error) {
    console.error(`  Master account not found or RPC error: ${JSON.stringify(accountData.error)}`);
    Deno.exit(1);
  }

  // For each derived key, create+fund or just fund
  for (const { role, kp } of keypairs) {
    try {
      // Check if account exists
      const checkRes = await fetch(`${rpcUrl}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "getAccount",
          params: { account: kp.publicKey() },
        }),
      });
      const checkData = await checkRes.json();
      const exists = !checkData.error;

      if (exists) {
        console.log(`  ✓ ${role.padEnd(12)} already exists`);
      } else {
        console.log(`  → ${role.padEnd(12)} needs create_account (${amount} XLM)`);
      }
    } catch (err) {
      console.log(`  ✗ ${role.padEnd(12)} error: ${err}`);
    }
  }

  console.log("\n  Note: transfer mode transaction building not yet implemented.");
  console.log("  Use the Stellar CLI or Laboratory to send XLM manually for now.");
}

console.log("\n=== Done ===\n");
DENO_SCRIPT
