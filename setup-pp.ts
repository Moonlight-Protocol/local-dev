/**
 * Local Dev — Privacy Provider Setup (multi-PP)
 *
 * Registers 12 PPs, one per country across the 3 councils created by
 * setup-c.sh. Each PP goes through the full production join flow against the
 * local stack: register → join request → admin approve → add_provider on
 * chain → wait ACTIVE.
 *
 *   Mercosur (council 1):
 *     Mercado Libre Argentina Provider  (AR)
 *     Mercado Libre Brazil    Provider  (BR)
 *     Mercado Libre Uruguay   Provider  (UY)
 *     Mercado Libre Paraguay  Provider  (PY)
 *   Europe (council 2):
 *     Amazon UK      Provider  (GB)
 *     Amazon France  Provider  (FR)
 *     Amazon Germany Provider  (DE)
 *     Amazon Spain   Provider  (ES)
 *     Amazon Italy   Provider  (IT)
 *   North America (council 3):
 *     Amazon US     Provider  (US)
 *     Amazon Mexico Provider  (MX)
 *     Amazon Canada Provider  (CA)
 *
 * Each PP gets a fresh keypair derived deterministically from PP_SECRET +
 * index so re-runs (against a fresh ledger) yield the same pubkeys.
 *
 * Prereqs:
 *   - up.sh has run
 *   - setup-c.sh has run (.local-dev-state has COUNCIL_COUNT + COUNCIL_<i>_*)
 *
 * Usage:
 *   ./setup-pp.sh
 */
import { Keypair } from "npm:@stellar/stellar-sdk@14.2.0";
import { Buffer } from "node:buffer";
import { createServer } from "./lib/soroban.ts";
import { addProvider } from "./lib/admin.ts";
import { extractEvents, verifyEvent } from "./lib/events.ts";

const RPC_URL = Deno.env.get("STELLAR_RPC_URL") ??
  "http://localhost:8000/soroban/rpc";
const FRIENDBOT_URL = Deno.env.get("FRIENDBOT_URL") ??
  "http://localhost:8000/friendbot";
const NETWORK_PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ??
  "Standalone Network ; February 2017";
const PROVIDER_URL = Deno.env.get("PROVIDER_URL") ?? "http://localhost:3010";
const STATE_FILE = Deno.env.get("STATE_FILE") ??
  new URL("./.local-dev-state", import.meta.url).pathname;

// One operator keypair owns all 12 PPs (matches the provider-console flow:
// the user signs once, the SPA derives a masterSeed from their signature,
// and PP keys are SHA-256(masterSeed || "pp" || index) — see
// provider-console/src/lib/wallet.ts).
const OPERATOR_SECRET = Deno.env.get("OPERATOR_SECRET") ??
  Deno.env.get("PP_SECRET") ??
  "SDRTOKYHEEVBDTC3QPFKKGS5EGTFSXM4B6HTGO2JLY6ZRH4XHICZQTLI";

interface ProviderSpec {
  name: string;
  councilIndex: number; // 0-based into COUNCILS
  jurisdiction: string;
}

const PROVIDERS: ProviderSpec[] = [
  // Mercosur
  {
    name: "Mercado Libre Argentina Provider",
    councilIndex: 0,
    jurisdiction: "AR",
  },
  {
    name: "Mercado Libre Brazil Provider",
    councilIndex: 0,
    jurisdiction: "BR",
  },
  {
    name: "Mercado Libre Uruguay Provider",
    councilIndex: 0,
    jurisdiction: "UY",
  },
  {
    name: "Mercado Libre Paraguay Provider",
    councilIndex: 0,
    jurisdiction: "PY",
  },
  // Europe
  { name: "Amazon UK Provider", councilIndex: 1, jurisdiction: "GB" },
  { name: "Amazon France Provider", councilIndex: 1, jurisdiction: "FR" },
  { name: "Amazon Germany Provider", councilIndex: 1, jurisdiction: "DE" },
  { name: "Amazon Spain Provider", councilIndex: 1, jurisdiction: "ES" },
  { name: "Amazon Italy Provider", councilIndex: 1, jurisdiction: "IT" },
  // North America
  { name: "Amazon US Provider", councilIndex: 2, jurisdiction: "US" },
  { name: "Amazon Mexico Provider", councilIndex: 2, jurisdiction: "MX" },
  { name: "Amazon Canada Provider", councilIndex: 2, jurisdiction: "CA" },
];

interface CouncilState {
  id: string;
  name: string;
  channel: string;
  jurisdictions: string[];
}

interface State {
  ADMIN_SK: string;
  ADMIN_PK: string;
  ASSET_ID: string;
  COUNCIL_URL: string;
  councils: CouncilState[];
}

async function loadState(): Promise<State> {
  let content: string;
  try {
    content = await Deno.readTextFile(STATE_FILE);
  } catch {
    throw new Error(
      `State file not found at ${STATE_FILE}. Run setup-c.sh first.`,
    );
  }
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  const required = [
    "ADMIN_SK",
    "ADMIN_PK",
    "ASSET_ID",
    "COUNCIL_URL",
    "COUNCIL_COUNT",
  ];
  for (const key of required) {
    if (!env[key]) {
      throw new Error(`State file missing ${key}. Re-run setup-c.sh.`);
    }
  }
  const count = Number(env.COUNCIL_COUNT);
  const councils: CouncilState[] = [];
  for (let i = 1; i <= count; i++) {
    const id = env[`COUNCIL_${i}_ID`];
    const name = env[`COUNCIL_${i}_NAME`];
    const channel = env[`COUNCIL_${i}_CHANNEL`];
    const jurisdictions = (env[`COUNCIL_${i}_JURISDICTIONS`] ?? "").split(",")
      .filter((j) => j);
    if (!id || !name || !channel) {
      throw new Error(`State file missing COUNCIL_${i}_* fields.`);
    }
    councils.push({ id, name, channel, jurisdictions });
  }
  return {
    ADMIN_SK: env.ADMIN_SK,
    ADMIN_PK: env.ADMIN_PK,
    ASSET_ID: env.ASSET_ID,
    COUNCIL_URL: env.COUNCIL_URL,
    councils,
  };
}

async function appendStateLines(lines: Record<string, string>): Promise<void> {
  const block = [
    "",
    "# Appended by setup-pp.sh",
    `# Created: ${new Date().toISOString()}`,
    ...Object.entries(lines).map(([k, v]) => `${k}=${v}`),
    "",
  ].join("\n");
  await Deno.writeTextFile(STATE_FILE, block, { append: true });
}

async function fundAccount(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(
      `Friendbot failed for ${publicKey}: ${res.status} ${await res.text()}`,
    );
  }
}

async function warmupService(name: string, url: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${url}/api/v1/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${name} not reachable at ${url}`);
}

async function walletAuth(
  baseUrl: string,
  authRoute: string,
  keypair: Keypair,
): Promise<string> {
  const challengeRes = await fetch(`${baseUrl}${authRoute}/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: keypair.publicKey() }),
  });
  if (!challengeRes.ok) {
    throw new Error(
      `Auth challenge failed (${baseUrl}${authRoute}): ${challengeRes.status} ${await challengeRes
        .text()}`,
    );
  }
  const { data: { nonce } } = await challengeRes.json();

  const nonceBytes = Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0));
  const sig = keypair.sign(Buffer.from(nonceBytes));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));

  const verifyRes = await fetch(`${baseUrl}${authRoute}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, signature, publicKey: keypair.publicKey() }),
  });
  if (!verifyRes.ok) {
    throw new Error(
      `Auth verify failed (${baseUrl}${authRoute}): ${verifyRes.status} ${await verifyRes
        .text()}`,
    );
  }
  const { data: { token } } = await verifyRes.json();
  return token;
}

async function signJoinEnvelope<T>(
  payload: T,
  keypair: Keypair,
): Promise<
  { payload: T; signature: string; publicKey: string; timestamp: number }
> {
  const timestamp = Date.now();
  const canonical = JSON.stringify({ payload, timestamp });
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
  const signature = Buffer.from(keypair.sign(Buffer.from(hash))).toString(
    "base64",
  );
  return {
    payload,
    signature,
    publicKey: keypair.publicKey(),
    timestamp,
  };
}

async function pollMembershipActive(
  ppPublicKey: string,
  dashboardJwt: string,
  maxAttempts = 90,
  intervalMs = 2000,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(
      `${PROVIDER_URL}/api/v1/dashboard/council/membership?ppPublicKey=${
        encodeURIComponent(ppPublicKey)
      }`,
      { headers: { "Authorization": `Bearer ${dashboardJwt}` } },
    );
    if (res.status === 200) {
      const { data } = await res.json();
      if (data?.status === "ACTIVE") return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Membership for ${ppPublicKey} did not become ACTIVE after ${
      maxAttempts * intervalMs
    }ms.`,
  );
}

/**
 * Mirrors provider-console/src/lib/wallet.ts:
 *   masterSeed = SHA-256(operator.sign("Moonlight: Derive server key"))
 *   PP_i = SHA-256(masterSeed || "pp" || i)  → Ed25519 seed
 *
 * Returns the masterSeed so callers can derive any number of PPs from it.
 */
async function deriveMasterSeed(operator: Keypair): Promise<Uint8Array> {
  const message = new TextEncoder().encode("Moonlight: Derive server key");
  const signature = new Uint8Array(operator.sign(Buffer.from(message)));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", signature));
}

async function deriveKeypair(
  masterSeed: Uint8Array,
  index: number,
): Promise<Keypair> {
  const tag = new TextEncoder().encode("pp");
  const idxBytes = new TextEncoder().encode(String(index));
  const buf = new Uint8Array(masterSeed.length + tag.length + idxBytes.length);
  buf.set(masterSeed, 0);
  buf.set(tag, masterSeed.length);
  buf.set(idxBytes, masterSeed.length + tag.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return Keypair.fromRawEd25519Seed(Buffer.from(digest));
}

interface RegisteredPP {
  spec: ProviderSpec;
  index: number;
  publicKey: string;
  secret: string;
  councilId: string;
}

async function setupOnePP(
  spec: ProviderSpec,
  index: number,
  kp: Keypair,
  dashboardJwt: string,
  adminKp: Keypair,
  admin: { jwtForCouncil: () => Promise<string> },
  council: CouncilState,
  // deno-lint-ignore no-explicit-any
  server: any,
): Promise<RegisteredPP> {
  const tag = `[${
    index + 1
  }/${PROVIDERS.length}] ${spec.name} (${spec.jurisdiction})`;
  console.log(`\n=== ${tag} ===`);
  console.log(`  Keypair:    ${kp.publicKey()}`);
  console.log(`  Council:    ${council.name} (${council.id.slice(0, 8)}…)`);

  console.log("  Funding via Friendbot…");
  await fundAccount(kp.publicKey());

  console.log("  Registering PP under operator…");
  const regRes = await fetch(`${PROVIDER_URL}/api/v1/dashboard/pp/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${dashboardJwt}`,
    },
    body: JSON.stringify({
      secretKey: kp.secret(),
      derivationIndex: index,
      label: spec.name,
    }),
  });
  if (!regRes.ok) {
    throw new Error(
      `PP register failed: ${regRes.status} ${await regRes.text()}`,
    );
  }

  console.log("  Submitting join request…");
  const joinPayload = {
    publicKey: kp.publicKey(),
    councilId: council.id,
    label: spec.name,
    contactEmail:
      `${spec.jurisdiction.toLowerCase()}-pp@local-dev.moonlight.test`,
    jurisdictions: [spec.jurisdiction],
    callbackEndpoint: PROVIDER_URL,
  };
  const signedEnvelope = await signJoinEnvelope(joinPayload, kp);

  const joinRes = await fetch(`${PROVIDER_URL}/api/v1/dashboard/council/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${dashboardJwt}`,
    },
    body: JSON.stringify({
      councilUrl: Deno.env.get("COUNCIL_URL") ?? "http://localhost:3015",
      councilId: council.id,
      councilName: council.name,
      ppPublicKey: kp.publicKey(),
      label: spec.name,
      contactEmail:
        `${spec.jurisdiction.toLowerCase()}-pp@local-dev.moonlight.test`,
      signedEnvelope,
    }),
  });
  if (!joinRes.ok) {
    throw new Error(
      `Join request failed: ${joinRes.status} ${await joinRes.text()}`,
    );
  }

  console.log("  Admin approving join…");
  const adminJwt = await admin.jwtForCouncil();
  const listRes = await fetch(
    `${
      Deno.env.get("COUNCIL_URL") ?? "http://localhost:3015"
    }/api/v1/council/provider-requests?councilId=${
      encodeURIComponent(council.id)
    }`,
    { headers: { "Authorization": `Bearer ${adminJwt}` } },
  );
  if (!listRes.ok) {
    throw new Error(
      `List join requests failed: ${listRes.status} ${await listRes.text()}`,
    );
  }
  const { data: requests } = await listRes.json();
  const ourRequest = requests?.find?.(
    (r: { publicKey: string }) => r.publicKey === kp.publicKey(),
  );
  if (!ourRequest) {
    throw new Error(
      `Could not find our join request among ${requests?.length ?? 0} requests`,
    );
  }
  const approveRes = await fetch(
    `${
      Deno.env.get("COUNCIL_URL") ?? "http://localhost:3015"
    }/api/v1/council/provider-requests/${ourRequest.id}/approve`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${adminJwt}` },
    },
  );
  if (!approveRes.ok) {
    throw new Error(
      `Approve failed: ${approveRes.status} ${await approveRes.text()}`,
    );
  }

  console.log("  Admin add_provider on-chain…");
  const addTx = await addProvider(
    server,
    adminKp,
    NETWORK_PASSPHRASE,
    council.id,
    kp.publicKey(),
  );
  if (!verifyEvent(extractEvents(addTx), "provider_added", true).found) {
    throw new Error("provider_added event not emitted");
  }

  console.log("  Waiting for membership ACTIVE…");
  await pollMembershipActive(kp.publicKey(), dashboardJwt);
  console.log("  ✓ ACTIVE");

  return {
    spec,
    index,
    publicKey: kp.publicKey(),
    secret: kp.secret(),
    councilId: council.id,
  };
}

async function main() {
  const startTime = Date.now();
  console.log("\n=== local-dev — Privacy Provider Setup (multi-PP) ===\n");

  console.log("[1/5] Load state from setup-c.sh");
  const state = await loadState();
  const adminKp = Keypair.fromSecret(state.ADMIN_SK);
  console.log(`  Admin:    ${state.ADMIN_PK}`);
  console.log(`  Councils: ${state.councils.length}`);
  console.log(`  PPs to register: ${PROVIDERS.length}`);

  console.log("\n[2/5] Warmup provider-platform");
  await warmupService("provider-platform", PROVIDER_URL);

  // Admin JWT is per-call (council-platform may rotate sessions); cache lazily.
  let cachedAdminJwt: string | null = null;
  const adminCtx = {
    jwtForCouncil: async () => {
      if (cachedAdminJwt) return cachedAdminJwt;
      cachedAdminJwt = await walletAuth(
        state.COUNCIL_URL,
        "/api/v1/admin/auth",
        adminKp,
      );
      return cachedAdminJwt;
    },
  };

  console.log("\n[3/5] Fund admin + operator via Friendbot");
  await fundAccount(state.ADMIN_PK);

  const operatorKp = Keypair.fromSecret(OPERATOR_SECRET);
  console.log(`  Operator: ${operatorKp.publicKey()}`);
  await fundAccount(operatorKp.publicKey());

  const server = createServer(RPC_URL, true);

  console.log(
    "\n[4/5] Operator authenticates once + derives 12 PP keys from masterSeed",
  );
  const operatorJwt = await walletAuth(
    PROVIDER_URL,
    "/api/v1/dashboard/auth",
    operatorKp,
  );
  const masterSeed = await deriveMasterSeed(operatorKp);

  // Derive every PP keypair up front so we can fund + register them as the
  // same operator owns them all.
  const ppKeypairs = await Promise.all(
    PROVIDERS.map((_, i) => deriveKeypair(masterSeed, i)),
  );

  console.log(`\n[5/5] Registering ${PROVIDERS.length} PPs under operator`);
  const registered: RegisteredPP[] = [];
  for (let i = 0; i < PROVIDERS.length; i++) {
    const spec = PROVIDERS[i];
    const council = state.councils[spec.councilIndex];
    if (!council) {
      throw new Error(
        `Provider spec at index ${i} references councilIndex ${spec.councilIndex}, but only ${state.councils.length} councils exist.`,
      );
    }
    registered.push(
      await setupOnePP(
        spec,
        i,
        ppKeypairs[i],
        operatorJwt,
        adminKp,
        adminCtx,
        council,
        server,
      ),
    );
  }

  console.log("\nWriting state…");
  const lines: Record<string, string> = {
    PROVIDER_URL,
    OPERATOR_PK: operatorKp.publicKey(),
    OPERATOR_SK: operatorKp.secret(),
    PP_COUNT: String(registered.length),
  };
  for (const r of registered) {
    const i = r.index + 1;
    lines[`PP_${i}_PK`] = r.publicKey;
    lines[`PP_${i}_SK`] = r.secret;
    lines[`PP_${i}_NAME`] = r.spec.name;
    lines[`PP_${i}_COUNCIL_INDEX`] = String(r.spec.councilIndex + 1);
    lines[`PP_${i}_JURISDICTION`] = r.spec.jurisdiction;
  }
  await appendStateLines(lines);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== PP setup complete in ${elapsed}s ===\n`);
  for (const r of registered) {
    console.log(`  ${r.spec.name} (${r.spec.jurisdiction})`);
    console.log(`    Pubkey:  ${r.publicKey}`);
    console.log(`    Council: ${r.councilId}`);
  }
  console.log(
    "\nNext: ./setup-pay.sh and ./send-loop.sh to drive bundles across the fleet.",
  );
}

main().catch((err) => {
  console.error("\n=== PP setup FAILED ===");
  console.error(err);
  Deno.exit(1);
});
