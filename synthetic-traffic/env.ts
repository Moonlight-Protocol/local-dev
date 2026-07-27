/**
 * Engine configuration + the TESTNET-ONLY hard guard.
 *
 * The generator refuses to start unless the network passphrase is exactly the
 * local standalone network or the SDF testnet. There is no mainnet code path:
 * funding is friendbot-only (friendbot does not exist on mainnet) and the
 * passphrase allowlist below is checked before anything touches the network.
 */

export const LOCAL_PASSPHRASE = "Standalone Network ; February 2017";
export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

export interface EngineEnv {
  networkPassphrase: string;
  rpcUrl: string;
  friendbotUrl: string;
  horizonUrl: string;
  councilUrl: string;
  providerUrl: string;
  /** Master secret every synthetic key derives from. */
  masterSecret: string;
  /** Registry contract the CLI deploys through. */
  registryContractId: string;
  /** Key that signs registry operations — the registry's manager. Locally
   * that's the admin setup-registry.sh deployed with; on the shared testnet
   * registry it's the moonlight/ sub-registry manager key. */
  registrySourceSecret: string;
  /** Where compiled channel wasms live (fetch-wasms.sh). */
  wasmDir: string;
  stateFile: string;
  /** Virtual-time compression; 1 on testnet, large for local proving. */
  timeScale: number;
  /** Real-time engine tick. */
  tickMs: number;
  /** Cap on traffic actions executed per tick (catch-up bound). */
  maxActionsPerTick: number;
  /** Existing Discord webhook; empty = log-only (local proving). */
  discordWebhookUrl: string;
  /** Testnet only: account holding Circle-faucet USDC to hand entities.
   * Empty = testnet runs XLM-only (logged). Local runs self-issue instead. */
  usdcTreasurySecret: string;
  /** pay-platform base URL (aggregator driver). */
  payUrl: string;
  /** Wallet allowed on pay-platform admin routes (mirror seeding). Local
   * dev-mode skips the allowlist, so any funded wallet works there. */
  payAdminSecret: string;
  /** Aggregator (pay-platform) driver toggle; off until that driver lands. */
  aggregatorsEnabled: boolean;
  isLocal: boolean;
}

function req(name: string, fallback?: string): string {
  const v = Deno.env.get(name) ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required env var ${name}`);
  }
  return v;
}

export function loadEngineEnv(): EngineEnv {
  const networkPassphrase = req(
    "STELLAR_NETWORK_PASSPHRASE",
    LOCAL_PASSPHRASE,
  );

  if (networkPassphrase === MAINNET_PASSPHRASE) {
    throw new Error(
      "REFUSING TO START: mainnet passphrase detected. " +
        "synthetic-traffic is testnet/local only, by design, permanently.",
    );
  }
  if (
    networkPassphrase !== LOCAL_PASSPHRASE &&
    networkPassphrase !== TESTNET_PASSPHRASE
  ) {
    throw new Error(
      `REFUSING TO START: unknown network passphrase "${networkPassphrase}". ` +
        "Only the local standalone network and the SDF testnet are allowed.",
    );
  }

  const isLocal = networkPassphrase === LOCAL_PASSPHRASE;
  const rpcUrl = req(
    "STELLAR_RPC_URL",
    isLocal ? "http://localhost:8000/soroban/rpc" : undefined,
  );
  const friendbotUrl = req(
    "FRIENDBOT_URL",
    isLocal
      ? "http://localhost:8000/friendbot"
      : "https://friendbot.stellar.org",
  );

  return {
    networkPassphrase,
    rpcUrl,
    friendbotUrl,
    horizonUrl: req(
      "HORIZON_URL",
      isLocal ? "http://localhost:8000" : "https://horizon-testnet.stellar.org",
    ),
    councilUrl: req(
      "COUNCIL_URL",
      isLocal ? "http://localhost:3015" : undefined,
    ),
    providerUrl: req(
      "PROVIDER_URL",
      isLocal ? "http://localhost:3010" : undefined,
    ),
    masterSecret: req("SYNTRAF_MASTER_SECRET"),
    registryContractId: req("STELLAR_REGISTRY_CONTRACT_ID"),
    registrySourceSecret: req(
      "SYNTRAF_REGISTRY_SOURCE_SECRET",
      isLocal
        ? "SAQCGLJ2JISI67QGG457IBN2DY6YW5GGS2OMQU5KNLXB3TWVUIR2RD74"
        : undefined,
    ),
    wasmDir: req(
      "SYNTRAF_WASM_DIR",
      new URL("./wasms", import.meta.url).pathname,
    ),
    stateFile: req(
      "SYNTRAF_STATE_FILE",
      new URL("./.syntraf-state.json", import.meta.url).pathname,
    ),
    timeScale: Number(req("SYNTRAF_TIME_SCALE", "1")),
    tickMs: Number(req("SYNTRAF_TICK_MS", "300000")),
    maxActionsPerTick: Number(req("SYNTRAF_MAX_ACTIONS_PER_TICK", "40")),
    discordWebhookUrl: Deno.env.get("SYNTRAF_DISCORD_WEBHOOK_URL") ?? "",
    usdcTreasurySecret: Deno.env.get("SYNTRAF_USDC_TREASURY_SECRET") ?? "",
    payUrl: req("PAY_URL", isLocal ? "http://localhost:3025" : undefined),
    payAdminSecret: req(
      "SYNTRAF_PAY_ADMIN_SECRET",
      isLocal
        ? "SAQCGLJ2JISI67QGG457IBN2DY6YW5GGS2OMQU5KNLXB3TWVUIR2RD74"
        : undefined,
    ),
    aggregatorsEnabled:
      (Deno.env.get("SYNTRAF_AGGREGATORS") ?? "false").toLowerCase() === "true",
    isLocal,
  };
}
