/**
 * CI Setup phase — runs inside docker-compose.
 * Deploys contracts, registers provider, writes config for the provider
 * and test-runner containers via the shared /config volume.
 */
import { Keypair } from "stellar-sdk";
import { createServer } from "./soroban.ts";
import {
  deployChannelAuth,
  deployPrivacyChannel,
  getOrDeployNativeSac,
  uploadWasm,
} from "./deploy.ts";
import { addProvider } from "./admin.ts";
import { extractEvents, verifyEvent } from "./events.ts";

const RPC_URL = Deno.env.get("STELLAR_RPC_URL")!;
const FRIENDBOT_URL = Deno.env.get("FRIENDBOT_URL")!;
const NETWORK_PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ??
  "Standalone Network ; February 2017";
const CONFIG_DIR = Deno.env.get("CONFIG_DIR") ?? "/config";

async function fundAccount(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!res.ok) {
    throw new Error(
      `Friendbot failed for ${publicKey}: ${res.status} ${await res.text()}`,
    );
  }
}

async function waitForFriendbot(): Promise<void> {
  console.log("[ci-setup] Waiting for Friendbot...");
  for (let i = 0; i < 180; i++) {
    try {
      const res = await fetch(
        `${FRIENDBOT_URL}?addr=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF`,
      );
      if (res.status === 200 || res.status === 400) {
        console.log("  Friendbot is ready.");
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Friendbot did not become ready after 180s");
}

async function main() {
  console.log("[ci-setup] Starting...");
  const server = createServer(RPC_URL);

  await waitForFriendbot();

  const admin = Keypair.random();
  const provider = Keypair.random();
  const treasury = Keypair.random();
  console.log(`  Admin:    ${admin.publicKey()}`);
  console.log(`  Provider: ${provider.publicKey()}`);
  console.log(`  Treasury: ${treasury.publicKey()}`);

  console.log("[ci-setup] Funding accounts...");
  await fundAccount(admin.publicKey());
  await fundAccount(treasury.publicKey());

  // Step 1: Deploy Council (Channel Auth)
  console.log("[ci-setup] Deploying Channel Auth...");
  const channelAuthWasm = await Deno.readFile("/wasms/channel_auth_contract.wasm");
  const channelAuthHash = await uploadWasm(
    server, admin, NETWORK_PASSPHRASE, channelAuthWasm,
  );
  const { contractId: channelAuthId, txResponse: authDeployTx } =
    await deployChannelAuth(server, admin, NETWORK_PASSPHRASE, channelAuthHash);

  const deployEvents = extractEvents(authDeployTx);
  const initResult = verifyEvent(deployEvents, "contract_initialized", true);
  if (initResult.found) console.log("  ContractInitialized event verified");

  // Step 2: Deploy Channel (Privacy Channel)
  console.log("[ci-setup] Deploying SAC + Privacy Channel...");
  const assetContractId = await getOrDeployNativeSac(
    server, admin, NETWORK_PASSPHRASE,
  );

  const privacyChannelWasm = await Deno.readFile("/wasms/privacy_channel.wasm");
  const privacyChannelHash = await uploadWasm(
    server, admin, NETWORK_PASSPHRASE, privacyChannelWasm,
  );
  const channelContractId = await deployPrivacyChannel(
    server, admin, NETWORK_PASSPHRASE,
    privacyChannelHash, channelAuthId, assetContractId,
  );

  // Step 3: Register provider
  console.log("[ci-setup] Registering provider...");
  const addTx = await addProvider(
    server, admin, NETWORK_PASSPHRASE, channelAuthId, provider.publicKey(),
  );
  const addEvents = extractEvents(addTx);
  const addResult = verifyEvent(addEvents, "provider_added", true);
  if (addResult.found) console.log("  ProviderAdded event verified");

  // Write provider.env (read by provider-entrypoint.sh)
  const providerEnv = `PORT=3000
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

  // Write contracts.env (read by test-runner)
  const contractsEnv = `CHANNEL_CONTRACT_ID=${channelContractId}
CHANNEL_AUTH_ID=${channelAuthId}
CHANNEL_ASSET_CONTRACT_ID=${assetContractId}
PROVIDER_PK=${provider.publicKey()}
PROVIDER_SK=${provider.secret()}
TREASURY_PK=${treasury.publicKey()}
ADMIN_SK=${admin.secret()}
`;
  await Deno.writeTextFile(`${CONFIG_DIR}/contracts.env`, contractsEnv);

  console.log(`[ci-setup] Config written to ${CONFIG_DIR}/`);
  console.log("[ci-setup] Done.");
}

main().catch((err) => {
  console.error("[ci-setup] FAILED:", err);
  Deno.exit(1);
});
