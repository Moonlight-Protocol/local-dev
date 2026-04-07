/**
 * CI Setup phase — runs inside docker-compose.
 *
 * Deploys contracts and writes config for the provider, council, and
 * test-runner containers via the shared /config volume.
 *
 * Wallets:
 *   - admin: deploys contracts AND acts as council admin
 *   - pp_operator: registers a PP via the dashboard API and joins the council
 *
 * NOTE: This setup does NOT call on-chain add_provider. The provider is
 * added on-chain by the test runner (acting as the council admin) AFTER
 * the PP submits a join request, mirroring the production flow.
 */
import { Keypair } from "stellar-sdk";
import { createServer } from "./soroban.ts";
import {
  deployChannelAuth,
  deployPrivacyChannel,
  getOrDeployNativeSac,
  uploadWasm,
} from "./deploy.ts";
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

  // Two distinct identities, mirroring production:
  //   admin       — council admin, also the on-chain contract deployer
  //   ppOperator  — PP wallet that registers and joins councils via the dashboard
  const admin = Keypair.random();
  const ppOperator = Keypair.random();
  console.log(`  Admin:       ${admin.publicKey()}`);
  console.log(`  PP Operator: ${ppOperator.publicKey()}`);

  console.log("[ci-setup] Funding accounts...");
  await fundAccount(admin.publicKey());
  await fundAccount(ppOperator.publicKey());

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

  // Write provider.env (boot-only env vars for provider-platform).
  // PPs and council memberships are created at runtime via the dashboard API,
  // not seeded — lifecycle simulates the real user-driven flow.
  const providerEnv = `PORT=3000
MODE=development
LOG_LEVEL=TRACE
SERVICE_DOMAIN=localhost

STELLAR_RPC_URL=${RPC_URL}
NETWORK=local
NETWORK_FEE=1000000000

SERVICE_AUTH_SECRET=lifecycle-test-secret
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

  // Write contracts.env (test fixture file consumed by ci-test.ts).
  // Contains everything the test runner needs to act as both wallets.
  const contractsEnv = `CHANNEL_CONTRACT_ID=${channelContractId}
CHANNEL_AUTH_ID=${channelAuthId}
CHANNEL_ASSET_CONTRACT_ID=${assetContractId}
ADMIN_PK=${admin.publicKey()}
ADMIN_SK=${admin.secret()}
PP_OPERATOR_PK=${ppOperator.publicKey()}
PP_OPERATOR_SK=${ppOperator.secret()}
`;
  await Deno.writeTextFile(`${CONFIG_DIR}/contracts.env`, contractsEnv);

  console.log(`[ci-setup] Config written to ${CONFIG_DIR}/`);
  console.log("[ci-setup] Done.");
}

main().catch((err) => {
  console.error("[ci-setup] FAILED:", err);
  Deno.exit(1);
});
