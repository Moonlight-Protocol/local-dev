/**
 * network-dashboard-demo
 *
 * Drives a randomized, bounded sequence of activity against a running
 * local-dev stack so the network-dashboard at http://localhost:3040
 * paints councils + PPs + money flow in real time. Four action types,
 * shuffled with dependency-aware fixups:
 *
 *   - create: random Keypair → setup-c.ts with a random JURISDICTION →
 *     contract_initialized fires → dashboard listener adopts the council;
 *     §5 World Map gets a pin in the chosen country.
 *   - join:   pick a known demo council → setup-pp.ts → on-chain
 *     add_provider fires → green "✓ PP joined" card + new PP-dot satellite.
 *   - remove: pick a demo council with ≥ 1 demo PP → call removeProvider
 *     directly via lib/admin.ts → gray "✗ PP left" card + PP-dot vanishes.
 *   - tx:     shells out to send-loop.ts using the canonical PP from
 *     .local-dev-state (the operator the user has open in provider-
 *     console). Drives a deposit + N sends + withdraw cycle through that
 *     PP so the provider-side dashboards light up alongside the network
 *     one. Orange/blue/teal pulses on the PP's council edge.
 *
 * Defaults: 5 create + 8 join + 2 remove + 3 tx actions. Tunable per env
 * (see "Tunables"). The script always exits after the planned sequence
 * completes; it does not loop.
 *
 * Prereqs:
 *   - ./up.sh has run (full stack up)
 *   - For tx actions: ./setup-c.sh + ./setup-pp.sh have run so
 *     .local-dev-state holds an operator PP. Tx actions skip cleanly if
 *     the state file is missing.
 *
 * Usage:
 *   ./network-dashboard-demo.sh
 *     or
 *   deno run --allow-all network-dashboard-demo.ts
 *
 * Tunables (env):
 *   DEMO_NEW_COUNCILS=5      councils to create in this run
 *   DEMO_NEW_PPS=8           PP joins to perform across the new councils
 *   DEMO_REMOVE_PPS=2        PPs to remove from demo councils
 *   DEMO_TX_CYCLES=3         send-loop cycles total
 *   DEMO_TX_COUNT=2          sends per tx cycle (each cycle = deposit + N + withdraw)
 *   DEMO_CANONICAL_TX_RATIO=0.34  fraction of tx cycles routed through the
 *                                canonical PP from .local-dev-state; the
 *                                rest route through a random demo PP
 *   DEMO_SLEEP_MIN_MS=3000   min jitter between actions
 *   DEMO_SLEEP_MAX_MS=8000   max jitter between actions
 *   DEMO_SEED=<int>          seed the action shuffle for reproducibility
 *   DEMO_CANONICAL_STATE=<p> override path to .local-dev-state for tx
 */

import { Keypair, rpc } from "npm:@stellar/stellar-sdk@14.2.0";
import { removeProvider } from "./lib/admin.ts";

const COUNCIL_PLATFORM_URL = Deno.env.get("COUNCIL_URL") ??
  "http://localhost:3015";
const RPC_URL = Deno.env.get("STELLAR_RPC_URL") ??
  "http://localhost:8000/soroban/rpc";
const NETWORK_PASSPHRASE = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ??
  "Standalone Network ; February 2017";
const NEW_COUNCILS = Math.max(
  0,
  Number(Deno.env.get("DEMO_NEW_COUNCILS") ?? "5"),
);
const NEW_PPS = Math.max(0, Number(Deno.env.get("DEMO_NEW_PPS") ?? "8"));
const REMOVE_PPS = Math.max(
  0,
  Number(Deno.env.get("DEMO_REMOVE_PPS") ?? "2"),
);
const TX_CYCLES = Math.max(0, Number(Deno.env.get("DEMO_TX_CYCLES") ?? "3"));
const TX_COUNT_PER_CYCLE = Math.max(
  1,
  Number(Deno.env.get("DEMO_TX_COUNT") ?? "2"),
);
/**
 * Probability that a given tx cycle routes through the canonical PP
 * (the one registered with provider-platform via setup-pp.sh). The rest
 * route through a random demo-spawned PP so the topology shows pulses on
 * multiple council edges, not only "Local Council".
 */
const CANONICAL_TX_RATIO = Math.min(
  1,
  Math.max(0, Number(Deno.env.get("DEMO_CANONICAL_TX_RATIO") ?? "0.34")),
);
const SLEEP_MIN_MS = Number(Deno.env.get("DEMO_SLEEP_MIN_MS") ?? "3000");
const SLEEP_MAX_MS = Number(Deno.env.get("DEMO_SLEEP_MAX_MS") ?? "8000");
const SEED_RAW = Deno.env.get("DEMO_SEED");

const COUNCIL_NAMES = [
  "Atlantic",
  "Pacific",
  "Andean",
  "Nordic",
  "Sahel",
  "Caribbean",
  "Baltic",
  "Mediterranean",
  "Aegean",
  "Adriatic",
  "Caspian",
  "Coral",
  "Sunda",
  "Bering",
  "Arabian",
];
/**
 * Each freshly-created council picks one of these jurisdictions at random
 * so the §5 World Map shows pins around the globe (not just the US).
 * Codes line up with the dashboard's COUNTRIES map in lib/world-map.ts.
 */
const JURISDICTIONS = [
  "US",
  "UY",
  "BR",
  "AR",
  "MX",
  "GB",
  "DE",
  "FR",
  "ES",
  "PT",
  "SE",
  "JP",
  "SG",
  "AU",
  "ZA",
  "NG",
  "KE",
  "IN",
];

/**
 * The "canonical" PP from setup-pp.sh — the operator key the user has open
 * in their provider-console / provider-dashboard. Tx cycles in the demo
 * drive bundles through THIS PP so the provider-side dashboards light up
 * alongside the network-dashboard. Path is the local-dev default state file.
 */
const CANONICAL_STATE_FILE = Deno.env.get("DEMO_CANONICAL_STATE") ??
  new URL("./.local-dev-state", import.meta.url).pathname;
const PP_LABELS = [
  "Aurora",
  "Solstice",
  "Equinox",
  "Zenith",
  "Nadir",
  "Meridian",
  "Tropic",
  "Polar",
  "Vector",
  "Vertex",
  "Orbital",
  "Comet",
  "Quasar",
  "Pulsar",
];

type PP = {
  label: string;
  publicKey: string;
  secretKey: string;
  /**
   * Path to a state file populated by setup-pp.ts (PP_PK/PP_SK + council
   * context). Kept on disk so the tx action can hand the same file to
   * send-loop.ts without re-deriving anything.
   */
  stateFile: string;
};

type Council = {
  name: string;
  adminPk: string;
  adminSk: string;
  councilId: string;
  channelId: string;
  assetId: string;
  pps: PP[];
};

const councils: Council[] = [];
let nameCursor = 0;
let ppCursor = 0;

function nextCouncilName(): string {
  const base = COUNCIL_NAMES[nameCursor % COUNCIL_NAMES.length];
  const rev = Math.floor(nameCursor / COUNCIL_NAMES.length);
  nameCursor++;
  return rev === 0 ? `${base} Council` : `${base} Council ${rev + 1}`;
}

function nextPpLabel(): string {
  const out = PP_LABELS[ppCursor % PP_LABELS.length];
  ppCursor++;
  return `${out} PP`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function parseStateFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function runChild(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-all", ...args],
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

async function createCouncil(): Promise<Council | null> {
  const adminSk = Keypair.random().secret();
  const name = nextCouncilName();
  const jurisdiction = pickRandom(JURISDICTIONS);
  const stateFile = `/tmp/.nd-demo-${crypto.randomUUID()}`;
  console.log(
    `\n[demo] creating council: ${name} (jurisdiction=${jurisdiction})`,
  );
  const { code, stderr } = await runChild(["setup-c.ts"], {
    ADMIN_SECRET: adminSk,
    COUNCIL_NAME: name,
    STATE_FILE: stateFile,
    JURISDICTION: jurisdiction,
    PATH: Deno.env.get("PATH") ?? "",
    HOME: Deno.env.get("HOME") ?? "",
  });
  if (code !== 0) {
    console.error(
      `[demo] setup-c failed for ${name} (exit ${code}):`,
      stderr.slice(-400),
    );
    return null;
  }
  let stateText = "";
  try {
    stateText = await Deno.readTextFile(stateFile);
  } catch {
    console.error(`[demo] setup-c produced no state file for ${name}`);
    return null;
  }
  await Deno.remove(stateFile).catch(() => {});
  const state = parseStateFile(stateText);
  if (!state.COUNCIL_ID || !state.ADMIN_SK) {
    console.error(`[demo] state file missing keys for ${name}:`, state);
    return null;
  }
  const c: Council = {
    name,
    adminPk: state.ADMIN_PK ?? Keypair.fromSecret(state.ADMIN_SK).publicKey(),
    adminSk: state.ADMIN_SK,
    councilId: state.COUNCIL_ID,
    channelId: state.CHANNEL_ID ?? "",
    assetId: state.ASSET_ID ?? "",
    pps: [],
  };
  console.log(
    `[demo]   ✓ ${name} → ${c.councilId.slice(0, 12)}…`,
  );
  return c;
}

async function joinPP(council: Council): Promise<boolean> {
  const ppSk = Keypair.random().secret();
  const ppPk = Keypair.fromSecret(ppSk).publicKey();
  const label = nextPpLabel();
  // State file kept on disk for later reuse by removeRandomPP / runTxCycle —
  // setup-pp.ts appends PP_PK / PP_SK / PROVIDER_URL after a successful join,
  // and send-loop.ts can consume the resulting file as-is.
  const stateFile = `/tmp/.nd-demo-pp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(
    stateFile,
    [
      `ADMIN_PK=${council.adminPk}`,
      `ADMIN_SK=${council.adminSk}`,
      `COUNCIL_ID=${council.councilId}`,
      `CHANNEL_ID=${council.channelId}`,
      `ASSET_ID=${council.assetId}`,
      `COUNCIL_URL=${COUNCIL_PLATFORM_URL}`,
      "",
    ].join("\n"),
  );
  console.log(`\n[demo] joining ${label} to ${council.name}…`);
  const { code, stderr } = await runChild(["setup-pp.ts"], {
    STATE_FILE: stateFile,
    PP_SECRET: ppSk,
    PP_LABEL: label,
    PATH: Deno.env.get("PATH") ?? "",
    HOME: Deno.env.get("HOME") ?? "",
  });
  if (code !== 0) {
    console.error(
      `[demo] setup-pp failed for ${label} on ${council.name} (exit ${code}):`,
      stderr.slice(-400),
    );
    await Deno.remove(stateFile).catch(() => {});
    return false;
  }
  council.pps.push({ label, publicKey: ppPk, secretKey: ppSk, stateFile });
  console.log(
    `[demo]   ✓ ${label} joined ${council.name} (${council.pps.length} PP${
      council.pps.length === 1 ? "" : "s"
    } total)`,
  );
  return true;
}

let sharedServer: rpc.Server | null = null;
function getRpc(): rpc.Server {
  if (!sharedServer) {
    sharedServer = new rpc.Server(RPC_URL, {
      allowHttp: RPC_URL.startsWith("http://"),
    });
  }
  return sharedServer;
}

async function removeRandomPP(): Promise<boolean> {
  const candidates = councils.filter((c) => c.pps.length > 0);
  if (candidates.length === 0) {
    console.warn("[demo] remove skipped — no councils with PPs yet");
    return false;
  }
  const council = pickRandom(candidates);
  const idx = Math.floor(rng() * council.pps.length);
  const pp = council.pps[idx];
  console.log(`\n[demo] removing ${pp.label} from ${council.name}…`);
  try {
    const admin = Keypair.fromSecret(council.adminSk);
    await removeProvider(
      getRpc(),
      admin,
      NETWORK_PASSPHRASE,
      council.councilId,
      pp.publicKey,
    );
  } catch (err) {
    console.error(
      `[demo] remove_provider failed for ${pp.label} on ${council.name}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
  council.pps.splice(idx, 1);
  await Deno.remove(pp.stateFile).catch(() => {});
  console.log(
    `[demo]   ✓ ${pp.label} removed from ${council.name} (${council.pps.length} PP${
      council.pps.length === 1 ? "" : "s"
    } remain)`,
  );
  return true;
}

async function canonicalAvailable(): Promise<boolean> {
  try {
    await Deno.stat(CANONICAL_STATE_FILE);
    return true;
  } catch {
    return false;
  }
}

async function runTxCycle(): Promise<boolean> {
  // Per-cycle coin flip: with probability CANONICAL_TX_RATIO, drive the
  // tx through the canonical PP (the operator key from setup-pp.sh, open
  // in the user's provider-console). Otherwise pick a random demo PP with
  // a valid state file. If the chosen path is unavailable, fall through
  // to the other.
  const demoPPs: Array<{ council: Council; pp: PP }> = [];
  for (const c of councils) {
    for (const pp of c.pps) demoPPs.push({ council: c, pp });
  }
  const hasCanonical = await canonicalAvailable();
  const wantCanonical = rng() < CANONICAL_TX_RATIO;
  let useCanonical: boolean;
  if (wantCanonical && hasCanonical) useCanonical = true;
  else if (!wantCanonical && demoPPs.length > 0) useCanonical = false;
  else if (hasCanonical) useCanonical = true;
  else if (demoPPs.length > 0) useCanonical = false;
  else {
    console.warn(
      "[demo] tx skipped — no canonical state file and no demo PPs yet.",
    );
    return false;
  }

  let stateFile: string;
  let label: string;
  if (useCanonical) {
    stateFile = CANONICAL_STATE_FILE;
    label = "canonical PP";
  } else {
    const pick = demoPPs[Math.floor(rng() * demoPPs.length)];
    stateFile = pick.pp.stateFile;
    label = `${pick.pp.label} on ${pick.council.name}`;
  }

  console.log(
    `\n[demo] running tx cycle via ${label} (count=${TX_COUNT_PER_CYCLE})…`,
  );
  const { code, stderr } = await runChild(["send-loop.ts"], {
    STATE_FILE: stateFile,
    COUNT: String(TX_COUNT_PER_CYCLE),
    INTERVAL_MS: "800",
    SEND_AMOUNT: "1",
    PATH: Deno.env.get("PATH") ?? "",
    HOME: Deno.env.get("HOME") ?? "",
  });
  if (code !== 0) {
    console.error(
      `[demo] send-loop failed via ${label} (exit ${code}):`,
      stderr.slice(-400),
    );
    return false;
  }
  console.log(
    `[demo]   ✓ tx cycle complete via ${label} (deposit + ${TX_COUNT_PER_CYCLE} sends + withdraw)`,
  );
  return true;
}

/**
 * Build the planned action list and shuffle it.
 *
 * Four action types with execution-time dependencies:
 *   - create : no dependency
 *   - join   : at least one council in the demo pool
 *   - remove : at least one demo council with ≥ 1 demo PP
 *   - tx     : `.local-dev-state` exists (the canonical PP from setup-pp.sh)
 *
 * tx is independent of the demo's churn — it always shells out to send-loop
 * against the operator PP the user already has registered with provider-
 * platform. The dependency walk only reorders create→join→remove chains.
 */
type Action = "create" | "join" | "remove" | "tx";

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = SEED_RAW ? mulberry32(Number(SEED_RAW)) : Math.random;

function shufflePlan(): Action[] {
  const plan: Action[] = [
    ...Array<Action>(NEW_COUNCILS).fill("create"),
    ...Array<Action>(NEW_PPS).fill("join"),
    ...Array<Action>(REMOVE_PPS).fill("remove"),
    ...Array<Action>(TX_CYCLES).fill("tx"),
  ];
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  // Pull dependents forward when their prerequisites haven't run yet.
  // Pass 1: ensure each join has a preceding create.
  // Pass 2: ensure each remove/tx has BOTH a preceding create AND join.
  const findAndSwap = (i: number, want: Action): boolean => {
    for (let j = i + 1; j < plan.length; j++) {
      if (plan[j] === want) {
        [plan[i], plan[j]] = [plan[j], plan[i]];
        return true;
      }
    }
    return false;
  };
  let creates = 0;
  for (let i = 0; i < plan.length; i++) {
    if (plan[i] === "create") {
      creates++;
      continue;
    }
    if (creates === 0) findAndSwap(i, "create");
    if (plan[i] === "create") creates++;
  }
  let pps = 0;
  for (let i = 0; i < plan.length; i++) {
    if (plan[i] === "join") {
      pps++;
      continue;
    }
    if (plan[i] === "remove" && pps === 0) {
      findAndSwap(i, "join");
      if (plan[i] === "join") pps++;
    }
  }
  return plan;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function pickWithFewestPPs(arr: Council[]): Council {
  // Bias joins toward councils that don't have a PP yet so the topology
  // spreads even with a small NEW_PPS budget.
  let best = arr[0];
  for (const c of arr) if (c.pps.length < best.pps.length) best = c;
  // 60% pick the leanest; 40% truly random for variety.
  return rng() < 0.6 ? best : pickRandom(arr);
}

const plan = shufflePlan();
console.log("[demo] network-dashboard-demo starting.");
console.log(`[demo] dashboard: http://localhost:3040`);
console.log(
  `[demo] plan: ${NEW_COUNCILS} create + ${NEW_PPS} join + ${REMOVE_PPS} remove + ${TX_CYCLES} tx = ${plan.length} actions`,
);
console.log(`[demo] order: ${plan.map((a) => a[0]).join("")}`);

const successByAction: Record<Action, number> = {
  create: 0,
  join: 0,
  remove: 0,
  tx: 0,
};
let failures = 0;
const start = Date.now();

for (let i = 0; i < plan.length; i++) {
  const action = plan[i];
  const tag = `[demo iter ${i + 1}/${plan.length}]`;
  try {
    let ok = false;
    if (action === "create") {
      const c = await createCouncil();
      if (c) {
        councils.push(c);
        ok = true;
      }
    } else if (action === "join") {
      if (councils.length === 0) {
        console.warn(`${tag} skipping join — no councils in pool`);
      } else {
        const c = pickWithFewestPPs(councils);
        ok = await joinPP(c);
      }
    } else if (action === "remove") {
      ok = await removeRandomPP();
    } else if (action === "tx") {
      ok = await runTxCycle();
    }
    if (ok) successByAction[action]++;
    else failures++;
  } catch (err) {
    console.error(`${tag} threw:`, err);
    failures++;
  }
  if (i < plan.length - 1) {
    const wait = SLEEP_MIN_MS +
      Math.floor(rng() * (SLEEP_MAX_MS - SLEEP_MIN_MS));
    console.log(`${tag} sleeping ${wait}ms…`);
    await sleep(wait);
  }
}

// Clean up PP state files we kept around for tx reuse.
for (const c of councils) {
  for (const pp of c.pps) await Deno.remove(pp.stateFile).catch(() => {});
}

const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
console.log("");
console.log("[demo] sequence complete:");
console.log(
  `[demo]   created councils: ${successByAction.create}/${NEW_COUNCILS}`,
);
console.log(`[demo]   joined PPs:       ${successByAction.join}/${NEW_PPS}`);
console.log(
  `[demo]   removed PPs:      ${successByAction.remove}/${REMOVE_PPS}`,
);
console.log(`[demo]   tx cycles:        ${successByAction.tx}/${TX_CYCLES}`);
console.log(`[demo]   failures:         ${failures}`);
console.log(`[demo]   elapsed:          ${elapsedSec}s`);
