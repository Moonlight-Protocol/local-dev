/**
 * Governance test setup — deploys contracts, writes config.
 *
 * Does NOT register a provider on-chain or seed the DB. The governance
 * test handles its own PP registration flow via the production APIs.
 */
import { Keypair } from "npm:@stellar/stellar-sdk@14.2.0";
import { createServer } from "./lib/soroban.ts";
import {
  deployChannelAuth,
  deployPrivacyChannel,
  getOrDeployNativeSac,
  uploadWasm,
} from "./lib/deploy.ts";
import { extractEvents, verifyEvent } from "./lib/events.ts";

const RPC_URL = Deno.env.get("STELLAR_RPC_URL")!;
const FRIENDBOT_URL = Deno.env.get("FRIENDBOT_URL")!;
const NETWORK_PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ??
  "Standalone Network ; February 2017";
const CONFIG_DIR = Deno.env.get("CONFIG_DIR") ?? "/config";
const WASM_DIR = Deno.env.get("WASM_DIR") ?? "/wasms";
const PROVIDER_INTERNAL_PORT = Deno.env.get("PROVIDER_INTERNAL_PORT") ?? "3000";
const COUNCIL_INTERNAL_PORT = Deno.env.get("COUNCIL_INTERNAL_PORT") ?? "8080";
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

async function main() {
  console.log("[setup-governance] Starting...");

  const server = createServer(RPC_URL);
  await waitForFriendbot();

  const admin = Keypair.random();
  const provider = Keypair.random();
  const treasury = Keypair.random();
  console.log(`  Admin:    ${admin.publicKey()}`);
  console.log(`  Provider: ${provider.publicKey()}`);
  console.log(`  Treasury: ${treasury.publicKey()}`);

  console.log("[setup-governance] Funding accounts...");
  await fundAccount(admin.publicKey());
  await fundAccount(provider.publicKey());
  await fundAccount(treasury.publicKey());

  console.log("[setup-governance] Deploying Channel Auth...");
  const channelAuthWasm = await Deno.readFile(`${WASM_DIR}/channel_auth_contract.wasm`);
  const channelAuthHash = await uploadWasm(server, admin, NETWORK_PASSPHRASE, channelAuthWasm);
  const { contractId: channelAuthId, txResponse: authDeployTx } =
    await deployChannelAuth(server, admin, NETWORK_PASSPHRASE, channelAuthHash);
  if (verifyEvent(extractEvents(authDeployTx), "contract_initialized", true).found) {
    console.log("  ContractInitialized event verified");
  }

  console.log("[setup-governance] Deploying SAC + Privacy Channel...");
  const assetContractId = await getOrDeployNativeSac(server, admin, NETWORK_PASSPHRASE);
  const privacyChannelWasm = await Deno.readFile(`${WASM_DIR}/privacy_channel.wasm`);
  const privacyChannelHash = await uploadWasm(server, admin, NETWORK_PASSPHRASE, privacyChannelWasm);
  const channelContractId = await deployPrivacyChannel(
    server, admin, NETWORK_PASSPHRASE,
    privacyChannelHash, channelAuthId, assetContractId,
  );

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
BUNDLE_MAX_OPERATIONS=20

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
CHANNEL_AUTH_ID=${channelAuthId}

COUNCIL_SK=${admin.secret()}
OPEX_PUBLIC=${treasury.publicKey()}
OPEX_SECRET=${treasury.secret()}

SERVICE_AUTH_SECRET=${SERVICE_AUTH_SECRET}
CHALLENGE_TTL=900
SESSION_TTL=21600
`;
  await Deno.writeTextFile(`${CONFIG_DIR}/council.env`, councilEnv);

  const contractsEnv = `# Contract addresses (deployed by setup)
E2E_CHANNEL_CONTRACT_ID=${channelContractId}
E2E_CHANNEL_AUTH_ID=${channelAuthId}
E2E_CHANNEL_ASSET_CONTRACT_ID=${assetContractId}

# Provider keypair
E2E_PROVIDER_PK=${provider.publicKey()}
E2E_PROVIDER_SK=${provider.secret()}

# Admin/Council keypair
E2E_ADMIN_SK=${admin.secret()}
E2E_COUNCIL_SK=${admin.secret()}
E2E_COUNCIL_PK=${admin.publicKey()}
E2E_COUNCIL_URL=http://council:${COUNCIL_INTERNAL_PORT}
`;
  await Deno.writeTextFile(`${CONFIG_DIR}/contracts.env`, contractsEnv);

  console.log(`[setup-governance] Config written to ${CONFIG_DIR}/`);
  console.log("[setup-governance] Done.");
}

main().catch((err) => {
  console.error("[setup-governance] FAILED:", err);
  Deno.exit(1);
});
