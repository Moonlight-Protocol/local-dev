/**
 * Shared OTEL trace verification against Grafana Cloud Tempo.
 *
 * Fetches traces by ID and validates span counts/names. Used by both
 * testnet/verify-otel.ts and lifecycle/testnet-verify.ts.
 */

export interface VerifyOtelConfig {
  tempoUrl: string;
  tempoAuth: string;
  traceIdsPath: string;
  pollTimeoutMs?: number;
  providerServiceName: string;
  sdkServiceName: string;
}

export interface VerifyOtelResult {
  passed: number;
  failed: number;
}

export interface E2ETraceData {
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

// Service names are passed via config — no defaults, to prevent silent mismatches
// between testnet (provider-platform) and mainnet (provider-platform-mainnet).

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

export function loadTraceData(path: string): E2ETraceData {
  const raw = Deno.readTextFileSync(path);
  const data = JSON.parse(raw);
  if (!Array.isArray(data.traceIds) || data.traceIds.length === 0) {
    throw new Error("Empty trace ID list");
  }
  return data;
}

async function fetchTraceById(
  tempoUrl: string,
  tempoAuth: string,
  traceId: string,
  maxWaitMs: number,
  intervalMs = 3000,
): Promise<NormalizedSpan[]> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${tempoUrl}/api/traces/${traceId}`, {
      headers: { Authorization: tempoAuth, Accept: "application/json" },
    });

    if (res.ok) {
      const data: TempoTrace = await res.json();
      const spans = normalizeTempoTrace(data);
      if (spans.length > 0) return spans;
    } else if (res.status !== 404) {
      const body = await res.text().catch(() => "(could not read body)");
      console.error(`  Tempo returned HTTP ${res.status} for trace ${traceId}: ${body}`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return [];
}

async function searchTraceCount(
  tempoUrl: string,
  tempoAuth: string,
  traceql: string,
  startEpochS: number,
  endEpochS: number,
  minExpected: number,
  maxWaitMs: number,
  intervalMs = 3000,
): Promise<number> {
  const deadline = Date.now() + maxWaitMs;
  let best = 0;

  while (Date.now() < deadline) {
    const q = encodeURIComponent(traceql);
    const url = `${tempoUrl}/api/search?q=${q}&start=${startEpochS}&end=${endEpochS}&limit=50`;
    const res = await fetch(url, { headers: { Authorization: tempoAuth } });

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

/**
 * Verify OTEL traces in Grafana Cloud Tempo. Returns pass/fail counts.
 * Throws on connectivity failure.
 */
export async function verifyOtelTraces(config: VerifyOtelConfig): Promise<VerifyOtelResult> {
  const { tempoUrl, tempoAuth, traceIdsPath, pollTimeoutMs = 30000, providerServiceName, sdkServiceName } = config;
  const PROVIDER_SERVICE = providerServiceName;
  const SDK_SERVICE = sdkServiceName;

  console.log("\n[OTEL] Verifying OpenTelemetry traces in Grafana Cloud Tempo\n");

  // 1. Verify Tempo connectivity
  console.log("[1/3] Checking Tempo connectivity...");
  console.log(`  Tempo URL: ${tempoUrl}`);
  try {
    const res = await fetch(`${tempoUrl}/api/echo`, {
      headers: { Authorization: tempoAuth },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`HTTP ${res.status}`);
    }
    await res.text();
    console.log(`  Tempo reachable`);
  } catch (err) {
    throw new Error(`Tempo not reachable at ${tempoUrl}: ${err}`);
  }

  // 2. Load trace data and fetch traces by ID
  console.log("\n[2/3] Loading trace data and fetching traces by ID...");
  const traceData = loadTraceData(traceIdsPath);
  console.log(`  Trace IDs: ${traceData.traceIds.length}`);
  console.log(
    `  Time window: ${new Date(traceData.startTimeUs / 1000).toISOString()} → ${new Date(traceData.endTimeUs / 1000).toISOString()}`,
  );

  const allSpans: NormalizedSpan[] = [];
  let tracesFound = 0;

  for (const id of traceData.traceIds) {
    const spans = await fetchTraceById(tempoUrl, tempoAuth, id, pollTimeoutMs);
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
    return { passed: 0, failed: 1 };
  }

  const sdkSpans = allSpans.filter((s) => s.serviceName === SDK_SERVICE);
  const providerSpans = allSpans.filter((s) => s.serviceName === PROVIDER_SERVICE);

  // 3. Validate
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

  // Background service spans
  const startS = Math.floor(traceData.startTimeUs / 1_000_000);
  const endS = Math.ceil(traceData.endTimeUs / 1_000_000) + 120;
  const bgCount = await searchTraceCount(
    tempoUrl, tempoAuth,
    `{resource.service.name="${PROVIDER_SERVICE}" && name=~"Executor\\\\..*|Verifier\\\\..*|Mempool\\\\..*"}`,
    startS, endS, 1, pollTimeoutMs,
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
