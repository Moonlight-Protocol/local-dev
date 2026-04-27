/**
 * Shared OTEL trace verification against Grafana Cloud Tempo.
 *
 * Fetches traces by ID and validates span counts/names. Used by both
 * testnet/verify-otel.ts and lifecycle/testnet-verify.ts.
 *
 * Span-count assertions live in lib/verify-otel-validate.ts so the
 * Jaeger-backed verify-otel-local.ts can share them.
 */
import { type NormalizedSpan, validateNormalizedSpans } from "./verify-otel-validate.ts";

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

// NormalizedSpan moved to verify-otel-validate.ts (shared with Jaeger verifier).

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

  return await validateNormalizedSpans({
    allSpans,
    providerService: PROVIDER_SERVICE,
    sdkService: SDK_SERVICE,
    traceData,
    searchBackgroundTraces: async (prefixes, startUs, endUs, minExpected) => {
      const startS = Math.floor(startUs / 1_000_000);
      const endS = Math.ceil(endUs / 1_000_000);
      const traceqlPrefixes = prefixes.map((p) => `${p.replace(/\./g, "\\\\.")}.*`).join("|");
      return await searchTraceCount(
        tempoUrl,
        tempoAuth,
        `{resource.service.name="${PROVIDER_SERVICE}" && name=~"${traceqlPrefixes}"}`,
        startS,
        endS,
        minExpected,
        pollTimeoutMs,
      );
    },
  });
}
