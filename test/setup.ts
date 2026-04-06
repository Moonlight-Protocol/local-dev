/**
 * Test setup — runs inside docker-compose.test.yml.
 *
 * Deploys contracts, registers the provider on-chain, writes config for
 * the provider and council platforms, and seeds the provider-platform DB
 * with the PP record and council membership.
 */
import { Keypair } from "stellar-sdk";
import { createServer } from "./lifecycle/soroban.ts";
import {
  deployChannelAuth,
  deployPrivacyChannel,
  getOrDeployNativeSac,
  uploadWasm,
} from "./lifecycle/deploy.ts";
import { addProvider } from "./lifecycle/admin.ts";
import { extractEvents, verifyEvent } from "./lifecycle/events.ts";

const RPC_URL = Deno.env.get("STELLAR_RPC_URL")!;
const FRIENDBOT_URL = Deno.env.get("FRIENDBOT_URL")!;
const NETWORK_PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ??
  "Standalone Network ; February 2017";
const CONFIG_DIR = Deno.env.get("CONFIG_DIR") ?? "/config";
const WASM_DIR = Deno.env.get("WASM_DIR") ?? "/wasms";

const PROVIDER_INTERNAL_PORT = Deno.env.get("PROVIDER_INTERNAL_PORT") ?? "3000";
const COUNCIL_INTERNAL_PORT = Deno.env.get("COUNCIL_INTERNAL_PORT") ?? "8080";
const TEST_SUITE = Deno.env.get("TEST_SUITE") ?? "e2e";

const SERVICE_AUTH_SECRET = "test-auth-secret";

async function fundAccount(publicKey: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
      if (res.ok || res.status === 400) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Friendbot failed for ${publicKey} after 10 attempts`);
}

async function waitForFriendbot(): Promise<void> {
  console.log("[setup] Waiting for Friendbot...");
  for (let i = 0; i < 180; i++) {
    try {
      const res = await fetch(
        `${FRIENDBOT_URL}?addr=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF`,
      );
      if (res.status === 200 || res.status === 400) {
        console.log(`  Friendbot is ready (${i}s).`);
        return;
      }
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Friendbot did not become ready after 180s");
}

async function waitForDb(): Promise<void> {
  console.log("[setup] Waiting for PostgreSQL...");
  const postgres = (await import("npm:postgres")).default;
  for (let i = 0; i < 30; i++) {
    try {
      const sql = postgres("postgresql://admin:devpass@db:5432/provider_platform_db");
      await sql`SELECT 1`;
      await sql.end();
      console.log("  PostgreSQL is ready.");
      return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("PostgreSQL did not become ready after 30s");
}

async function main() {
  console.log(`[setup] Starting (suite: ${TEST_SUITE})...`);

  // Lifecycle: the test-runner handles all deployment and seeding.
  // Setup only writes minimal platform env files so services can start.
  if (TEST_SUITE === "lifecycle") {
    console.log("[setup] Lifecycle suite — writing minimal config only.");
    const providerEnv = `PORT=${PROVIDER_INTERNAL_PORT}
MODE=development
LOG_LEVEL=TRACE
SERVICE_DOMAIN=localhost

STELLAR_RPC_URL=${RPC_URL}
NETWORK=local
NETWORK_FEE=1000000000

SERVICE_AUTH_SECRET=${SERVICE_AUTH_SECRET}
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

EVENT_WATCHER_INTERVAL_MS=5000
`;
    await Deno.writeTextFile(`${CONFIG_DIR}/provider.env`, providerEnv);

    const councilEnv = `PORT=${COUNCIL_INTERNAL_PORT}
MODE=development
LOG_LEVEL=TRACE
SERVICE_DOMAIN=localhost

STELLAR_RPC_URL=${RPC_URL}
NETWORK=local
NETWORK_FEE=1000000000
CHANNEL_AUTH_ID=CCSRQA6OD5OX2VSEIKRZY5R75TLO55QB4RUUZISZYKWCDBC4BXC6XY37
COUNCIL_SK=SCTQUHSGRWMHZZ7XNTQZJZYZTHLBJFUQVRHYVH4N7GJPVXZQ4OMI5IEQ
OPEX_PUBLIC=GCCMSSJP2GIK4WEQIG3KW253PVRKNPJPHOJVU2IDSCUIP5IRIGTBBWKG
OPEX_SECRET=SCTQUHSGRWMHZZ7XNTQZJZYZTHLBJFUQVRHYVH4N7GJPVXZQ4OMI5IEQ

SERVICE_AUTH_SECRET=${SERVICE_AUTH_SECRET}
CHALLENGE_TTL=900
SESSION_TTL=21600
`;
    await Deno.writeTextFile(`${CONFIG_DIR}/council.env`, councilEnv);
    console.log(`[setup] Config written to ${CONFIG_DIR}/`);
    console.log("[setup] Done.");
    return;
  }

  const server = createServer(RPC_URL);

  await waitForFriendbot();

  // Generate accounts
  const admin = Keypair.random();
  const provider = Keypair.random();
  const treasury = Keypair.random();
  console.log(`  Admin:    ${admin.publicKey()}`);
  console.log(`  Provider: ${provider.publicKey()}`);
  console.log(`  Treasury: ${treasury.publicKey()}`);

  console.log("[setup] Funding accounts...");
  await fundAccount(admin.publicKey());
  await fundAccount(provider.publicKey());
  await fundAccount(treasury.publicKey());

  // Deploy contracts
  console.log("[setup] Deploying Channel Auth...");
  const channelAuthWasm = await Deno.readFile(`${WASM_DIR}/channel_auth_contract.wasm`);
  const channelAuthHash = await uploadWasm(server, admin, NETWORK_PASSPHRASE, channelAuthWasm);
  const { contractId: channelAuthId, txResponse: authDeployTx } =
    await deployChannelAuth(server, admin, NETWORK_PASSPHRASE, channelAuthHash);

  const deployEvents = extractEvents(authDeployTx);
  const initResult = verifyEvent(deployEvents, "contract_initialized", true);
  if (initResult.found) console.log("  ContractInitialized event verified");

  console.log("[setup] Deploying SAC + Privacy Channel...");
  const assetContractId = await getOrDeployNativeSac(server, admin, NETWORK_PASSPHRASE);

  const privacyChannelWasm = await Deno.readFile(`${WASM_DIR}/privacy_channel.wasm`);
  const privacyChannelHash = await uploadWasm(server, admin, NETWORK_PASSPHRASE, privacyChannelWasm);
  const channelContractId = await deployPrivacyChannel(
    server, admin, NETWORK_PASSPHRASE,
    privacyChannelHash, channelAuthId, assetContractId,
  );

  // E2E/OTEL suites: register provider on-chain and seed the DB
  if (TEST_SUITE === "e2e" || TEST_SUITE === "otel") {
    console.log("[setup] Registering provider on-chain...");
    const addTx = await addProvider(server, admin, NETWORK_PASSPHRASE, channelAuthId, provider.publicKey());
    const addEvents = extractEvents(addTx);
    const addResult = verifyEvent(addEvents, "provider_added", true);
    if (addResult.found) console.log("  ProviderAdded event verified");

    console.log("[setup] Preparing DB seed...");
    const encryptSk = await createEncryptor(SERVICE_AUTH_SECRET);
    const encryptedSk = await encryptSk(provider.secret());

    const seedData = {
      provider: {
        id: crypto.randomUUID(),
        publicKey: provider.publicKey(),
        encryptedSk,
        derivationIndex: 0,
        label: "E2E Provider",
      },
      membership: {
        id: crypto.randomUUID(),
        channelAuthId,
        channelContractId,
        assetContractId,
        ppPublicKey: provider.publicKey(),
      },
    };
    await Deno.writeTextFile(`${CONFIG_DIR}/seed.json`, JSON.stringify(seedData));
    console.log("  Seed data written to /config/seed.json");
  } else {
    console.log(`[setup] Skipping on-chain registration and DB seed (suite: ${TEST_SUITE})`);
  }

  // Write provider.env
  const providerEnv = `PORT=${PROVIDER_INTERNAL_PORT}
MODE=development
LOG_LEVEL=TRACE
SERVICE_DOMAIN=localhost

STELLAR_RPC_URL=${RPC_URL}
NETWORK=local
NETWORK_FEE=1000000000

SERVICE_AUTH_SECRET=${SERVICE_AUTH_SECRET}
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

EVENT_WATCHER_INTERVAL_MS=5000
`;
  await Deno.writeTextFile(`${CONFIG_DIR}/provider.env`, providerEnv);

  // Write council.env
  const councilEnv = `PORT=${COUNCIL_INTERNAL_PORT}
MODE=development
LOG_LEVEL=TRACE
SERVICE_DOMAIN=localhost

STELLAR_RPC_URL=${RPC_URL}
NETWORK=local
NETWORK_FEE=1000000000
CHANNEL_AUTH_ID=${channelAuthId}

COUNCIL_SK=${admin.secret()}
OPEX_PUBLIC=${treasury.publicKey()}
OPEX_SECRET=${treasury.secret()}

SERVICE_AUTH_SECRET=${SERVICE_AUTH_SECRET}
CHALLENGE_TTL=900
SESSION_TTL=21600
`;
  await Deno.writeTextFile(`${CONFIG_DIR}/council.env`, councilEnv);

  // Write contracts.env (for test runners)
  const contractsEnv = `# Contract addresses (deployed by setup)
E2E_CHANNEL_CONTRACT_ID=${channelContractId}
E2E_CHANNEL_AUTH_ID=${channelAuthId}
E2E_CHANNEL_ASSET_CONTRACT_ID=${assetContractId}

# Provider keypair (registered on-chain by setup)
E2E_PROVIDER_PK=${provider.publicKey()}
E2E_PROVIDER_SK=${provider.secret()}

# Admin/Council keypair (for governance tests)
E2E_ADMIN_SK=${admin.secret()}
E2E_COUNCIL_SK=${admin.secret()}
E2E_COUNCIL_PK=${admin.publicKey()}
E2E_COUNCIL_URL=http://council:${COUNCIL_INTERNAL_PORT}
`;
  await Deno.writeTextFile(`${CONFIG_DIR}/contracts.env`, contractsEnv);

  console.log(`[setup] Config written to ${CONFIG_DIR}/`);
  console.log("[setup] Done.");
}

/**
 * Creates an AES-256-GCM encryptor matching the provider-platform's encrypt-sk.ts.
 * Replicated here so setup doesn't depend on the provider-platform source mount.
 */
async function createEncryptor(secret: string): Promise<(plaintext: string) => Promise<string>> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: new TextEncoder().encode("moonlight-pp-sk"), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

  return async (plaintext: string): Promise<string> => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
    );
    const combined = new Uint8Array(iv.length + encrypted.length);
    combined.set(iv);
    combined.set(encrypted, iv.length);
    return btoa(String.fromCharCode(...combined));
  };
}

main().catch((err) => {
  console.error("[setup] FAILED:", err);
  Deno.exit(1);
});
