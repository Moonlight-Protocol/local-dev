/**
 * Local Dev — Alice→Bob send loop with deposit + withdraw
 *
 * Each run does one full lifecycle: Alice deposits into the channel, performs
 * N sends to Bob (sleeping INTERVAL_MS between each), then Bob withdraws back
 * to his real Stellar address. Useful for watching the provider-console
 * dashboard fill up across all event kinds.
 *
 * Each bundle is tagged with a random from/to pair drawn from the council's
 * accepted jurisdictions so the dashboard has flag data to render.
 *
 * Reuses the lib/client helpers so the bundles travel the same code path as
 * the e2e suite.
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
 *   COUNT          default 5         number of sends in the cycle
 *   INTERVAL_MS    default 1000      pause between sends
 *   SEND_AMOUNT    default 1         XLM per send
 *   STATE_FILE     default ./.local-dev-state
 */
import { Keypair } from "stellar-sdk";
import { authenticate } from "./lib/client/auth.ts";
import { loadConfig } from "./lib/client/config.ts";
import { deposit } from "./lib/client/deposit.ts";
import { prepareReceive } from "./lib/client/receive.ts";
import { send } from "./lib/client/send.ts";
import { withdraw } from "./lib/client/withdraw.ts";

const STATE_FILE = Deno.env.get("STATE_FILE") ??
  new URL("./.local-dev-state", import.meta.url).pathname;
const COUNT = Number(Deno.env.get("COUNT") ?? "5");
const INTERVAL_MS = Number(Deno.env.get("INTERVAL_MS") ?? "1000");
const SEND_AMOUNT = Number(Deno.env.get("SEND_AMOUNT") ?? "1");
const WITHDRAW_AMOUNT = 0.5; // less than SEND_AMOUNT so it fits in one UTXO + fee

const DEPOSIT_BUFFER = 2; // headroom for per-send fees

type ParsedState = {
  councilId: string;
  councilUrl: string;
};

function loadState(): ParsedState {
  const content = Deno.readTextFileSync(STATE_FILE);
  const map: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    map[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  // Set env vars the SDK config loader expects.
  if (map.CHANNEL_ID) Deno.env.set("E2E_CHANNEL_CONTRACT_ID", map.CHANNEL_ID);
  if (map.COUNCIL_ID) Deno.env.set("E2E_CHANNEL_AUTH_ID", map.COUNCIL_ID);
  if (map.ASSET_ID) Deno.env.set("E2E_CHANNEL_ASSET_CONTRACT_ID", map.ASSET_ID);
  if (map.PROVIDER_URL) Deno.env.set("PROVIDER_URL", map.PROVIDER_URL);
  if (map.NETWORK_PASSPHRASE) {
    Deno.env.set("STELLAR_NETWORK_PASSPHRASE", map.NETWORK_PASSPHRASE);
  }
  if (map.RPC_URL) Deno.env.set("STELLAR_RPC_URL", map.RPC_URL);
  if (map.FRIENDBOT_URL) Deno.env.set("FRIENDBOT_URL", map.FRIENDBOT_URL);
  return { councilId: map.COUNCIL_ID, councilUrl: map.COUNCIL_URL };
}

async function fetchAcceptedJurisdictions(
  state: ParsedState,
): Promise<string[]> {
  const url = `${state.councilUrl}/api/v1/public/council?councilId=${
    encodeURIComponent(state.councilId)
  }`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Council summary fetch failed: ${res.status} ${await res.text()}`,
    );
  }
  const { data } = await res.json();
  const councilCodes: string[] = (data?.jurisdictions ?? []).map(
    (j: { countryCode: string }) => j.countryCode,
  );
  const providerCodes: string[] = (data?.providers ?? []).flatMap((
    p: { jurisdictions: string[] | null },
  ) => p.jurisdictions ?? []);
  const merged = Array.from(
    new Set([...councilCodes, ...providerCodes].map((c) => c.toUpperCase())),
  );
  if (merged.length === 0) {
    throw new Error(
      "No jurisdictions known; setup-c.sh seeds US and setup-pp.sh claims UY — re-run them.",
    );
  }
  return merged;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function jurisdictionsFor(accepted: string[]): {
  jurisdictionFrom: string;
  jurisdictionTo: string;
} {
  return {
    jurisdictionFrom: pickRandom(accepted),
    jurisdictionTo: pickRandom(accepted),
  };
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
  const state = loadState();
  const config = loadConfig();
  const accepted = await fetchAcceptedJurisdictions(state);

  console.log("\n=== local-dev — Alice→Bob send loop ===\n");
  console.log(`  Count:           ${COUNT}`);
  console.log(`  Interval:        ${INTERVAL_MS}ms`);
  console.log(`  Send amount:     ${SEND_AMOUNT} XLM`);
  console.log(`  Withdraw amount: ${WITHDRAW_AMOUNT} XLM`);
  console.log(`  Provider:        ${config.providerUrl}`);
  console.log(`  Jurisdictions:   ${accepted.join(", ")}`);

  const alice = Keypair.random();
  const bob = Keypair.random();
  console.log(`  Alice:           ${alice.publicKey()}`);
  console.log(`  Bob:             ${bob.publicKey()}\n`);

  console.log("[1/5] Funding Alice + Bob via Friendbot");
  await fund(config.friendbotUrl, alice.publicKey());
  await fund(config.friendbotUrl, bob.publicKey());

  console.log("[2/5] Authenticating both with provider");
  const aliceJwt = await authenticate(alice, config);
  const bobJwt = await authenticate(bob, config);

  const depositAmount = SEND_AMOUNT * COUNT + DEPOSIT_BUFFER;
  const depositJurisdictions = jurisdictionsFor(accepted);
  console.log(
    `[3/5] Alice depositing ${depositAmount} XLM (${depositJurisdictions.jurisdictionFrom}→${depositJurisdictions.jurisdictionTo})`,
  );
  await deposit(
    alice.secret(),
    depositAmount,
    aliceJwt,
    config,
    undefined,
    depositJurisdictions,
  );

  console.log(`[4/5] Sending ${COUNT} bundles, ${INTERVAL_MS}ms apart\n`);
  for (let i = 1; i <= COUNT; i++) {
    const startedAt = Date.now();
    const receiverOps = await prepareReceive(bob.secret(), SEND_AMOUNT, config);
    const j = jurisdictionsFor(accepted);
    await send(
      alice.secret(),
      receiverOps,
      SEND_AMOUNT,
      aliceJwt,
      config,
      undefined,
      j,
    );
    console.log(
      `  ${i}/${COUNT}  sent ${SEND_AMOUNT} XLM (${j.jurisdictionFrom}→${j.jurisdictionTo}) ${
        Date.now() - startedAt
      }ms`,
    );
    if (i < COUNT) {
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  }

  const withdrawJurisdictions = jurisdictionsFor(accepted);
  console.log(
    `\n[5/5] Bob withdrawing ${WITHDRAW_AMOUNT} XLM to ${bob.publicKey()} (${withdrawJurisdictions.jurisdictionFrom}→${withdrawJurisdictions.jurisdictionTo})`,
  );
  await withdraw(
    bob.secret(),
    bob.publicKey(),
    WITHDRAW_AMOUNT,
    bobJwt,
    config,
    undefined,
    withdrawJurisdictions,
  );

  console.log("\n=== Done ===\n");
}

main().catch((err) => {
  console.error("\n=== send-loop FAILED ===");
  console.error(err);
  Deno.exit(1);
});
