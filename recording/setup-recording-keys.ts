/**
 * Local Dev — Recording-Run Keys
 *
 * Generates a fresh, deterministic identity set for a single video-recording
 * run. Reuses the local-dev master seed (`master-seed.ts`) but namespaces
 * every key by a per-run id, so two recordings on the same testnet don't
 * collide.
 *
 * Outputs:
 *   recording/runs/<run-id>/keys.txt           Human-readable summary
 *   recording/runs/<run-id>/run.env            Sourced by Playwright scripts
 *   recording/runs/<run-id>/.env.seed.user1    Browser-wallet seed for Alice
 *   recording/runs/<run-id>/.env.seed.user2    Browser-wallet seed for Bob
 *
 * Output paths are relative to local-dev/. The script lives under
 * recording/, so we resolve the runs dir from the parent of script-dir.
 *
 * Each recording run derives:
 *   admin   — council admin (signs onboarding txs in council-console)
 *   pp      — provider operator (signs SEP-10 in provider-console)
 *   alice   — wallet user 1 (BIP39 mnemonic + funded primary account)
 *   bob     — wallet user 2 (BIP39 mnemonic + funded primary account)
 *
 * All four primary Stellar accounts are funded via Friendbot.
 *
 * Usage:
 *   ./setup-recording-keys.sh                # uses default local-dev master + ISO timestamp
 *   RUN_ID=demo-1 ./setup-recording-keys.sh  # custom run id
 *   MASTER_SECRET=S... ./setup-recording-keys.sh
 *
 * Env overrides:
 *   MASTER_SECRET     Stellar secret seed; default = LOCAL_DEV_MASTER_SECRET
 *   RUN_ID            run namespace; default = ISO-8601 timestamp (UTC, dashes)
 *   FRIENDBOT_URL     default https://friendbot.stellar.org
 *                     (use http://localhost:8000/friendbot for local stack)
 *   OUTPUT_DIR        default <script-dir>/recording/runs/<RUN_ID>
 *   COUNCIL_CONSOLE_URL    baked into run.env. Council-console (UI) URL —
 *                          where Section 01 navigates to onboard. Default =
 *                          https://moonlight-beta-council-console.fly.dev
 *                          (local-dev: http://localhost:3030)
 *   COUNCIL_PLATFORM_URL   council-platform (API) URL — where the dashboard
 *                          fetches the council list from. Default =
 *                          https://moonlight-beta-council-platform.fly.dev
 *                          (local-dev: http://localhost:3015)
 *   DASHBOARD_URL          default https://dashboard-testnet.moonlightprotocol.io
 *                          (local-dev: http://localhost:3040)
 *   PROVIDER_PLATFORM_URL  privacy-provider API. Default =
 *                          https://moonlight-beta-privacy-provider-a.fly.dev
 *                          (local-dev: http://localhost:3010)
 */
import { LOCAL_DEV_MASTER_SECRET } from "../lib/master-seed.ts";
import {
  deriveRecordingRunKeys,
  type RecordingRunKeys,
} from "./recording-keys.ts";
import { formatResults, fundAccounts } from "../setup-accounts.ts";

const DEFAULT_FRIENDBOT = "https://friendbot.stellar.org";
const DEFAULT_COUNCIL_CONSOLE =
  "https://moonlight-beta-council-console.fly.dev";
const DEFAULT_COUNCIL_PLATFORM =
  "https://moonlight-beta-council-platform.fly.dev";
const DEFAULT_DASHBOARD = "https://dashboard-testnet.moonlightprotocol.io";
const DEFAULT_PROVIDER_PLATFORM =
  "https://moonlight-beta-privacy-provider-a.fly.dev";

function isoRunId(): string {
  // 2026-04-28T12-34-56Z — file-safe, sortable
  return new Date().toISOString().replace(/[:.]/g, "-").replace(
    /-\d{3}Z$/,
    "Z",
  );
}

function renderKeysTxt(
  keys: RecordingRunKeys,
  masterSecretSource: string,
): string {
  return [
    `# Recording-run keys`,
    `# Generated: ${new Date().toISOString()}`,
    `# Run ID:    ${keys.runId}`,
    `# Master:    ${masterSecretSource}`,
    ``,
    `[admin] council admin (council-console operator)`,
    `  pk: ${keys.admin.publicKey}`,
    `  sk: ${keys.admin.secretKey}`,
    ``,
    `[pp] provider operator (provider-console operator)`,
    `  pk: ${keys.pp.publicKey}`,
    `  sk: ${keys.pp.secretKey}`,
    ``,
    `[alice] wallet user 1`,
    `  mnemonic:   ${keys.alice.mnemonic}`,
    `  primary pk: ${keys.alice.primary.publicKey}`,
    `  primary sk: ${keys.alice.primary.secretKey}`,
    ``,
    `[bob] wallet user 2`,
    `  mnemonic:   ${keys.bob.mnemonic}`,
    `  primary pk: ${keys.bob.primary.publicKey}`,
    `  primary sk: ${keys.bob.primary.secretKey}`,
    ``,
  ].join("\n");
}

function renderRunEnv(
  keys: RecordingRunKeys,
  endpoints: {
    councilConsole: string;
    councilPlatform: string;
    dashboard: string;
    providerPlatform: string;
  },
): string {
  return [
    `# Recording-run environment — sourced by Playwright scripts.`,
    `# Generated: ${new Date().toISOString()}`,
    ``,
    `RUN_ID=${keys.runId}`,
    ``,
    `ADMIN_PK=${keys.admin.publicKey}`,
    `ADMIN_SK=${keys.admin.secretKey}`,
    ``,
    `PP_PK=${keys.pp.publicKey}`,
    `PP_SK=${keys.pp.secretKey}`,
    ``,
    `ALICE_MNEMONIC="${keys.alice.mnemonic}"`,
    `ALICE_PK=${keys.alice.primary.publicKey}`,
    ``,
    `BOB_MNEMONIC="${keys.bob.mnemonic}"`,
    `BOB_PK=${keys.bob.primary.publicKey}`,
    ``,
    `COUNCIL_CONSOLE_URL=${endpoints.councilConsole}`,
    `COUNCIL_PLATFORM_URL=${endpoints.councilPlatform}`,
    `DASHBOARD_URL=${endpoints.dashboard}`,
    `PROVIDER_PLATFORM_URL=${endpoints.providerPlatform}`,
    ``,
    `# Filled in by Section 1 (council onboarding) Playwright script:`,
    `# CHANNEL_AUTH_ID=`,
    `# PRIVACY_CHANNEL_ID=`,
    ``,
  ].join("\n");
}

function renderWalletSeed(
  mnemonic: string,
  password: string,
): string {
  return [
    `# Browser-wallet seed for a recording run.`,
    `# Channel and provider fields are filled in once Sections 1 and 2 land.`,
    ``,
    `SEED_PASSWORD=${password}`,
    `SEED_MNEMONIC=${mnemonic}`,
    `SEED_NETWORK=testnet`,
    `SEED_CHANNEL_CONTRACT_ID=`,
    `SEED_CHANNEL_NAME=Recording Demo Council`,
    `SEED_ASSET_CODE=XLM`,
    `SEED_ASSET_ISSUER=`,
    `SEED_PROVIDERS=`,
    ``,
  ].join("\n");
}

async function ensureDir(path: string) {
  await Deno.mkdir(path, { recursive: true });
}

/**
 * Probe each platform URL with a short-timeout GET. Surfaces the `:3110`
 * trap (parallel-stack port override leaked from a shell .env) immediately
 * instead of failing inside a wallet sign request mid-recording.
 */
async function probeEndpoints(endpoints: {
  councilConsole: string;
  councilPlatform: string;
  providerPlatform: string;
  dashboard: string;
}): Promise<void> {
  const targets: { name: string; url: string }[] = [
    { name: "COUNCIL_CONSOLE_URL", url: endpoints.councilConsole },
    { name: "COUNCIL_PLATFORM_URL", url: endpoints.councilPlatform },
    { name: "PROVIDER_PLATFORM_URL", url: endpoints.providerPlatform },
    { name: "DASHBOARD_URL", url: endpoints.dashboard },
  ];

  const failures: string[] = [];
  for (const { name, url } of targets) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 4000);
      const res = await fetch(url, { method: "GET", signal: ac.signal });
      clearTimeout(timer);
      // Drain the body so the connection closes cleanly under Deno.
      await res.body?.cancel();
      console.log(`  ${name.padEnd(22)} ${url} → ${res.status}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ${name.padEnd(22)} ${url} → UNREACHABLE (${msg})`);
      failures.push(`${name}=${url}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `\nAborting: ${failures.length} endpoint(s) unreachable.\n` +
        `  ${failures.join("\n  ")}\n\n` +
        `Hint: a parallel-stack shell env (e.g. PROVIDER_PORT=3110) may be ` +
        `overriding the URL. Run \`env | grep -E '_URL$|_PORT$'\` to check.`,
    );
    Deno.exit(1);
  }
}

async function main() {
  const args = new Set(Deno.args);
  if (args.has("--help") || args.has("-h")) {
    console.log("Usage: setup-recording-keys.sh");
    console.log("");
    console.log("Generates and funds keys for one video-recording run.");
    console.log("See top-of-file comment for env overrides.");
    Deno.exit(0);
  }

  const masterSecretEnv = Deno.env.get("MASTER_SECRET");
  const masterSecret = masterSecretEnv || LOCAL_DEV_MASTER_SECRET;
  const masterSecretSource = masterSecretEnv
    ? "MASTER_SECRET (env)"
    : "LOCAL_DEV_MASTER_SECRET";

  const runId = Deno.env.get("RUN_ID") || isoRunId();

  const friendbot = Deno.env.get("FRIENDBOT_URL") || DEFAULT_FRIENDBOT;
  const endpoints = {
    councilConsole: Deno.env.get("COUNCIL_CONSOLE_URL") ||
      DEFAULT_COUNCIL_CONSOLE,
    councilPlatform: Deno.env.get("COUNCIL_PLATFORM_URL") ||
      DEFAULT_COUNCIL_PLATFORM,
    dashboard: Deno.env.get("DASHBOARD_URL") || DEFAULT_DASHBOARD,
    providerPlatform: Deno.env.get("PROVIDER_PLATFORM_URL") ||
      DEFAULT_PROVIDER_PLATFORM,
  };

  const scriptDir = new URL(".", import.meta.url).pathname;
  const outputDir = Deno.env.get("OUTPUT_DIR") || `${scriptDir}runs/${runId}`;

  console.log("\n=== local-dev — Recording Keys ===\n");
  console.log(`  Run ID:           ${runId}`);
  console.log(`  Master secret:    ${masterSecretSource}`);
  console.log(`  Friendbot:        ${friendbot}`);
  console.log(`  Output:           ${outputDir}`);
  console.log("");

  console.log("Probing platform endpoints...");
  await probeEndpoints(endpoints);
  console.log("");

  const keys = await deriveRecordingRunKeys(masterSecret, runId);

  console.log("Funding accounts via Friendbot...");
  Deno.env.set("FRIENDBOT_URL", friendbot);
  const fundResults = await fundAccounts([
    keys.admin.publicKey,
    keys.pp.publicKey,
    keys.alice.primary.publicKey,
    keys.bob.primary.publicKey,
  ]);
  console.log(formatResults(fundResults));

  const failed = fundResults.filter((r) => r.status === "FAILED");
  if (failed.length > 0) {
    console.error(`\n${failed.length} account(s) failed to fund. Aborting.`);
    Deno.exit(1);
  }

  await ensureDir(outputDir);
  await Deno.writeTextFile(
    `${outputDir}/keys.txt`,
    renderKeysTxt(keys, masterSecretSource),
  );
  await Deno.writeTextFile(
    `${outputDir}/run.env`,
    renderRunEnv(keys, endpoints),
  );
  await Deno.writeTextFile(
    `${outputDir}/.env.seed.user1`,
    renderWalletSeed(keys.alice.mnemonic, "recording"),
  );
  await Deno.writeTextFile(
    `${outputDir}/.env.seed.user2`,
    renderWalletSeed(keys.bob.mnemonic, "recording"),
  );

  console.log(`\n=== Run ${runId} ready ===\n`);
  console.log(`  ${outputDir}/keys.txt`);
  console.log(`  ${outputDir}/run.env`);
  console.log(`  ${outputDir}/.env.seed.user1`);
  console.log(`  ${outputDir}/.env.seed.user2`);
  console.log("");
}

if (import.meta.main) {
  main();
}
