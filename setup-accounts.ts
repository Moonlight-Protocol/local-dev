/**
 * Local Dev — Account Funder
 *
 * Generic Friendbot funder. Takes Stellar public keys as CLI args (or as
 * a `pubkeys` array argument when imported as a module) and fires Friendbot
 * funding requests in parallel.
 *
 * Idempotent: Friendbot returns 400 "createAccountAlreadyExist" when an
 * account is already funded — both 200 and 400 are treated as success.
 *
 * Usage as a CLI:
 *   ./setup-accounts.sh GABC... GDEF... GHIJ...
 *   deno run --allow-all setup-accounts.ts GABC... GDEF...
 *
 * Usage as a module:
 *   import { fundAccounts } from "./setup-accounts.ts";
 *   const results = await fundAccounts(["GABC...", "GDEF..."]);
 *
 * Env overrides:
 *   FRIENDBOT_URL    default http://localhost:8000/friendbot
 */
import { StrKey } from "npm:@stellar/stellar-sdk@14.2.0";

const FRIENDBOT_URL = Deno.env.get("FRIENDBOT_URL") ?? "http://localhost:8000/friendbot";

export interface FundResult {
  publicKey: string;
  status: "FUNDED" | "ALREADY_FUNDED" | "FAILED";
  error?: string;
}

/**
 * Fund a single Stellar account via Friendbot.
 * Treats both 200 (newly funded) and 400 with `createAccountAlreadyExist`
 * (already funded) as success.
 */
async function fundOne(publicKey: string): Promise<FundResult> {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    return {
      publicKey,
      status: "FAILED",
      error: "Not a valid Stellar public key (G...)",
    };
  }

  try {
    const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
    if (res.status === 200) {
      return { publicKey, status: "FUNDED" };
    }
    if (res.status === 400) {
      const body = await res.text();
      // Friendbot returns several different "already funded" wordings depending
      // on the network/version. Match all of them to be idempotent across
      // local Stellar quickstart and testnet.
      const lower = body.toLowerCase();
      if (
        lower.includes("already funded") ||
        lower.includes("already_exist") ||
        lower.includes("op_already_exists")
      ) {
        return { publicKey, status: "ALREADY_FUNDED" };
      }
      return { publicKey, status: "FAILED", error: `400: ${body.slice(0, 200)}` };
    }
    const body = await res.text();
    return {
      publicKey,
      status: "FAILED",
      error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      publicKey,
      status: "FAILED",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fund multiple Stellar accounts via Friendbot in parallel.
 * Returns one result per public key in the same order.
 */
export async function fundAccounts(pubkeys: string[]): Promise<FundResult[]> {
  return await Promise.all(pubkeys.map((pk) => fundOne(pk)));
}

/**
 * Format a list of fund results as a human-readable summary.
 */
export function formatResults(results: FundResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const tag = r.status === "FUNDED"
      ? "  ✓ funded         "
      : r.status === "ALREADY_FUNDED"
      ? "  ✓ already funded "
      : "  ✗ FAILED         ";
    lines.push(`${tag} ${r.publicKey}${r.error ? `  — ${r.error}` : ""}`);
  }
  return lines.join("\n");
}

async function main() {
  const args = Deno.args;
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: setup-accounts.sh <pubkey> [<pubkey> ...]");
    console.log("");
    console.log("Funds one or more Stellar accounts via Friendbot. Idempotent.");
    console.log("");
    console.log("Env:");
    console.log(`  FRIENDBOT_URL  default ${FRIENDBOT_URL}`);
    Deno.exit(args.length === 0 ? 1 : 0);
  }

  console.log("\n=== local-dev — Account Funder ===\n");
  console.log(`  Friendbot: ${FRIENDBOT_URL}`);
  console.log(`  Accounts:  ${args.length}\n`);

  const results = await fundAccounts(args);
  console.log(formatResults(results));

  const failed = results.filter((r) => r.status === "FAILED");
  if (failed.length > 0) {
    console.error(`\n${failed.length} account(s) failed to fund.`);
    Deno.exit(1);
  }
  console.log(`\n=== Funded ${results.length} account(s) ===\n`);
}

if (import.meta.main) {
  main();
}
