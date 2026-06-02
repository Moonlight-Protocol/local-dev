/**
 * Direct PostgreSQL helpers for the playwright full-flow setup.
 *
 * The test-runner container runs in Node — there's no psql binary inside it.
 * The original `execSync("psql …")` cleanup silently failed with
 * "DB cleanup skipped (psql not available)" and stale rows leaked across
 * runs, which had been hidden by loose UI assertions. Direct PG over node-pg
 * fixes that without infra changes to the container image.
 *
 * Both DBs (provider_platform_db, pay_platform_db) live on the same PG
 * instance (host `db` inside the test compose network, `localhost:5442` from
 * the dev host). The CLEANUP_DATABASE_URL / DISCOVERY_DATABASE_URL env vars
 * default to the in-container DSN; override when running playwright off-host.
 */
import { Client } from "pg";

const DEFAULT_DSN_IN_CONTAINER = "postgresql://admin:devpass@db:5432";

function resolveDsn(dbName: string): string {
  const explicit = process.env[`${dbName.toUpperCase()}_URL`];
  if (explicit) return explicit;
  const base = process.env.PG_BASE_URL || DEFAULT_DSN_IN_CONTAINER;
  return `${base}/${dbName}`;
}

/**
 * Truncate stale councils + pay_accounts + council_pps so deterministic
 * playwright keys don't accumulate ghost PPs from prior runs.
 */
export async function cleanupPayPlatformDb(): Promise<void> {
  const client = new Client({ connectionString: resolveDsn("pay_platform_db") });
  await client.connect();
  try {
    await client.query(
      "TRUNCATE councils, pay_accounts, council_pps CASCADE",
    );
  } finally {
    await client.end();
  }
}

/**
 * Returns the active PP's `payment_providers.public_key` from
 * provider-platform's DB. The playwright provider-creation flow registers
 * exactly one PP per run; this lets later steps reference the actual
 * derived PP keypair instead of the operator wallet's pubkey (which is what
 * the original test mistakenly used).
 */
export async function fetchActivePpPublicKey(): Promise<string> {
  const client = new Client({
    connectionString: resolveDsn("provider_platform_db"),
  });
  await client.connect();
  try {
    const res = await client.query<{ public_key: string }>(
      "SELECT public_key FROM payment_providers WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1",
    );
    if (res.rows.length === 0) {
      throw new Error("No active PP found in provider_platform_db");
    }
    return res.rows[0].public_key;
  } finally {
    await client.end();
  }
}

/**
 * Returns the sum of completed inbound transaction amounts (stroops) for a
 * pay-platform wallet. Used by Step 13 to assert the payment actually
 * settled, not just that a UI element became visible.
 */
export async function fetchCompletedInboundStroops(
  walletPubkey: string,
): Promise<bigint> {
  const client = new Client({
    connectionString: resolveDsn("pay_platform_db"),
  });
  await client.connect();
  try {
    const res = await client.query<{ total: string | null }>(
      "SELECT COALESCE(SUM(amount_stroops), 0)::text AS total FROM transactions WHERE wallet_public_key = $1 AND direction = 'IN' AND status = 'COMPLETED'",
      [walletPubkey],
    );
    return BigInt(res.rows[0]?.total ?? "0");
  } finally {
    await client.end();
  }
}

/**
 * Returns whether a pay_accounts row exists for the wallet. Used to assert
 * the DELETE /account/me endpoint hard-removed the row.
 */
export async function payAccountExists(walletPubkey: string): Promise<boolean> {
  const client = new Client({
    connectionString: resolveDsn("pay_platform_db"),
  });
  await client.connect();
  try {
    const res = await client.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pay_accounts WHERE wallet_public_key = $1) AS exists",
      [walletPubkey],
    );
    return Boolean(res.rows[0]?.exists);
  } finally {
    await client.end();
  }
}

/**
 * Returns the encrypted_delegation_key column for the wallet, or null if
 * the row exists but the key isn't set, or undefined if no row.
 */
export async function fetchEncryptedDelegationKey(
  walletPubkey: string,
): Promise<string | null | undefined> {
  const client = new Client({
    connectionString: resolveDsn("pay_platform_db"),
  });
  await client.connect();
  try {
    const res = await client.query<{ encrypted_delegation_key: string | null }>(
      "SELECT encrypted_delegation_key FROM pay_accounts WHERE wallet_public_key = $1",
      [walletPubkey],
    );
    if (res.rows.length === 0) return undefined;
    return res.rows[0].encrypted_delegation_key;
  } finally {
    await client.end();
  }
}
