/**
 * Backend-agnostic validation of normalized OTEL spans.
 *
 * Both verify-otel.ts (Tempo) and verify-otel-local.ts (Jaeger) reduce their
 * backend response to the same NormalizedSpan shape, then call into this
 * helper to run the assertions. Background-trace search differs per backend
 * (TraceQL vs client-side filtering) so it's injected via callback.
 */
import type { E2ETraceData, VerifyOtelResult } from "./verify-otel.ts";

export interface NormalizedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  serviceName: string;
  hasEvents: boolean;
}

export interface ValidateNormalizedSpansConfig {
  allSpans: NormalizedSpan[];
  providerService: string;
  sdkService: string;
  traceData: E2ETraceData;
  /**
   * Backend-specific search for background-service traces (Executor/Verifier/Mempool).
   * Times are in microseconds. Returns the trace count observed before the
   * deadline expires (caller does the polling). Validation calls it once with
   * minExpected=1.
   */
  searchBackgroundTraces: (
    prefixes: string[],
    startEpochUs: number,
    endEpochUs: number,
    minExpected: number,
  ) => Promise<number>;
}

export async function validateNormalizedSpans(
  config: ValidateNormalizedSpansConfig,
): Promise<VerifyOtelResult> {
  const { allSpans, providerService, sdkService, traceData, searchBackgroundTraces } = config;

  const sdkSpans = allSpans.filter((s) => s.serviceName === sdkService);
  const providerSpans = allSpans.filter((s) => s.serviceName === providerService);

  console.log(`\n[3/3] Validating traces...`);
  console.log(`  SDK spans: ${sdkSpans.length}`);
  console.log(`  Provider spans: ${providerSpans.length}`);

  let passed = 0;
  let failed = 0;

  function assertMin(label: string, actual: number, min: number): void {
    if (actual >= min) {
      console.log(`  ✅ ${label}: ${actual} (>= ${min})`);
      passed++;
    } else {
      console.log(`  ❌ ${label}: ${actual} (expected >= ${min})`);
      failed++;
    }
  }

  function byPrefix(spans: NormalizedSpan[], ...prefixes: string[]): number {
    return spans.filter((s) => prefixes.some((p) => s.name.startsWith(p))).length;
  }

  function byName(spans: NormalizedSpan[], ...names: string[]): number {
    return spans.filter((s) => names.includes(s.name)).length;
  }

  // Provider-platform checks
  console.log("\n  Provider-platform:");

  assertMin(
    "Function-level spans (P_*, Bundle.*)",
    byPrefix(providerSpans, "P_", "Bundle."),
    20,
  );
  assertMin(
    "Auth challenge create spans",
    byName(providerSpans, "P_CreateChallenge", "P_CreateChallengeDB", "P_CreateChallengeMemory"),
    4,
  );
  assertMin(
    "Auth challenge verify spans",
    byName(providerSpans, "P_VerifyChallenge", "P_CompareChallenge", "P_GenerateChallengeJWT"),
    4,
  );
  assertMin(
    "P_AddOperationsBundle spans",
    byName(providerSpans, "P_AddOperationsBundle"),
    3,
  );
  assertMin("Bundle.* helper spans", byPrefix(providerSpans, "Bundle."), 9);
  assertMin("Spans with events", providerSpans.filter((s) => s.hasEvents).length, 15);
  assertMin("HTTP request spans", byPrefix(providerSpans, "GET ", "POST "), 5);

  // Background service spans (Executor/Verifier/Mempool) — backend search injected
  const startUs = traceData.startTimeUs;
  const endUs = traceData.endTimeUs + 120 * 1_000_000; // +120s tail
  const bgCount = await searchBackgroundTraces(
    ["Executor.", "Verifier.", "Mempool."],
    startUs,
    endUs,
    1,
  );
  assertMin("Background service traces (Executor/Verifier/Mempool)", bgCount, 1);

  // SDK checks
  console.log("\n  SDK (moonlight-e2e):");

  const e2eStepNames = [
    "e2e.authenticate_alice",
    "e2e.authenticate_bob",
    "e2e.deposit",
    "e2e.prepare_receive",
    "e2e.send",
    "e2e.withdraw",
  ];
  assertMin("E2E step spans (e2e.*)", byName(sdkSpans, ...e2eStepNames), 6);

  for (const name of e2eStepNames) {
    if (byName(sdkSpans, name) === 0) {
      console.log(`  ❌ Missing E2E step span: ${name}`);
      failed++;
    }
  }

  assertMin(
    "Auth E2E spans (auth.*)",
    byName(sdkSpans, "auth.get_challenge", "auth.sign_challenge", "auth.verify_challenge"),
    6,
  );
  assertMin(
    "Bundle E2E spans (bundle.*)",
    byName(sdkSpans, "bundle.submit", "bundle.wait"),
    6,
  );
  assertMin("PrivacyChannel spans", byPrefix(sdkSpans, "PrivacyChannel."), 4);
  assertMin("UtxoBasedAccount spans", byPrefix(sdkSpans, "UtxoBasedAccount."), 8);
  assertMin("SDK spans with events", sdkSpans.filter((s) => s.hasEvents).length, 10);

  // Distributed tracing
  console.log("\n  Distributed tracing:");

  const providerTraceIds = new Set(providerSpans.map((s) => s.traceId));
  const sdkTraceIds = new Set(sdkSpans.map((s) => s.traceId));
  const sharedTraceIds = [...sdkTraceIds].filter((id) => providerTraceIds.has(id));
  const providerOnlyTraceIds = [...providerTraceIds].filter((id) => !sdkTraceIds.has(id));
  assertMin("Shared trace IDs (SDK ↔ Provider)", sharedTraceIds.length, 1);

  // Every provider span triggered by the E2E should share a trace ID with the SDK.
  // Provider-only trace IDs indicate broken context propagation.
  if (providerOnlyTraceIds.length === 0) {
    console.log(`  ✅ All provider traces linked to SDK (0 orphaned trace IDs)`);
    passed++;
  } else {
    console.log(`  ❌ ${providerOnlyTraceIds.length} provider trace ID(s) not linked to SDK`);
    failed++;
  }

  const sdkSpanIds = new Set(sdkSpans.map((s) => s.spanId));
  const providerWithSdkParent = providerSpans.filter((s) => sdkSpanIds.has(s.parentSpanId));
  assertMin("Provider spans with SDK parent", providerWithSdkParent.length, 5);

  console.log(`\n  Results: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}
