/**
 * Local Dev — Alice→Bob send loop
 *
 * Fires N (default 5) Alice→Bob privacy-channel sends through the running PP,
 * sleeping `INTERVAL_MS` between each. Useful for watching the provider-console
 * events tail update in real time.
 *
 * Reuses the lib/client helpers so the bundles travel the same code path as the
 * e2e suite.
 *
 * Prereqs: ./up.sh → ./setup-c.sh → ./setup-pp.sh has run.
 *
 * Usage (preferred — via wrapper):
 *   ./send-loop.sh
 *
 * Usage (direct):
 *   deno run --allow-all send-loop.ts
 *
 * Env overrides:
 *   COUNT          default 5
 *   INTERVAL_MS    default 1000
 *   SEND_AMOUNT    default 1 (XLM per send)
 *   STATE_FILE     default ./.local-dev-state
 */
import { Keypair } from "stellar-sdk";
import { authenticate } from "./lib/client/auth.ts";
import { loadConfig } from "./lib/client/config.ts";
import { deposit } from "./lib/client/deposit.ts";
import { prepareReceive } from "./lib/client/receive.ts";
import { send } from "./lib/client/send.ts";

const STATE_FILE = Deno.env.get("STATE_FILE") ??
  new URL("./.local-dev-state", import.meta.url).pathname;
const COUNT = Number(Deno.env.get("COUNT") ?? "5");
const INTERVAL_MS = Number(Deno.env.get("INTERVAL_MS") ?? "1000");
const SEND_AMOUNT = Number(Deno.env.get("SEND_AMOUNT") ?? "1");

const DEPOSIT_BUFFER = 2; // headroom for per-send fees

function loadStateEnvVars(): void {
  const content = Deno.readTextFileSync(STATE_FILE);
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (key === "CHANNEL_ID") Deno.env.set("E2E_CHANNEL_CONTRACT_ID", value);
    if (key === "COUNCIL_ID") Deno.env.set("E2E_CHANNEL_AUTH_ID", value);
    if (key === "ASSET_ID") {
      Deno.env.set("E2E_CHANNEL_ASSET_CONTRACT_ID", value);
    }
    if (key === "PROVIDER_URL") Deno.env.set("PROVIDER_URL", value);
    if (key === "NETWORK_PASSPHRASE") {
      Deno.env.set("STELLAR_NETWORK_PASSPHRASE", value);
    }
    if (key === "RPC_URL") Deno.env.set("STELLAR_RPC_URL", value);
    if (key === "FRIENDBOT_URL") Deno.env.set("FRIENDBOT_URL", value);
  }
}

async function fund(friendbotUrl: string, publicKey: string): Promise<void> {
  const res = await fetch(`${friendbotUrl}?addr=${publicKey}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(
      `Friendbot failed for ${publicKey}: ${res.status} ${await res.text()}`,
    );
  }
}

async function main(): Promise<void> {
  loadStateEnvVars();
  const config = loadConfig();

  console.log("\n=== local-dev — Alice→Bob send loop ===\n");
  console.log(`  Count:       ${COUNT}`);
  console.log(`  Interval:    ${INTERVAL_MS}ms`);
  console.log(`  Send amount: ${SEND_AMOUNT} XLM`);
  console.log(`  Provider:    ${config.providerUrl}`);

  const alice = Keypair.random();
  const bob = Keypair.random();
  console.log(`  Alice:       ${alice.publicKey()}`);
  console.log(`  Bob:         ${bob.publicKey()}\n`);

  console.log("[1/4] Funding Alice + Bob via Friendbot");
  await fund(config.friendbotUrl, alice.publicKey());
  await fund(config.friendbotUrl, bob.publicKey());

  console.log("[2/4] Authenticating both with provider");
  const aliceJwt = await authenticate(alice, config);
  await authenticate(bob, config);

  const depositAmount = SEND_AMOUNT * COUNT + DEPOSIT_BUFFER;
  console.log(`[3/4] Alice depositing ${depositAmount} XLM into channel`);
  await deposit(alice.secret(), depositAmount, aliceJwt, config);

  console.log(`[4/4] Sending ${COUNT} bundles, ${INTERVAL_MS}ms apart\n`);
  for (let i = 1; i <= COUNT; i++) {
    const startedAt = Date.now();
    const receiverOps = await prepareReceive(bob.secret(), SEND_AMOUNT, config);
    await send(alice.secret(), receiverOps, SEND_AMOUNT, aliceJwt, config);
    console.log(
      `  ${i}/${COUNT}  sent ${SEND_AMOUNT} XLM (${
        Date.now() - startedAt
      }ms)`,
    );
    if (i < COUNT) {
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  }

  console.log("\n=== Done ===\n");
}

main().catch((err) => {
  console.error("\n=== send-loop FAILED ===");
  console.error(err);
  Deno.exit(1);
});
