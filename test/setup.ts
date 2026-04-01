/**
 * Test setup — runs inside docker-compose.test.yml.
 *
 * Extends the lifecycle ci-setup to also produce council-platform config,
 * so both provider and council can start from the shared /config volume.
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

async function main() {
  console.log("[setup] Starting...");
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

  // Register provider
  console.log("[setup] Registering provider...");
  const addTx = await addProvider(server, admin, NETWORK_PASSPHRASE, channelAuthId, provider.publicKey());
  const addEvents = extractEvents(addTx);
  const addResult = verifyEvent(addEvents, "provider_added", true);
  if (addResult.found) console.log("  ProviderAdded event verified");

  // Write provider.env
  const providerEnv = `PORT=${PROVIDER_INTERNAL_PORT}
MODE=development
LOG_LEVEL=TRACE
SERVICE_DOMAIN=localhost

STELLAR_RPC_URL=${RPC_URL}
NETWORK=local
NETWORK_FEE=1000000000
CHANNEL_CONTRACT_ID=${channelContractId}
CHANNEL_AUTH_ID=${channelAuthId}
CHANNEL_ASSET_CODE=XLM
CHANNEL_ASSET_CONTRACT_ID=${assetContractId}

PROVIDER_SK=${provider.secret()}
OPEX_PUBLIC=${treasury.publicKey()}
OPEX_SECRET=${treasury.secret()}

SERVICE_AUTH_SECRET=
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

SERVICE_AUTH_SECRET=test-auth-secret
CHALLENGE_TTL=900
SESSION_TTL=21600
`;
  await Deno.writeTextFile(`${CONFIG_DIR}/council.env`, councilEnv);

  // Write contracts.env (for test runners)
  const contractsEnv = `CHANNEL_CONTRACT_ID=${channelContractId}
CHANNEL_AUTH_ID=${channelAuthId}
CHANNEL_ASSET_CONTRACT_ID=${assetContractId}
PROVIDER_PK=${provider.publicKey()}
PROVIDER_SK=${provider.secret()}
TREASURY_PK=${treasury.publicKey()}
ADMIN_SK=${admin.secret()}
COUNCIL_SK=${admin.secret()}
COUNCIL_PK=${admin.publicKey()}
COUNCIL_URL=http://council:${COUNCIL_INTERNAL_PORT}
`;
  await Deno.writeTextFile(`${CONFIG_DIR}/contracts.env`, contractsEnv);

  console.log(`[setup] Config written to ${CONFIG_DIR}/`);
  console.log("[setup] Done.");
}

main().catch((err) => {
  console.error("[setup] FAILED:", err);
  Deno.exit(1);
});
