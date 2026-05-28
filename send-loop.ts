/**
 * Local Dev — All-countries send loop
 *
 * One invocation walks every country registered in .local-dev-state. For
 * each country the loop runs a full cycle: deposit → COUNT sends → one
 * FAILED bundle (overspend) → one EXPIRED bundle (force-expire) → withdraw.
 *
 * Prereqs: ./up.sh → ./setup-c.sh → ./setup-pp.sh
 *
 * Env overrides:
 *   COUNT           default 5     normal sends per country
 *   INTERVAL_MS     default 1000  pause between sends within a country
 *   SEND_AMOUNT     default 1     XLM per send
 *   FAIL            default true  inject one FAILED bundle per country
 *   EXPIRE          default true  inject one EXPIRED bundle per country
 *   STATE_FILE      default ./.local-dev-state
 */
import { Buffer } from "node:buffer";
import { Keypair } from "stellar-sdk";
import { authenticate } from "./lib/client/auth.ts";
import { loadConfig } from "./lib/client/config.ts";
import { deposit } from "./lib/client/deposit.ts";
import { prepareReceive } from "./lib/client/receive.ts";
import { send } from "./lib/client/send.ts";
import { injectFailingBundle } from "./lib/client/fail-inject.ts";
import { withdraw } from "./lib/client/withdraw.ts";

const STATE_FILE = Deno.env.get("STATE_FILE") ??
  new URL("./.local-dev-state", import.meta.url).pathname;
const COUNT = Number(Deno.env.get("COUNT") ?? "5");
const INTERVAL_MS = Number(Deno.env.get("INTERVAL_MS") ?? "1000");
const SEND_AMOUNT = Number(Deno.env.get("SEND_AMOUNT") ?? "1");
const WITHDRAW_AMOUNT = 0.5;
const DEPOSIT_BUFFER = 2;
// Each cycle injects one failing and one expiring bundle in addition to the
// normal sends, so dashboards always see a mix of stages. Opt out with
// FAIL=false / EXPIRE=false.
const INJECT_FAIL = (Deno.env.get("FAIL") ?? "true").toLowerCase() !== "false";
const INJECT_EXPIRE =
  (Deno.env.get("EXPIRE") ?? "true").toLowerCase() !== "false";

// First-name pools per country. send-loop picks two random distinct names per
// cycle so dashboards see entity variety beyond "Alicia / Roberto".
const ENTITY_NAMES_BY_COUNTRY: Record<string, string[]> = {
  // Mercosur (Spanish / Portuguese)
  AR: [
    "Alicia",
    "Roberto",
    "Carmen",
    "Diego",
    "Sofía",
    "Mateo",
    "Lucía",
    "Joaquín",
  ],
  BR: [
    "Mariana",
    "Pedro",
    "Beatriz",
    "Lucas",
    "Camila",
    "Felipe",
    "Larissa",
    "Gustavo",
  ],
  UY: ["Valentina", "Sebastián", "Florencia", "Tomás", "Catalina", "Nicolás"],
  PY: ["Carolina", "Andrés", "Daniela", "Pablo", "Verónica", "Hugo"],
  // Europe
  GB: [
    "Emma",
    "Oliver",
    "Sophia",
    "Harry",
    "Lily",
    "James",
    "Charlotte",
    "Henry",
  ],
  FR: [
    "Camille",
    "Antoine",
    "Léa",
    "Hugo",
    "Manon",
    "Lucas",
    "Clara",
    "Nathan",
  ],
  DE: ["Sophie", "Maximilian", "Anna", "Felix", "Mia", "Leon", "Emma", "Paul"],
  ES: [
    "Sara",
    "Javier",
    "Paula",
    "Alejandro",
    "Lucía",
    "Mario",
    "Marta",
    "David",
  ],
  IT: [
    "Giulia",
    "Lorenzo",
    "Sofia",
    "Matteo",
    "Aurora",
    "Andrea",
    "Martina",
    "Riccardo",
  ],
  // North America
  US: ["Emily", "Michael", "Olivia", "David", "Ava", "James", "Mia", "John"],
  MX: [
    "Sofía",
    "Diego",
    "Valentina",
    "Santiago",
    "Ximena",
    "Mateo",
    "Renata",
    "Sebastián",
  ],
  CA: ["Emma", "Liam", "Olivia", "Noah", "Ava", "Ethan", "Isabella", "Mason"],
};

interface CouncilEntry {
  id: string;
  name: string;
  channel: string;
  jurisdictions: string[];
}

interface PpEntry {
  index: number;
  pk: string;
  sk: string;
  name: string;
  councilIndex: number; // 1-based as stored
  jurisdiction: string;
}

interface State {
  COUNCIL_URL: string;
  PROVIDER_URL: string;
  NETWORK_PASSPHRASE?: string;
  RPC_URL?: string;
  FRIENDBOT_URL?: string;
  ASSET_ID: string;
  OPERATOR_PK?: string;
  OPERATOR_SK?: string;
  councils: CouncilEntry[];
  pps: PpEntry[];
}

function parseStateFile(content: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    map[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return map;
}

function loadState(): State {
  const content = Deno.readTextFileSync(STATE_FILE);
  const map = parseStateFile(content);

  const councilCount = Number(map.COUNCIL_COUNT ?? "0");
  if (!councilCount) {
    throw new Error(
      `State file ${STATE_FILE} has COUNCIL_COUNT=0. Re-run setup-c.sh.`,
    );
  }
  const councils: CouncilEntry[] = [];
  for (let i = 1; i <= councilCount; i++) {
    councils.push({
      id: map[`COUNCIL_${i}_ID`],
      name: map[`COUNCIL_${i}_NAME`],
      channel: map[`COUNCIL_${i}_CHANNEL`],
      jurisdictions: (map[`COUNCIL_${i}_JURISDICTIONS`] ?? "").split(",")
        .filter((j) => j),
    });
  }

  const ppCount = Number(map.PP_COUNT ?? "0");
  if (!ppCount) {
    throw new Error(
      `State file ${STATE_FILE} has PP_COUNT=0. Re-run setup-pp.sh.`,
    );
  }
  const pps: PpEntry[] = [];
  for (let i = 1; i <= ppCount; i++) {
    pps.push({
      index: i,
      pk: map[`PP_${i}_PK`],
      sk: map[`PP_${i}_SK`],
      name: map[`PP_${i}_NAME`],
      councilIndex: Number(map[`PP_${i}_COUNCIL_INDEX`]),
      jurisdiction: map[`PP_${i}_JURISDICTION`],
    });
  }

  return {
    COUNCIL_URL: map.COUNCIL_URL,
    PROVIDER_URL: map.PROVIDER_URL ?? "http://localhost:3010",
    NETWORK_PASSPHRASE: map.NETWORK_PASSPHRASE,
    RPC_URL: map.RPC_URL,
    FRIENDBOT_URL: map.FRIENDBOT_URL,
    ASSET_ID: map.ASSET_ID,
    OPERATOR_PK: map.OPERATOR_PK,
    OPERATOR_SK: map.OPERATOR_SK,
    councils,
    pps,
  };
}

// Wallet-auth flow for the operator dashboard JWT (SEP-43 challenge/verify).
// Mirrors local-dev/setup-pp.ts walletAuth(), inlined to avoid a one-off
// shared util.
async function dashboardWalletAuth(
  providerUrl: string,
  operator: Keypair,
): Promise<string> {
  const base = `${providerUrl}/api/v1/dashboard/auth`;
  const challengeRes = await fetch(`${base}/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: operator.publicKey() }),
  });
  if (!challengeRes.ok) {
    throw new Error(
      `Operator challenge failed: ${challengeRes.status} ${await challengeRes
        .text()}`,
    );
  }
  const { data: { nonce } } = await challengeRes.json();
  const nonceBytes = Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0));
  const sig = operator.sign(Buffer.from(nonceBytes));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
  const verifyRes = await fetch(`${base}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nonce,
      signature,
      publicKey: operator.publicKey(),
    }),
  });
  if (!verifyRes.ok) {
    throw new Error(
      `Operator verify failed: ${verifyRes.status} ${await verifyRes.text()}`,
    );
  }
  const { data: { token } } = await verifyRes.json();
  return token as string;
}

async function forceExpireBundles(
  bundleIds: string[],
  state: State,
): Promise<void> {
  if (!state.OPERATOR_SK) {
    throw new Error(
      "OPERATOR_SK missing from state — re-run setup-pp.sh so the operator JWT can be obtained.",
    );
  }
  const operator = Keypair.fromSecret(state.OPERATOR_SK);
  const jwt = await dashboardWalletAuth(state.PROVIDER_URL, operator);
  const res = await fetch(
    `${state.PROVIDER_URL}/api/v1/dashboard/bundles/expire`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ bundleIds }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Force-expire failed: ${res.status} ${await res.text()}`,
    );
  }
  const json = await res.json();
  console.log(`  Expire response: ${JSON.stringify(json.data ?? json)}`);
}

async function registerEntity(
  providerUrl: string,
  pubkey: string,
  name: string,
  jurisdictions: string[],
): Promise<void> {
  const res = await fetch(`${providerUrl}/api/v1/entities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey, name, jurisdictions }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(
      `Entity registration failed for ${pubkey}: ${res.status} ${await res
        .text()}`,
    );
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

async function runCycleForPp(
  state: State,
  pp: PpEntry,
): Promise<void> {
  const country = pp.jurisdiction.toUpperCase();
  const council = state.councils[pp.councilIndex - 1];
  if (!council) {
    throw new Error(
      `PP ${pp.name} references council index ${pp.councilIndex} but state only has ${state.councils.length} councils.`,
    );
  }

  // Wire env vars that lib/client/config.ts consumes. These are mutated per
  // country since each PP/council pair uses a different channel.
  Deno.env.set("E2E_CHANNEL_CONTRACT_ID", council.channel);
  Deno.env.set("E2E_CHANNEL_AUTH_ID", council.id);
  Deno.env.set("E2E_CHANNEL_ASSET_CONTRACT_ID", state.ASSET_ID);
  Deno.env.set("PROVIDER_URL", state.PROVIDER_URL);
  Deno.env.set("E2E_PP_PUBLIC_KEY", pp.pk);
  if (state.NETWORK_PASSPHRASE) {
    Deno.env.set("STELLAR_NETWORK_PASSPHRASE", state.NETWORK_PASSPHRASE);
  }
  if (state.RPC_URL) Deno.env.set("STELLAR_RPC_URL", state.RPC_URL);
  if (state.FRIENDBOT_URL) Deno.env.set("FRIENDBOT_URL", state.FRIENDBOT_URL);

  const config = loadConfig();

  console.log("\n=== local-dev — Alicia → Roberto send loop ===\n");
  console.log(`  Country:       ${country}`);
  console.log(`  PP:            ${pp.name}`);
  console.log(`  PP pubkey:     ${pp.pk}`);
  console.log(`  Council:       ${council.name}`);
  console.log(`  Channel:       ${council.channel}`);
  console.log(`  Provider URL:  ${state.PROVIDER_URL}`);
  console.log(`  Cycle:         ${COUNT} sends × ${SEND_AMOUNT} XLM`);
  console.log("");

  // Pick two distinct random names from the country's pool.
  const namePool = ENTITY_NAMES_BY_COUNTRY[country] ?? ["Alicia", "Roberto"];
  const shuffled = [...namePool].sort(() => Math.random() - 0.5);
  const senderFirstName = shuffled[0];
  const receiverFirstName = shuffled[1] ?? shuffled[0];
  const senderName = `${senderFirstName} ${country}`;
  const receiverName = `${receiverFirstName} ${country}`;

  const alicia = Keypair.random();
  const roberto = Keypair.random();
  console.log(`  ${senderName}: ${alicia.publicKey()}`);
  console.log(`  ${receiverName}: ${roberto.publicKey()}\n`);

  console.log("[1/5] Funding via Friendbot");
  await fund(config.friendbotUrl, alicia.publicKey());
  await fund(config.friendbotUrl, roberto.publicKey());

  console.log("[2/5] Authenticating to provider");
  const aliciaJwt = await authenticate(alicia, config);
  const robertoJwt = await authenticate(roberto, config);

  console.log("[2b/5] Registering KYC/KYB entities");
  await registerEntity(
    state.PROVIDER_URL,
    alicia.publicKey(),
    senderName,
    [country],
  );
  await registerEntity(
    state.PROVIDER_URL,
    roberto.publicKey(),
    receiverName,
    [country],
  );

  // Deposit covers normal sends + the expire-injection sends (which still
  // reserve UTXOs even though the bundle is force-expired before it settles).
  // The fail-injection bundle deliberately overspends, so we don't budget it.
  const expireExtras = INJECT_EXPIRE ? 1 : 0;
  const depositAmount = SEND_AMOUNT * (COUNT + expireExtras) + DEPOSIT_BUFFER;
  console.log(`[3/6] ${senderName} depositing ${depositAmount} XLM`);
  await deposit(alicia.secret(), depositAmount, aliciaJwt, config);

  console.log(`[4/6] Sending ${COUNT} bundles, ${INTERVAL_MS}ms apart\n`);
  for (let i = 1; i <= COUNT; i++) {
    const startedAt = Date.now();
    const receiverOps = await prepareReceive(
      roberto.secret(),
      SEND_AMOUNT,
      config,
    );
    await send(
      alicia.secret(),
      receiverOps,
      SEND_AMOUNT,
      aliciaJwt,
      config,
    );
    console.log(
      `  ${i}/${COUNT}  sent ${SEND_AMOUNT} XLM ${Date.now() - startedAt}ms`,
    );
    if (i < COUNT) {
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  }

  if (INJECT_FAIL) {
    // Deposit a small amount, then submit a SPEND for that UTXO with a
    // CREATE for 1 stroop more. Server admits (UTXO exists, signatures
    // valid), executor sim rejects because sum(SPEND) != sum(CREATE).
    console.log("\n[5/6] Injecting one FAILED bundle (2× overspend)");
    try {
      const bundleId = await injectFailingBundle(
        alicia.secret(),
        aliciaJwt,
        config,
      );
      console.log(`  submitted ${bundleId}, expecting FAILED at sim`);
    } catch (err) {
      console.log(`  fail injection raised: ${(err as Error).message}`);
    }
  }

  if (INJECT_EXPIRE) {
    // Submit one extra bundle without waiting, then immediately admin-expire
    // it via POST /dashboard/bundles/expire — bundle settles as EXPIRED.
    console.log("\n[5/6] Injecting one EXPIRED bundle (force-expire)");
    try {
      const receiverOps = await prepareReceive(
        roberto.secret(),
        SEND_AMOUNT,
        config,
      );
      const bundleId = await send(
        alicia.secret(),
        receiverOps,
        SEND_AMOUNT,
        aliciaJwt,
        config,
        undefined,
        { waitForCompletion: false },
      );
      console.log(`  submitted ${bundleId}, force-expiring…`);
      await forceExpireBundles([bundleId], state);
    } catch (err) {
      console.log(`  expire injection raised: ${(err as Error).message}`);
    }
  }

  console.log(`\n[6/6] ${receiverName} withdrawing ${WITHDRAW_AMOUNT} XLM`);
  await withdraw(
    roberto.secret(),
    roberto.publicKey(),
    WITHDRAW_AMOUNT,
    robertoJwt,
    config,
  );

  console.log("\n=== Done ===");
}

async function main(): Promise<void> {
  const state = loadState();
  const totalStart = Date.now();
  const failures: { country: string; error: string }[] = [];

  console.log(
    `\n=== local-dev — all-countries send loop (${state.pps.length} countries) ===\n`,
  );

  for (let i = 0; i < state.pps.length; i++) {
    const pp = state.pps[i];
    const country = pp.jurisdiction.toUpperCase();
    console.log(`\n──── [${i + 1}/${state.pps.length}] ${country} ────`);
    try {
      await runCycleForPp(state, pp);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Cycle failed for ${country}: ${message}`);
      failures.push({ country, error: message });
    }
  }

  const elapsedS = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(
    `\n=== Complete in ${elapsedS}s — ${
      state.pps.length - failures.length
    }/${state.pps.length} countries OK ===`,
  );
  if (failures.length > 0) {
    console.error("Failures:");
    for (const f of failures) {
      console.error(`  ${f.country}: ${f.error}`);
    }
    Deno.exit(1);
  }
}

main().catch((err) => {
  console.error("\n=== Send loop FAILED ===");
  console.error(err);
  Deno.exit(1);
});
