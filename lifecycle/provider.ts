/**
 * Manages the full infrastructure for the lifecycle test:
 * - Stellar quickstart node (with --limits unlimited for event parity with CI)
 * - PostgreSQL for the provider-platform
 * - Provider-platform process (from source)
 *
 * In CI, docker-compose manages all of this instead (see docker-compose.yml).
 */

const STELLAR_CONTAINER = "lifecycle-e2e-stellar";
const STELLAR_PORT = 8028;
const PG_CONTAINER = "lifecycle-e2e-db";
const PG_PORT = 5452;
const PG_DB = "lifecycle_e2e_db";
const PG_USER = "admin";
const PG_PASS = "devpass";
const PROVIDER_PORT = 3030;

const NETWORK_PASSPHRASE = "Standalone Network ; February 2017";

export interface Infrastructure {
  rpcUrl: string;
  friendbotUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  providerUrl: string;
  stop: () => Promise<void>;
}

export interface InfrastructureOptions {
  providerPlatformPath: string;
  channelContractId: string;
  channelAuthId: string;
  assetContractId: string;
  providerSecretKey: string;
  treasuryPublicKey: string;
  treasurySecretKey: string;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Start the Stellar node and wait for Friendbot.
 * Call this before deploying contracts.
 */
export async function startStellar(): Promise<{
  rpcUrl: string;
  friendbotUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  stopStellar: () => Promise<void>;
}> {
  console.log("  Starting Stellar node...");
  await ensureContainer(STELLAR_CONTAINER, [
    "run", "-d", "--name", STELLAR_CONTAINER,
    "-p", `${STELLAR_PORT}:8000`,
    "stellar/quickstart:latest",
    "--local", "--limits", "unlimited",
  ]);

  // Wait for RPC health
  const rpcUrl = `http://localhost:${STELLAR_PORT}/soroban/rpc`;
  console.log("  Waiting for Stellar RPC...");
  for (let i = 0; i < 180; i++) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "getHealth",
        }),
      });
      const data = await res.json();
      if (data.result?.status === "healthy") {
        console.log("  Stellar RPC healthy");
        break;
      }
    } catch { /* not ready */ }
    if (i === 179) throw new Error("Stellar RPC did not become healthy");
    await sleep(1000);
  }

  // Wait for Friendbot
  const friendbotUrl = `http://localhost:${STELLAR_PORT}/friendbot`;
  console.log("  Waiting for Friendbot...");
  for (let i = 0; i < 180; i++) {
    try {
      const res = await fetch(
        `${friendbotUrl}?addr=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF`,
      );
      if (res.status === 200 || res.status === 400) {
        console.log("  Friendbot ready");
        break;
      }
    } catch { /* not ready */ }
    if (i === 179) throw new Error("Friendbot did not become ready");
    await sleep(1000);
  }

  return {
    rpcUrl,
    friendbotUrl,
    horizonUrl: `http://localhost:${STELLAR_PORT}`,
    networkPassphrase: NETWORK_PASSPHRASE,
    stopStellar: () => removeContainer(STELLAR_CONTAINER),
  };
}

/**
 * Start PostgreSQL + provider-platform configured for the given contracts.
 * Call this after deploying contracts and registering the provider.
 */
export async function startProvider(
  opts: InfrastructureOptions & { rpcUrl: string },
): Promise<{ providerUrl: string; stopProvider: () => Promise<void> }> {
  const { providerPlatformPath, rpcUrl } = opts;
  const databaseUrl =
    `postgresql://${PG_USER}:${PG_PASS}@localhost:${PG_PORT}/${PG_DB}`;

  // PostgreSQL
  console.log("  Starting PostgreSQL...");
  await ensureContainer(PG_CONTAINER, [
    "run", "-d", "--name", PG_CONTAINER,
    "-p", `${PG_PORT}:5432`,
    "-e", `POSTGRES_USER=${PG_USER}`,
    "-e", `POSTGRES_PASSWORD=${PG_PASS}`,
    "-e", `POSTGRES_DB=${PG_DB}`,
    "postgres:18",
  ]);
  console.log("  Waiting for PostgreSQL...");
  for (let i = 0; i < 30; i++) {
    const ready = await docker([
      "exec", PG_CONTAINER, "pg_isready", "-U", PG_USER,
    ]);
    if (ready.success) { console.log("  PostgreSQL ready"); break; }
    if (i === 29) throw new Error("PostgreSQL did not become ready");
    await sleep(1000);
  }

  // Write .env (backup existing)
  const envBackup = await backupAndWriteEnv(opts, providerPlatformPath, databaseUrl, rpcUrl);

  // Install deps + migrations
  await run("deno", ["install"], providerPlatformPath, "install deps");
  console.log("  Running migrations...");
  await run(
    "deno",
    ["-A", "--node-modules-dir", "npm:drizzle-kit", "migrate"],
    providerPlatformPath,
    "migrations",
  );

  // Start provider process
  console.log("  Starting provider-platform...");
  const child = new Deno.Command("deno", {
    args: ["run", "--allow-all", "--unstable-kv", "src/main.ts"],
    cwd: providerPlatformPath,
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const logPath = new URL("./provider.log", import.meta.url).pathname;
  const logFile = await Deno.open(logPath, {
    write: true, create: true, truncate: true,
  });
  const logWriter = logFile.writable.getWriter();
  child.stdout
    .pipeTo(new WritableStream({ write(chunk) { return logWriter.write(chunk); } }))
    .catch(() => {});
  child.stderr
    .pipeTo(new WritableStream({ write(chunk) { return logWriter.write(chunk); } }))
    .catch(() => {});

  const providerUrl = `http://localhost:${PROVIDER_PORT}`;
  await waitForReady(providerUrl);
  console.log(`  Provider ready at ${providerUrl} (log: ${logPath})`);

  return {
    providerUrl,
    async stopProvider() {
      try { child.kill("SIGTERM"); } catch { /* dead */ }
      try { await child.status; } catch { /* ignore */ }
      try { logWriter.close(); } catch { /* ignore */ }
      await restoreEnv(providerPlatformPath, envBackup);
      await removeContainer(PG_CONTAINER);
    },
  };
}

// ── Docker helpers ───────────────────────────────────────────────

async function ensureContainer(
  name: string,
  runArgs: string[],
): Promise<void> {
  const check = await docker([
    "ps", "--filter", `name=^${name}$`, "--format", "{{.Names}}",
  ]);
  if (decode(check.stdout).trim() === name) {
    console.log(`  ${name} already running`);
    return;
  }
  await docker(["rm", "-f", name]);
  const result = await docker(runArgs);
  if (!result.success) {
    throw new Error(`Failed to start ${name}: ${decode(result.stderr)}`);
  }
}

async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "-f", name]);
}

async function docker(args: string[]): Promise<Deno.CommandOutput> {
  return new Deno.Command("docker", {
    args, stdout: "piped", stderr: "piped",
  }).output();
}

function decode(buf: Uint8Array): string {
  return new TextDecoder().decode(buf);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  label: string,
): Promise<void> {
  const result = await new Deno.Command(cmd, {
    args, cwd, stdout: "piped", stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(`${label} failed:\n${decode(result.stderr)}`);
  }
}

async function waitForReady(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(
        `${url}/api/v1/stellar/auth?account=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF`,
      );
      return;
    } catch { /* not ready */ }
    await sleep(1000);
  }
  throw new Error(`Provider not ready after ${timeoutMs}ms`);
}

// ── .env management ──────────────────────────────────────────────

async function backupAndWriteEnv(
  opts: InfrastructureOptions,
  providerPath: string,
  databaseUrl: string,
  rpcUrl: string,
): Promise<string | null> {
  const envPath = `${providerPath}/.env`;
  let backupPath: string | null = null;
  try {
    const existing = await Deno.readTextFile(envPath);
    backupPath = `${envPath}.lifecycle-backup`;
    await Deno.writeTextFile(backupPath, existing);
  } catch { /* no existing .env */ }

  const content = `# Generated by lifecycle E2E test — will be restored after test
PORT=${PROVIDER_PORT}
MODE=development
LOG_LEVEL=WARN
SERVICE_DOMAIN=localhost

DATABASE_URL=${databaseUrl}

NETWORK=local
STELLAR_RPC_URL=${rpcUrl}
NETWORK_FEE=1000000000

SERVICE_AUTH_SECRET=lifecycle-test-auth-secret
SERVICE_FEE=100
CHALLENGE_TTL=900
SESSION_TTL=21600

MEMPOOL_SLOT_CAPACITY=100
MEMPOOL_EXPENSIVE_OP_WEIGHT=10
MEMPOOL_CHEAP_OP_WEIGHT=1
MEMPOOL_EXECUTOR_INTERVAL_MS=5000
MEMPOOL_VERIFIER_INTERVAL_MS=10000
MEMPOOL_TTL_CHECK_INTERVAL_MS=60000
MEMPOOL_MAX_RETRY_ATTEMPTS=3
BUNDLE_MAX_OPERATIONS=20

# Legacy env vars — kept for e2e test config loading, not read by platform
CHANNEL_CONTRACT_ID=${opts.channelContractId}
CHANNEL_AUTH_ID=${opts.channelAuthId}
PROVIDER_SK=${opts.providerSecretKey}
`;
  await Deno.writeTextFile(envPath, content);
  return backupPath;
}

async function restoreEnv(
  providerPath: string,
  backupPath: string | null,
): Promise<void> {
  const envPath = `${providerPath}/.env`;
  if (backupPath) {
    try {
      const content = await Deno.readTextFile(backupPath);
      await Deno.writeTextFile(envPath, content);
      await Deno.remove(backupPath);
    } catch { /* best effort */ }
  } else {
    try { await Deno.remove(envPath); } catch { /* ignore */ }
  }
}
