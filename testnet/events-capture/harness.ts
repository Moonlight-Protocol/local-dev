/**
 * Events-capture harness — orchestrator + CLI.
 *
 * Wraps a testnet flow script (testnet/main.ts or lifecycle/testnet-verify.ts):
 *   1. Acquires the operator dashboard JWT (used to subscribe to per-PP WS).
 *   2. Opens the network-wide WS subscriber (no auth) and awaits open.
 *   3. Schedules the per-PP WS open in the background — it polls for the
 *      PP to appear in provider-platform DB then opens.
 *   4. Runs the script's exported `main()` to completion.
 *   5. Tails for EVENTS_CAPTURE_TAIL_MS (default 5000) so trailing async
 *      emits (verifier confirmations, watcher polls) land in the capture
 *      buffers.
 *   6. Closes both WS sockets, asserts captured vs the script's
 *      EXPECTED_EVENTS, writes the run report, exits 0/1.
 *
 * CLI:
 *   deno run --allow-all harness.ts \
 *     --script testnet-main | lifecycle-testnet-verify \
 *     [--master-secret <S...>] \
 *     [--provider-url <http://...>] \
 *     [--network-dashboard-url <http://...>] \
 *     [--tail-ms <N>]
 *
 * Reads env defaults: MASTER_SECRET, PROVIDER_URL,
 * NETWORK_DASHBOARD_PLATFORM_URL, EVENTS_CAPTURE_TAIL_MS.
 *
 * Exit codes: 0 = pass, 1 = fail / assert mismatch, 2 = harness error
 * (subscriber didn't open, script threw before completion, etc.).
 */
import type { Keypair } from "stellar-sdk";
import { Buffer } from "node:buffer";
import {
  deriveKeypair,
  masterSeedFromSecret,
  ROLES,
} from "../../lib/master-seed.ts";
import { openNetworkSubscriber, openPerPpSubscriber } from "./subscribe.ts";
import { assertCaptured } from "./assert.ts";
import { makeRunId, writeReport } from "./report.ts";
import type { CapturedEvent, ExpectedEvents, RunReport } from "./types.ts";

const SUPPORTED_SCRIPTS = {
  "testnet-main": "../main.ts",
  "lifecycle-testnet-verify": "../../lifecycle/testnet-verify.ts",
} as const;

type ScriptName = keyof typeof SUPPORTED_SCRIPTS;

interface LoadedScriptModule {
  EXPECTED_EVENTS: ExpectedEvents;
  main: () => Promise<void>;
}

interface HarnessOpts {
  scriptName: ScriptName;
  masterSecret: string;
  providerUrl: string;
  networkDashboardUrl: string;
  tailMs: number;
}

const DEFAULT_TAIL_MS = 5000;

async function main(): Promise<void> {
  const opts = parseArgs();
  const startedAtIso = new Date().toISOString();

  // 1. Dynamic-import the target script so we can read its EXPECTED_EVENTS
  // and call its exported main() in-process.
  const scriptModule = await loadScript(opts.scriptName);

  // 2. Derive the operator (PP) keypair and acquire a dashboard JWT —
  // matches what the script does internally via lib/master-seed + walletAuth.
  const seed = await masterSeedFromSecret(opts.masterSecret);
  const ppOperator = await deriveKeypair(seed, ROLES.PP, 0);
  const ppPublicKey = ppOperator.publicKey();
  console.log(
    `[events-capture] script=${opts.scriptName} ppPublicKey=${ppPublicKey}`,
  );

  // Sanity: the script's EXPECTED_EVENTS.perPp is keyed by ppPublicKey at
  // the placeholder slot "$PP_PK". Substitute the real value before assert.
  const expectedResolved = resolvePlaceholders(
    scriptModule.EXPECTED_EVENTS,
    {
      $PP_PK: ppPublicKey,
      $ALICE_PK: (await deriveKeypair(seed, ROLES.ALICE, 0)).publicKey(),
      $BOB_PK: (await deriveKeypair(seed, ROLES.BOB, 0)).publicKey(),
    },
  );

  const operatorJwt = await acquireOperatorJwt(opts.providerUrl, ppOperator);

  // 3. Open subscribers. Network opens immediately; per-PP polls until the
  // script's PP-register step lands in the DB.
  const networkSub = openNetworkSubscriber(
    `${opts.networkDashboardUrl}/api/v1/network/ws`,
  );
  const perPpSub = openPerPpSubscriber({
    providerUrl: opts.providerUrl,
    ppPublicKey,
    operatorJwt,
  });

  // Capture per-PP and network subscriber open errors without crashing the
  // entire run — surface them in the diff instead.
  const subscriberOpenErrors: string[] = [];
  perPpSub.ready.catch((err: Error) => {
    subscriberOpenErrors.push(`perPp:${ppPublicKey}: ${err.message}`);
  });
  networkSub.ready.catch((err: Error) => {
    subscriberOpenErrors.push(`network: ${err.message}`);
  });

  // Wait for the network WS to open before letting the script start, so
  // we don't miss early `provider_added` / `channel_*` events.
  await networkSub.ready;

  // 4. Run the script's main(). It is responsible for the PP-register
  // step that unblocks the per-PP WS open loop.
  let scriptError: Error | null = null;
  try {
    await scriptModule.main();
  } catch (err) {
    scriptError = err instanceof Error ? err : new Error(String(err));
  }

  // 5. Post-script tail window. Lets executor + verifier + watcher trailing
  // emits land in the capture buffer.
  if (!scriptError) {
    console.log(
      `[events-capture] tail window ${opts.tailMs}ms (set EVENTS_CAPTURE_TAIL_MS to override)`,
    );
    await sleep(opts.tailMs);
  } else {
    console.error(
      `[events-capture] script threw — skipping tail window. error: ${scriptError.message}`,
    );
  }

  // 6. Close subscribers, run assertions, write report.
  await Promise.all([networkSub.close(), perPpSub.close()]);

  const capturedBySubscriber: Record<string, CapturedEvent[]> = {
    [perPpSub.subscriberId]: perPpSub.captured,
    [networkSub.subscriberId]: networkSub.captured,
  };

  const assertion = assertCaptured({
    expected: expectedResolved,
    capturedBySubscriber,
  });

  const report: RunReport = {
    scriptName: opts.scriptName,
    runId: makeRunId(opts.scriptName),
    startedAtIso,
    finishedAtIso: new Date().toISOString(),
    tailMs: opts.tailMs,
    pass: assertion.pass && scriptError === null &&
      subscriberOpenErrors.length === 0,
    perSubscriber: assertion.perSubscriber,
  };

  await writeReport(report);

  if (scriptError) {
    console.error(
      `[events-capture] script main() threw: ${scriptError.message}`,
    );
    Deno.exit(2);
  }
  if (subscriberOpenErrors.length > 0) {
    for (const e of subscriberOpenErrors) {
      console.error(`[events-capture] subscriber error: ${e}`);
    }
    Deno.exit(2);
  }
  Deno.exit(report.pass ? 0 : 1);
}

async function loadScript(scriptName: ScriptName): Promise<LoadedScriptModule> {
  const relativePath = SUPPORTED_SCRIPTS[scriptName];
  const moduleUrl = new URL(relativePath, import.meta.url).href;
  const mod = await import(moduleUrl);
  if (typeof mod.main !== "function") {
    throw new Error(
      `Script ${scriptName} does not export a main() function (import: ${moduleUrl})`,
    );
  }
  if (
    !mod.EXPECTED_EVENTS || typeof mod.EXPECTED_EVENTS !== "object" ||
    !Array.isArray(mod.EXPECTED_EVENTS.network)
  ) {
    throw new Error(
      `Script ${scriptName} does not export a valid EXPECTED_EVENTS const`,
    );
  }
  return {
    EXPECTED_EVENTS: mod.EXPECTED_EVENTS as ExpectedEvents,
    main: mod.main as () => Promise<void>,
  };
}

/**
 * Authenticates the operator wallet against /api/v1/dashboard/auth using
 * the same challenge/sign/verify shape the testnet scripts use
 * (testnet/main.ts:90). The resulting JWT is the operator dashboard token
 * the per-PP WS auth check (PpRepository.findByPublicKeyAndOwner) needs.
 */
async function acquireOperatorJwt(
  providerUrl: string,
  ppOperator: Keypair,
): Promise<string> {
  const route = "/api/v1/dashboard/auth";
  const challengeRes = await fetch(`${providerUrl}${route}/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: ppOperator.publicKey() }),
  });
  if (!challengeRes.ok) {
    throw new Error(
      `dashboard auth challenge failed: ${challengeRes.status} ${await challengeRes
        .text()}`,
    );
  }
  const { data: { nonce } } = await challengeRes.json();
  const nonceBytes = Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0));
  const sig = ppOperator.sign(Buffer.from(nonceBytes));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
  const verifyRes = await fetch(`${providerUrl}${route}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nonce,
      signature,
      publicKey: ppOperator.publicKey(),
    }),
  });
  if (!verifyRes.ok) {
    throw new Error(
      `dashboard auth verify failed: ${verifyRes.status} ${await verifyRes
        .text()}`,
    );
  }
  const { data: { token } } = await verifyRes.json();
  return token as string;
}

/**
 * Walk the expected events tree and substitute `$PP_PK` / `$ALICE_PK` /
 * `$BOB_PK` placeholders with the runtime values. Also re-keys the perPp
 * record's outer key (which uses `$PP_PK` as a placeholder).
 */
function resolvePlaceholders(
  expected: ExpectedEvents,
  subs: Record<string, string>,
): ExpectedEvents {
  const resolveStr = (s: string): string => s in subs ? subs[s] : s;
  const resolveValue = (v: unknown): unknown => {
    if (typeof v === "string") return resolveStr(v);
    if (Array.isArray(v)) return v.map(resolveValue);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = resolveValue(val);
      }
      return out;
    }
    return v;
  };

  const network = (expected.network ?? []).map((e) =>
    resolveValue(e) as typeof e
  );
  const perPp: Record<string, ExpectedEvents["perPp"][string]> = {};
  for (const [key, list] of Object.entries(expected.perPp ?? {})) {
    perPp[resolveStr(key)] = list.map((e) => resolveValue(e) as typeof e);
  }
  return { perPp, network };
}

function parseArgs(): HarnessOpts {
  const args = Deno.args;
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag.startsWith("--") && i + 1 < args.length) {
      flags[flag.slice(2)] = args[++i];
    }
  }
  const scriptArg = flags.script;
  if (!scriptArg || !(scriptArg in SUPPORTED_SCRIPTS)) {
    throw new Error(
      `--script must be one of: ${Object.keys(SUPPORTED_SCRIPTS).join(", ")}`,
    );
  }
  const masterSecret = flags["master-secret"] ?? Deno.env.get("MASTER_SECRET");
  if (!masterSecret) {
    throw new Error(
      `harness requires MASTER_SECRET (set the env var or pass --master-secret) so the operator/alice/bob keypairs are deterministic`,
    );
  }
  const providerUrl = flags["provider-url"] ?? Deno.env.get("PROVIDER_URL") ??
    "http://localhost:3010";
  const networkDashboardUrl = flags["network-dashboard-url"] ??
    Deno.env.get("NETWORK_DASHBOARD_PLATFORM_URL") ?? "http://localhost:3035";
  const tailMsRaw = flags["tail-ms"] ??
    Deno.env.get("EVENTS_CAPTURE_TAIL_MS") ?? String(DEFAULT_TAIL_MS);
  const tailMs = Number(tailMsRaw);
  if (!Number.isFinite(tailMs) || tailMs < 0) {
    throw new Error(
      `EVENTS_CAPTURE_TAIL_MS / --tail-ms must be a non-negative number, got ${tailMsRaw}`,
    );
  }
  return {
    scriptName: scriptArg as ScriptName,
    masterSecret,
    providerUrl,
    networkDashboardUrl,
    tailMs,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

if (import.meta.main) {
  await main();
}
