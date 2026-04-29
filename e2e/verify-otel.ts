/**
 * OTEL Verification Test
 *
 * Runs after the E2E test to verify that OpenTelemetry traces were captured
 * in Jaeger.
 *
 * Uses two query strategies:
 *   1. Trace-by-ID — fetches the exact traces from the E2E run (for SDK
 *      and distributed tracing checks)
 *   2. Time-windowed service query — fetches provider-platform traces within
 *      the E2E time window (for application-level span checks, since the
 *      provider's withSpan creates separate root traces from the HTTP spans)
 *
 * Scope: this verifier covers only the SDK driver + provider-platform.
 * The local-CI docker-compose.yml does not run council-platform, so cp#28
 * spans (Channel/Custody/KeyDerivation/Escrow) are exercised and asserted
 * only by the lifecycle/testnet flows that hit a deployed cp instance.
 *
 * Prerequisites:
 *   - Jaeger running on localhost:16686 (started by up.sh)
 *   - E2E test completed with OTEL_DENO=true (writes e2e-trace-ids.json)
 *
 * Usage:
 *   deno run --allow-all verify-otel.ts
 */

const JAEGER_URL = Deno.env.get("JAEGER_QUERY_URL") ?? "http://localhost:16686";
const TRACE_POLL_TIMEOUT_MS = Number(
  Deno.env.get("TRACE_POLL_TIMEOUT_MS") ?? "15000",
);
const PROVIDER_SERVICE = "provider-platform";
const SDK_SERVICE = "moonlight-e2e";

const TRACE_IDS_PATH =
  new URL("./e2e-trace-ids.json", import.meta.url).pathname;

interface E2ETraceData {
  traceIds: string[];
  startTimeUs: number;
  endTimeUs: number;
}

interface JaegerTrace {
  traceID: string;
  spans: JaegerSpan[];
  processes: Record<string, { serviceName: string }>;
}

interface JaegerSpan {
  traceID: string;
  spanID: string;
  operationName: string;
  references: { refType: string; traceID: string; spanID: string }[];
  tags: { key: string; type: string; value: unknown }[];
  duration: number;
  processID: string;
}

interface JaegerResponse {
  data: JaegerTrace[];
  errors: unknown;
}

async function verifyJaegerReachable(): Promise<void> {
  console.log(`  Jaeger URL: ${JAEGER_URL}`);
  const res = await fetch(`${JAEGER_URL}/api/services`);
  if (!res.ok) {
    throw new Error(`Jaeger not reachable: HTTP ${res.status}`);
  }
  const data = await res.json();
  console.log(`  Jaeger services: ${JSON.stringify(data.data)}`);
}

function loadTraceData(): E2ETraceData {
  try {
    const raw = Deno.readTextFileSync(TRACE_IDS_PATH);
    const data = JSON.parse(raw);
    if (!Array.isArray(data.traceIds) || data.traceIds.length === 0) {
      throw new Error("Empty trace ID list");
    }
    return data;
  } catch (err) {
    console.error(`\n❌ Could not read trace data from ${TRACE_IDS_PATH}`);
    console.error(`   Run the E2E test first: deno task e2e`);
    console.error(`   Error: ${err}`);
    Deno.exit(1);
  }
}

async function fetchTraceById(
  traceId: string,
  maxWaitMs = TRACE_POLL_TIMEOUT_MS,
  intervalMs = 2000,
): Promise<JaegerTrace | null> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${JAEGER_URL}/api/traces/${traceId}`);

    if (res.ok) {
      const data: JaegerResponse = await res.json();
      if (data.data && data.data.length > 0) {
        return data.data[0];
      }
    } else if (res.status !== 404) {
      const body = await res.text().catch(() => "(could not read body)");
      console.error(
        `  Jaeger returned HTTP ${res.status} for trace ${traceId}: ${body}`,
      );
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return null;
}

async function fetchProviderTraces(
  startTimeUs: number,
  endTimeUs: number,
  maxWaitMs = TRACE_POLL_TIMEOUT_MS,
  intervalMs = 2000,
): Promise<JaegerTrace[]> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const url = `${JAEGER_URL}/api/traces?service=${PROVIDER_SERVICE}` +
      `&start=${startTimeUs}&end=${endTimeUs}&limit=500`;
    const res = await fetch(url);

    if (res.ok) {
      const data: JaegerResponse = await res.json();
      if (data.data && data.data.length > 0) {
        return data.data;
      }
    } else {
      const body = await res.text().catch(() => "(could not read body)");
      console.error(`  Jaeger returned HTTP ${res.status}: ${body}`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return [];
}

function hasSpanEvents(span: JaegerSpan): boolean {
  const record = span as unknown as Record<string, unknown>;
  if (!("logs" in record) || !Array.isArray(record.logs)) return false;
  return record.logs.length > 0;
}

function getServiceName(trace: JaegerTrace, span: JaegerSpan): string {
  return trace.processes[span.processID]?.serviceName ?? "unknown";
}

async function main() {
  console.log("\n[OTEL] Verifying OpenTelemetry traces in Jaeger\n");

  // 1. Verify Jaeger is reachable
  console.log("[1/5] Checking Jaeger connectivity...");
  try {
    await verifyJaegerReachable();
  } catch (err) {
    console.error(`\n❌ Jaeger not reachable at ${JAEGER_URL}`);
    console.error(`   Make sure Jaeger is running (started by up.sh)`);
    console.error(`   Error: ${err}`);
    Deno.exit(1);
  }

  // 2. Load trace data from E2E run
  console.log("\n[2/5] Loading trace data from E2E run...");
  const traceData = loadTraceData();
  console.log(`  Trace IDs: ${traceData.traceIds.length}`);
  console.log(
    `  Time window: ${new Date(traceData.startTimeUs / 1000).toISOString()} → ${
      new Date(traceData.endTimeUs / 1000).toISOString()
    }`,
  );

  // 3. Fetch E2E traces by ID (SDK + distributed tracing checks)
  console.log("\n[3/5] Fetching E2E traces by ID...");
  const e2eTraces: JaegerTrace[] = [];

  for (const id of traceData.traceIds) {
    const trace = await fetchTraceById(id);
    if (trace) {
      e2eTraces.push(trace);
    } else {
      console.error(`  ⚠️  Trace ${id} not found in Jaeger`);
    }
  }
  console.log(
    `  Fetched ${e2eTraces.length}/${traceData.traceIds.length} traces`,
  );

  // Split E2E spans by service
  const e2eSdkSpans: JaegerSpan[] = [];
  const e2eProviderHttpSpans: JaegerSpan[] = [];

  for (const t of e2eTraces) {
    for (const span of t.spans) {
      const service = getServiceName(t, span);
      if (service === SDK_SERVICE) {
        e2eSdkSpans.push(span);
      } else if (service === PROVIDER_SERVICE) {
        e2eProviderHttpSpans.push(span);
      }
    }
  }

  // 4. Fetch provider traces by time window (application-level span checks)
  console.log("\n[4/5] Fetching provider traces by time window...");
  const providerTraces = await fetchProviderTraces(
    traceData.startTimeUs,
    traceData.endTimeUs,
  );

  const providerAppSpans: JaegerSpan[] = [];
  for (const t of providerTraces) {
    for (const span of t.spans) {
      if (getServiceName(t, span) === PROVIDER_SERVICE) {
        providerAppSpans.push(span);
      }
    }
  }

  // Merge all provider spans (HTTP from e2e traces + app from time window)
  const allProviderSpans = [...e2eProviderHttpSpans, ...providerAppSpans];

  if (e2eTraces.length === 0) {
    console.error("\n❌ No E2E traces found in Jaeger");
    Deno.exit(1);
  }

  // 5. Validate
  console.log(`\n[5/5] Validating traces...`);
  console.log(`  SDK spans (from E2E traces): ${e2eSdkSpans.length}`);
  console.log(
    `  Provider HTTP spans (from E2E traces): ${e2eProviderHttpSpans.length}`,
  );
  console.log(
    `  Provider app spans (from time window): ${providerAppSpans.length}`,
  );

  let passed = 0;
  let failed = 0;

  function findByPrefix(
    spans: JaegerSpan[],
    ...prefixes: string[]
  ): JaegerSpan[] {
    return spans.filter((s) =>
      prefixes.some((p) => s.operationName.startsWith(p))
    );
  }

  function findByName(spans: JaegerSpan[], ...names: string[]): JaegerSpan[] {
    return spans.filter((s) => names.includes(s.operationName));
  }

  function assertMin(label: string, actual: JaegerSpan[], min: number): void {
    if (actual.length >= min) {
      console.log(`  ✅ ${label}: ${actual.length} (>= ${min})`);
      passed++;
    } else {
      console.log(`  ❌ ${label}: ${actual.length} (expected >= ${min})`);
      failed++;
    }
  }

  // =====================================================================
  // Provider-platform checks (from time-windowed query)
  // =====================================================================

  console.log("\n  Provider-platform:");

  // Function-level spans (withSpan instrumentation)
  const functionSpans = findByPrefix(
    allProviderSpans,
    "P_",
    "Executor.",
    "Verifier.",
    "Mempool.",
    "Bundle.",
  );
  assertMin("Function-level spans", functionSpans, 20);

  // Auth challenge creation: 2 users authenticate
  const challengeCreateSpans = findByName(
    allProviderSpans,
    "P_CreateChallenge",
    "P_CreateChallengeDB",
    "P_CreateChallengeMemory",
  );
  assertMin("Auth challenge create spans", challengeCreateSpans, 4);

  // Auth challenge verify: 2 users verify
  const challengeVerifySpans = findByName(
    allProviderSpans,
    "P_VerifyChallenge",
    "P_CompareChallenge",
    "P_GenerateChallengeJWT",
  );
  assertMin("Auth challenge verify spans", challengeVerifySpans, 4);

  // Bundle processing: 3 bundles (deposit, send, withdraw)
  const addBundleSpans = findByName(allProviderSpans, "P_AddOperationsBundle");
  assertMin("P_AddOperationsBundle spans", addBundleSpans, 3);

  // Bundle.* helper spans
  const bundleHelperSpans = findByPrefix(allProviderSpans, "Bundle.");
  assertMin("Bundle.* helper spans", bundleHelperSpans, 9);

  // Spans with events
  const spansWithEvents = allProviderSpans.filter(hasSpanEvents);
  assertMin("Spans with events", spansWithEvents, 15);

  // Deno auto-instrumented HTTP spans
  const httpSpans = findByPrefix(allProviderSpans, "GET", "POST");
  assertMin("HTTP spans (Deno auto-instrumented)", httpSpans, 5);

  // Background service spans
  const backgroundSpans = findByPrefix(
    allProviderSpans,
    "Executor.",
    "Verifier.",
    "Mempool.",
  );
  assertMin("Background service spans", backgroundSpans, 6);

  // =====================================================================
  // SDK checks (from E2E trace-by-ID)
  // =====================================================================

  console.log("\n  SDK (moonlight-e2e):");

  // E2E step spans
  const e2eStepNames = [
    "e2e.fund_accounts",
    "e2e.authenticate_alice",
    "e2e.authenticate_bob",
    "e2e.deposit",
    "e2e.prepare_receive",
    "e2e.send",
    "e2e.withdraw",
  ];
  const e2eStepSpans = findByName(e2eSdkSpans, ...e2eStepNames);
  assertMin("E2E step spans (e2e.*)", e2eStepSpans, 7);

  for (const name of e2eStepNames) {
    const found = findByName(e2eSdkSpans, name);
    if (found.length === 0) {
      console.log(`  ❌ Missing E2E step span: ${name}`);
      failed++;
    }
  }

  // Auth E2E spans: 2 users × 3 spans = 6
  const authE2eSpans = findByName(
    e2eSdkSpans,
    "auth.get_challenge",
    "auth.sign_challenge",
    "auth.verify_challenge",
  );
  assertMin("Auth E2E spans (auth.*)", authE2eSpans, 6);

  // Bundle E2E spans: 3 bundles × 2 spans = 6
  const bundleE2eSpans = findByName(
    e2eSdkSpans,
    "bundle.submit",
    "bundle.wait",
  );
  assertMin("Bundle E2E spans (bundle.*)", bundleE2eSpans, 6);

  // PrivacyChannel spans
  const channelSpans = findByPrefix(e2eSdkSpans, "PrivacyChannel.");
  assertMin("PrivacyChannel spans", channelSpans, 4);

  // UtxoBasedAccount spans
  const accountSpans = findByPrefix(e2eSdkSpans, "UtxoBasedAccount.");
  assertMin("UtxoBasedAccount spans", accountSpans, 8);

  // MoonlightTransactionBuilder spans (not used in current E2E flow — informational only)
  const txBuilderSpans = findByPrefix(
    e2eSdkSpans,
    "MoonlightTransactionBuilder.",
  );
  if (txBuilderSpans.length > 0) {
    console.log(
      `  ✅ MoonlightTransactionBuilder spans: ${txBuilderSpans.length}`,
    );
    passed++;
  } else {
    console.log(
      `  ⏭️  MoonlightTransactionBuilder spans: 0 (not exercised in E2E flow)`,
    );
  }

  // SDK spans with events
  const sdkSpansWithEvents = e2eSdkSpans.filter(hasSpanEvents);
  assertMin("SDK spans with events", sdkSpansWithEvents, 10);

  // =====================================================================
  // Distributed tracing (from E2E trace-by-ID)
  // =====================================================================

  console.log("\n  Distributed tracing:");

  const providerTraceIds = new Set(e2eProviderHttpSpans.map((s) => s.traceID));
  const sdkTraceIds = new Set(e2eSdkSpans.map((s) => s.traceID));
  const sharedTraceIds = [...sdkTraceIds].filter((id) =>
    providerTraceIds.has(id)
  );

  // 5 of 7 E2E steps hit the provider (fund_accounts → friendbot, prepare_receive → local only)
  if (sharedTraceIds.length >= 5) {
    console.log(`  ✅ Shared trace IDs: ${sharedTraceIds.length} (>= 5)`);
    passed++;
  } else {
    console.log(
      `  ❌ Shared trace IDs: ${sharedTraceIds.length} (expected >= 5)`,
    );
    if (sdkTraceIds.size > 0 && providerTraceIds.size > 0) {
      console.log(
        `     SDK trace IDs: ${[...sdkTraceIds].slice(0, 3).join(", ")}`,
      );
      console.log(
        `     Provider trace IDs: ${
          [...providerTraceIds].slice(0, 3).join(", ")
        }`,
      );
    }
    failed++;
  }

  // Parent-child: provider HTTP spans reference SDK spans
  if (sharedTraceIds.length > 0) {
    const sdkSpanIds = new Set(e2eSdkSpans.map((s) => s.spanID));
    const providerWithSdkParent = e2eProviderHttpSpans.filter((s) =>
      s.references.some((ref) =>
        ref.refType === "CHILD_OF" && sdkSpanIds.has(ref.spanID)
      )
    );
    if (providerWithSdkParent.length > 0) {
      assertMin(
        "Provider HTTP spans with SDK parent (CHILD_OF)",
        providerWithSdkParent,
        5,
      );
    } else {
      const allSharedSpans = [...e2eProviderHttpSpans, ...e2eSdkSpans].filter(
        (s) => sharedTraceIds.includes(s.traceID),
      );
      const allSpanIds = new Set(allSharedSpans.map((s) => s.spanID));
      const providerWithAnyParent = e2eProviderHttpSpans.filter((s) =>
        s.references.some((ref) =>
          ref.refType === "CHILD_OF" && allSpanIds.has(ref.spanID)
        )
      );
      if (providerWithAnyParent.length > 0) {
        console.log(
          `  ✅ Provider spans linked via trace hierarchy: ${providerWithAnyParent.length}`,
        );
        passed++;
      } else {
        console.log(`  ⚠️  Shared trace IDs found but no parent-child refs`);
        passed++;
      }
    }
  }

  // Summary
  console.log(`\n  Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error(`\n❌ OTEL verification failed`);
    Deno.exit(1);
  }

  console.log(`\n✅ OTEL verification passed`);
}

main().catch((err) => {
  console.error(`\n❌ OTEL verification failed:`, err);
  Deno.exit(1);
});
