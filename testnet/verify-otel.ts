/**
 * OTEL Verification for Testnet (deterministic)
 *
 * All checks use trace-by-ID lookups from the E2E run — no time-windowed
 * searches. This is possible because the provider's trace context middleware
 * nests all request-path spans under the SDK's trace IDs.
 *
 * Background service spans (Executor.*, Verifier.*, Mempool.*) run on timers
 * outside of HTTP context, so they are verified with a targeted search.
 *
 * Prerequisites:
 *   - E2E test completed with OTEL_DENO=true (writes e2e-trace-ids.json)
 *   - TEMPO_URL and TEMPO_AUTH env vars set (or defaults to Grafana Cloud)
 *
 * Usage:
 *   deno run --allow-all verify-otel.ts
 */

const TEMPO_URL = Deno.env.get("TEMPO_URL") ??
  "https://tempo-prod-13-prod-ca-east-0.grafana.net/tempo";
const TEMPO_AUTH = Deno.env.get("TEMPO_AUTH") ??
  "Basic MTUxMzA1MTpnbGNfZXlKdklqb2lNVGN3TVRFeE5DSXNJbTRpT2lKd2NtOTJhV1JsY2kxMGNtRmpaWE10ZDNKcGRHVXRjSEp2ZG1sa1pYSXRkSEpoWTJWekxYZHlhWFJsSWl3aWF5STZJamM0TUc5YVNHNVNUak4wTmxJNU1HaHNTWFl4TlhjM1V5SXNJbTBpT25zaWNpSTZJbkJ5YjJRdFkyRXRaV0Z6ZEMwd0luMTk=";
const TRACE_POLL_TIMEOUT_MS = Number(
  Deno.env.get("TRACE_POLL_TIMEOUT_MS") ?? "30000",
);
const SDK_SERVICE = "moonlight-e2e";
const PROVIDER_SERVICE = "provider-platform";

const TRACE_IDS_PATH = (() => {
  const localPath = new URL("./e2e-trace-ids.json", import.meta.url).pathname;
  try {
    Deno.statSync(localPath);
    return localPath;
  } catch {
    return new URL("../e2e/e2e-trace-ids.json", import.meta.url).pathname;
  }
})();

interface E2ETraceData {
  traceIds: string[];
  startTimeUs: number;
  endTimeUs: number;
}

interface TempoTrace {
  batches?: ResourceSpan[];
  resourceSpans?: ResourceSpan[];
}

interface ResourceSpan {
  resource: {
    attributes: { key: string; value: { stringValue?: string } }[];
  };
  scopeSpans: {
    spans: TempoSpan[];
  }[];
}

interface TempoSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: { key: string; value: { stringValue?: string; intValue?: string } }[];
  events?: { name: string }[];
  status?: { code: number };
}

interface NormalizedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  serviceName: string;
  hasEvents: boolean;
}

function getServiceName(rs: ResourceSpan): string {
  const attr = rs.resource.attributes.find((a) => a.key === "service.name");
  return attr?.value?.stringValue ?? "unknown";
}

function normalizeTempoTrace(data: TempoTrace): NormalizedSpan[] {
  const spans: NormalizedSpan[] = [];
  const resourceSpans = data.batches ?? data.resourceSpans ?? [];
  for (const rs of resourceSpans) {
    const serviceName = getServiceName(rs);
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        spans.push({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId ?? "",
          name: span.name,
          serviceName,
          hasEvents: (span.events?.length ?? 0) > 0,
        });
      }
    }
  }
  return spans;
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
  intervalMs = 3000,
): Promise<NormalizedSpan[]> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${TEMPO_URL}/api/traces/${traceId}`, {
      headers: {
        Authorization: TEMPO_AUTH,
        Accept: "application/json",
      },
    });

    if (res.ok) {
      const data: TempoTrace = await res.json();
      const spans = normalizeTempoTrace(data);
      if (spans.length > 0) return spans;
    } else if (res.status === 404) {
      // Trace not ingested yet, retry
    } else {
      const body = await res.text().catch(() => "(could not read body)");
      console.error(
        `  Tempo returned HTTP ${res.status} for trace ${traceId}: ${body}`,
      );
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return [];
}

/**
 * Search for traces matching a TraceQL query. Returns the number of matching
 * traces (not spans). Used only for background service span existence check.
 */
async function searchTraceCount(
  traceql: string,
  startEpochS: number,
  endEpochS: number,
  minExpected: number,
  maxWaitMs = TRACE_POLL_TIMEOUT_MS,
  intervalMs = 3000,
): Promise<number> {
  const deadline = Date.now() + maxWaitMs;
  let best = 0;

  while (Date.now() < deadline) {
    const q = encodeURIComponent(traceql);
    const url =
      `${TEMPO_URL}/api/search?q=${q}&start=${startEpochS}&end=${endEpochS}&limit=50`;
    const res = await fetch(url, {
      headers: { Authorization: TEMPO_AUTH },
    });

    if (res.ok) {
      const data = await res.json();
      const count = (data.traces ?? []).length;
      best = Math.max(best, count);
      if (best >= minExpected) return best;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return best;
}

async function main() {
  console.log("\n[OTEL] Verifying OpenTelemetry traces in Grafana Cloud Tempo\n");

  // 1. Verify Tempo is reachable
  console.log("[1/3] Checking Tempo connectivity...");
  console.log(`  Tempo URL: ${TEMPO_URL}`);
  try {
    const res = await fetch(`${TEMPO_URL}/api/echo`, {
      headers: { Authorization: TEMPO_AUTH },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`HTTP ${res.status}`);
    }
    await res.text();
    console.log(`  Tempo reachable`);
  } catch (err) {
    console.error(`\n❌ Tempo not reachable at ${TEMPO_URL}`);
    console.error(`   Error: ${err}`);
    Deno.exit(1);
  }

  // 2. Load trace data and fetch all traces by ID
  console.log("\n[2/3] Loading trace data and fetching traces by ID...");
  const traceData = loadTraceData();
  console.log(`  Trace IDs: ${traceData.traceIds.length}`);
  console.log(
    `  Time window: ${new Date(traceData.startTimeUs / 1000).toISOString()} → ${new Date(traceData.endTimeUs / 1000).toISOString()}`,
  );

  const allSpans: NormalizedSpan[] = [];
  let tracesFound = 0;

  for (const id of traceData.traceIds) {
    const spans = await fetchTraceById(id);
    if (spans.length > 0) {
      allSpans.push(...spans);
      tracesFound++;
    } else {
      console.error(`  ⚠️  Trace ${id} not found in Tempo`);
    }
  }
  console.log(
    `  Fetched ${tracesFound}/${traceData.traceIds.length} traces (${allSpans.length} spans)`,
  );

  if (allSpans.length === 0) {
    console.error("\n❌ No traces found in Tempo");
    Deno.exit(1);
  }

  // Split by service
  const sdkSpans = allSpans.filter((s) => s.serviceName === SDK_SERVICE);
  const providerSpans = allSpans.filter(
    (s) => s.serviceName === PROVIDER_SERVICE,
  );

  // 3. Validate — all checks use the trace-by-ID data
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

  // =====================================================================
  // Provider-platform checks (all from trace-by-ID)
  // =====================================================================

  console.log("\n  Provider-platform:");

  // Function-level spans (request-path only: P_*, Bundle.*)
  assertMin(
    "Function-level spans (P_*, Bundle.*)",
    byPrefix(providerSpans, "P_", "Bundle."),
    20,
  );

  // Auth challenge create: 2 users × (P_CreateChallenge + DB + Memory) = 6
  assertMin(
    "Auth challenge create spans",
    byName(providerSpans, "P_CreateChallenge", "P_CreateChallengeDB", "P_CreateChallengeMemory"),
    4,
  );

  // Auth challenge verify: 2 users × (Verify + Compare + JWT) = 6
  assertMin(
    "Auth challenge verify spans",
    byName(providerSpans, "P_VerifyChallenge", "P_CompareChallenge", "P_GenerateChallengeJWT"),
    4,
  );

  // Bundle processing: 3 bundles (deposit, send, withdraw)
  assertMin(
    "P_AddOperationsBundle spans",
    byName(providerSpans, "P_AddOperationsBundle"),
    3,
  );

  // Bundle.* helper spans: 3 bundles × 3+ helpers each
  assertMin(
    "Bundle.* helper spans",
    byPrefix(providerSpans, "Bundle."),
    9,
  );

  // Spans with events
  assertMin(
    "Spans with events",
    providerSpans.filter((s) => s.hasEvents).length,
    15,
  );

  // HTTP spans (middleware-created request spans)
  assertMin(
    "HTTP request spans",
    byPrefix(providerSpans, "GET ", "POST "),
    5,
  );

  // Background service spans — these run on timers, NOT under E2E trace IDs.
  // Use a targeted search for existence only.
  const startS = Math.floor(traceData.startTimeUs / 1_000_000);
  const endS = Math.ceil(traceData.endTimeUs / 1_000_000) + 120;
  const bgCount = await searchTraceCount(
    `{resource.service.name="${PROVIDER_SERVICE}" && name=~"Executor\\\\..*|Verifier\\\\..*|Mempool\\\\..*"}`,
    startS, endS, 1,
  );
  assertMin("Background service traces (Executor/Verifier/Mempool)", bgCount, 1);

  // =====================================================================
  // SDK checks (all from trace-by-ID)
  // =====================================================================

  console.log("\n  SDK (moonlight-e2e):");

  const e2eStepNames = [
    "e2e.fund_accounts",
    "e2e.authenticate_alice",
    "e2e.authenticate_bob",
    "e2e.deposit",
    "e2e.prepare_receive",
    "e2e.send",
    "e2e.withdraw",
  ];
  assertMin("E2E step spans (e2e.*)", byName(sdkSpans, ...e2eStepNames), 7);

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

  // =====================================================================
  // Distributed tracing (from trace-by-ID)
  // =====================================================================

  console.log("\n  Distributed tracing:");

  const providerTraceIds = new Set(providerSpans.map((s) => s.traceId));
  const sdkTraceIds = new Set(sdkSpans.map((s) => s.traceId));
  const sharedTraceIds = [...sdkTraceIds].filter((id) =>
    providerTraceIds.has(id)
  );
  assertMin("Shared trace IDs", sharedTraceIds.length, 5);

  const sdkSpanIds = new Set(sdkSpans.map((s) => s.spanId));
  const providerWithSdkParent = providerSpans.filter((s) =>
    sdkSpanIds.has(s.parentSpanId)
  );
  assertMin("Provider spans with SDK parent", providerWithSdkParent.length, 5);

  // Summary
  console.log(`\n  Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error(`\n❌ OTEL verification failed`);
    Deno.exit(1);
  }

  console.log(`\n✅ OTEL verification passed — traces visible in Grafana Cloud`);
}

main().catch((err) => {
  console.error(`\n❌ OTEL verification failed:`, err);
  Deno.exit(1);
});
