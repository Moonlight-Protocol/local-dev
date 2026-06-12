/**
 * setup-entities.ts — seed the provider-console "Entities" section through the
 * real public API (no DB writes), so the operator view shows the full range of
 * interaction states exactly as the running stack produces them.
 *
 * Three flows are driven against a single PP (PP_1 by default; override with
 * PP_INDEX). Each uses the same client helpers the E2E suite and send-loop use,
 * so the only thing that differs between a rejected and an accepted bundle is
 * the submitter's KYC status — which is precisely the per-PP approval gate the
 * Entities view exists to surface:
 *
 *   K1  Unauthorized bundle submit → 403 (recorded UNVERIFIED), THEN KYC
 *       register → the same key flips to APPROVED.
 *   K2  Unauthorized bundle submit → 403 (stays UNVERIFIED, no identity).
 *   K3  KYC register → APPROVED, THEN a real deposit bundle → accepted and
 *       processed (the gate now lets it through).
 *
 * End state for the PP: K1 APPROVED+identity, K2 UNVERIFIED (no identity),
 * K3 APPROVED+identity — produced entirely through the endpoints.
 *
 * The SEP-10 connect that each authenticate() performs itself records an
 * interaction at the connect gate, so K1/K2 already appear as UNVERIFIED the
 * moment they connect; the 403 bundle attempt then bumps their updated_at.
 *
 * Prereqs: up.sh + setup-c.sh + setup-pp.sh. Reads .local-dev-state for the PP
 * keypair + its council's channel IDs. PROVIDER_URL / RPC_URL / FRIENDBOT_URL
 * come from the state file (or env).
 *
 * Idempotent: the three keypairs are fixed, so re-running upserts the same rows
 * (connect is an upsert; KYC returns 409-as-success) instead of piling up new
 * UNVERIFIED rows.
 *
 * Env overrides:
 *   STATE_FILE      default ./.local-dev-state
 *   PP_INDEX        default 1 (1-based index into PP_<n>_* in the state file)
 *   DEPOSIT_AMOUNT  default 50 (XLM, K3's accepted deposit)
 */
import { Keypair } from "stellar-sdk";
import { authenticate } from "./lib/client/auth.ts";
import { loadConfig } from "./lib/client/config.ts";
import { deposit } from "./lib/client/deposit.ts";
import { registerEntity } from "./lib/client/register-entity.ts";

const STATE_FILE = Deno.env.get("STATE_FILE") ??
  new URL("./.local-dev-state", import.meta.url).pathname;
const PP_INDEX = Number(Deno.env.get("PP_INDEX") ?? "1");
const DEPOSIT_AMOUNT = Number(Deno.env.get("DEPOSIT_AMOUNT") ?? "50");

// Fixed submitter keypairs — see the idempotency note in the header.
const K1 = Keypair.fromSecret(
  "SD4E7T44KN3NLNIUSNCVTGDQ2HEV57SB7JIUCBPJUAV7QLOZGVIM7I6J",
);
const K2 = Keypair.fromSecret(
  "SAGSV2RBBPA4THN7DFJTG6LZ53WLCZDDBXI4DIT5FQK7F5NV6XOBYZXP",
);
const K3 = Keypair.fromSecret(
  "SDFCPH2UXSZDTNKBDL62S3Q3BKP2NGSWMEBIK6J7N3VWNE3Z5THK2XV6",
);

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

async function fund(friendbotUrl: string, publicKey: string): Promise<void> {
  const res = await fetch(`${friendbotUrl}?addr=${publicKey}`);
  // 400 = already funded on this ledger — fine.
  if (!res.ok && res.status !== 400) {
    throw new Error(
      `Friendbot failed for ${publicKey}: ${res.status} ${await res.text()}`,
    );
  }
}

/**
 * Submit a real deposit bundle and require the per-PP approval gate to reject
 * it with 403. Throws if the submission is accepted (the gate failed to fire)
 * or if it fails for any reason other than the 403 we expect.
 */
async function expectUnauthorizedBundle(
  kp: Keypair,
  jwt: string,
  // deno-lint-ignore no-explicit-any
  config: any,
): Promise<void> {
  try {
    await deposit(kp.secret(), DEPOSIT_AMOUNT, jwt, config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("403")) {
      console.log("  ✓ rejected with 403 (Submitter not approved)");
      return;
    }
    throw new Error(`Expected a 403 rejection but got: ${msg}`);
  }
  throw new Error(
    "Bundle was ACCEPTED but the submitter is not approved — the 403 gate did not fire.",
  );
}

async function main(): Promise<void> {
  const state = parseStateFile(Deno.readTextFileSync(STATE_FILE));

  const ppPk = state[`PP_${PP_INDEX}_PK`];
  const ppName = state[`PP_${PP_INDEX}_NAME`];
  const councilIndex = Number(state[`PP_${PP_INDEX}_COUNCIL_INDEX`]);
  if (!ppPk || !councilIndex) {
    throw new Error(
      `State file ${STATE_FILE} has no PP_${PP_INDEX}_PK / COUNCIL_INDEX. ` +
        `Re-run setup-pp.sh, or set PP_INDEX to a valid PP.`,
    );
  }
  const channel = state[`COUNCIL_${councilIndex}_CHANNEL`];
  const councilId = state[`COUNCIL_${councilIndex}_ID`];
  const councilName = state[`COUNCIL_${councilIndex}_NAME`];
  const councilJurisdictions =
    (state[`COUNCIL_${councilIndex}_JURISDICTIONS`] ?? "").split(",").filter(
      Boolean,
    );

  // Wire the env vars lib/client/config.ts consumes for this PP/council pair.
  Deno.env.set("E2E_CHANNEL_CONTRACT_ID", channel);
  Deno.env.set("E2E_CHANNEL_AUTH_ID", councilId);
  Deno.env.set("E2E_CHANNEL_ASSET_CONTRACT_ID", state.ASSET_ID);
  Deno.env.set("E2E_PP_PUBLIC_KEY", ppPk);
  if (state.PROVIDER_URL) Deno.env.set("PROVIDER_URL", state.PROVIDER_URL);
  if (state.NETWORK_PASSPHRASE) {
    Deno.env.set("STELLAR_NETWORK_PASSPHRASE", state.NETWORK_PASSPHRASE);
  }
  if (state.RPC_URL) Deno.env.set("STELLAR_RPC_URL", state.RPC_URL);
  if (state.FRIENDBOT_URL) Deno.env.set("FRIENDBOT_URL", state.FRIENDBOT_URL);

  const config = loadConfig();

  // Pick KYC identities from the council's jurisdictions so they look real.
  const jx = (n: number) => councilJurisdictions.slice(0, n);

  console.log("\n=== local-dev — seed entity interactions (real API) ===\n");
  console.log(`  PP:            ${ppName}`);
  console.log(`  PP pubkey:     ${ppPk}`);
  console.log(`  Council:       ${councilName} (${councilId})`);
  console.log(`  Channel:       ${channel}`);
  console.log(`  Provider URL:  ${state.PROVIDER_URL}`);
  console.log(`  K1 (403→KYC):  ${K1.publicKey()}`);
  console.log(`  K2 (403 only): ${K2.publicKey()}`);
  console.log(`  K3 (KYC→bundle): ${K3.publicKey()}\n`);

  console.log("[0/3] Funding submitters via Friendbot");
  await fund(config.friendbotUrl, K1.publicKey());
  await fund(config.friendbotUrl, K2.publicKey());
  await fund(config.friendbotUrl, K3.publicKey());

  // ---- K1: unauthorized bundle (403), then KYC → APPROVED ----
  console.log(
    "\n[1/3] K1 — unauthorized bundle submission, then KYC registration",
  );
  const k1Jwt = await authenticate(K1, config); // connect records UNVERIFIED
  console.log("  connected (SEP-10) — recorded as UNVERIFIED");
  await expectUnauthorizedBundle(K1, k1Jwt, config);
  await registerEntity(
    config.providerUrl,
    ppPk,
    K1,
    "Acme Payments Ltd",
    jx(2),
  );
  console.log(
    `  ✓ KYC registered → APPROVED (jurisdictions ${jx(2).join(", ")})`,
  );

  // ---- K2: unauthorized bundle (403), stays UNVERIFIED ----
  console.log("\n[2/3] K2 — unauthorized bundle submission only");
  const k2Jwt = await authenticate(K2, config); // connect records UNVERIFIED
  console.log("  connected (SEP-10) — recorded as UNVERIFIED");
  await expectUnauthorizedBundle(K2, k2Jwt, config);
  console.log("  (left UNVERIFIED — no KYC submitted)");

  // ---- K3: KYC → APPROVED, then a real deposit bundle (accepted) ----
  console.log("\n[3/3] K3 — KYC registration, then a real deposit bundle");
  await registerEntity(
    config.providerUrl,
    ppPk,
    K3,
    "Globex Comercio S.A.",
    jx(1),
  );
  console.log(
    `  ✓ KYC registered → APPROVED (jurisdictions ${jx(1).join(", ")})`,
  );
  const k3Jwt = await authenticate(K3, config);
  console.log(`  connected (SEP-10), depositing ${DEPOSIT_AMOUNT} XLM…`);
  await deposit(K3.secret(), DEPOSIT_AMOUNT, k3Jwt, config);
  console.log("  ✓ bundle accepted and processed (gate passed)");

  console.log("\n=== Done. Entities seeded for", ppName, "===");
  console.log(
    "  Open the operator console, go to this PP's Provider Details,",
  );
  console.log("  and the Entities section will list K1/K2/K3.\n");
}

main().catch((err) => {
  console.error(
    "\nsetup-entities failed:",
    err instanceof Error ? err.message : err,
  );
  Deno.exit(1);
});
