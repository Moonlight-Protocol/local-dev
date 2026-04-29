/**
 * OTEL trace verification against a local Jaeger instance.
 *
 * Mirror of lib/verify-otel.ts but targets Jaeger (localhost:16686 by default)
 * instead of Grafana Cloud Tempo. Used by the testnet/lifecycle scripts when
 * pointed at the local stack so we don't need Tempo credentials for local runs.
 *
 * Span-count assertions live in lib/verify-otel-validate.ts (shared with the
 * Tempo verifier). This file owns Jaeger-specific fetch/normalize/search.
 */
import {
  type E2ETraceData,
  loadTraceData,
  type VerifyOtelResult,
} from "./verify-otel.ts";
import {
  type NormalizedSpan,
  validateNormalizedSpans,
} from "./verify-otel-validate.ts";

export interface VerifyOtelLocalConfig {
  jaegerUrl: string;
  traceIdsPath: string;
  pollTimeoutMs?: number;
  providerServiceName: string;
  sdkServiceName: string;
  /**
   * council-platform service.name. When set, asserts cp#28 spans are present
   * and trace-linked to the SDK driver. Leave undefined for flows that don't
   * run cp (e.g. local-CI e2e/docker-compose.yml).
   */
  councilServiceName?: string;
}

interface JaegerTracesResponse {
  data?: JaegerTrace[];
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
  references?: { refType: string; traceID: string; spanID: string }[];
  startTime: number; // microseconds
  duration: number; // microseconds
  logs?: { timestamp: number }[];
  tags?: { key: string; value: unknown }[];
  processID: string;
}

function normalizeJaegerTrace(trace: JaegerTrace): NormalizedSpan[] {
  const spans: NormalizedSpan[] = [];
  for (const span of trace.spans ?? []) {
    const serviceName = trace.processes?.[span.processID]?.serviceName ??
      "unknown";
    const parentRef = (span.references ?? []).find((r) =>
      r.refType === "CHILD_OF"
    );
    spans.push({
      traceId: span.traceID,
      spanId: span.spanID,
      parentSpanId: parentRef?.spanID ?? "",
      name: span.operationName,
      serviceName,
      hasEvents: (span.logs?.length ?? 0) > 0,
    });
  }
  return spans;
}

async function fetchTraceById(
  jaegerUrl: string,
  traceId: string,
  maxWaitMs: number,
  intervalMs = 3000,
): Promise<NormalizedSpan[]> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${jaegerUrl}/api/traces/${traceId}`);

    if (res.ok) {
      const data: JaegerTracesResponse = await res.json();
      const spans: NormalizedSpan[] = [];
      for (const trace of data.data ?? []) {
        spans.push(...normalizeJaegerTrace(trace));
      }
      if (spans.length > 0) return spans;
    } else if (res.status !== 404) {
      const body = await res.text().catch(() => "(could not read body)");
      console.error(
        `  Jaeger returned HTTP ${res.status} for trace ${traceId}: ${body}`,
      );
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return [];
}

/**
 * Jaeger does not support TraceQL/regex on operation name, so we fetch all
 * traces for the service in the time window and filter by operation prefix
 * client-side.
 */
async function searchTraceCountByPrefixes(
  jaegerUrl: string,
  service: string,
  prefixes: string[],
  startEpochUs: number,
  endEpochUs: number,
  minExpected: number,
  maxWaitMs: number,
  intervalMs = 3000,
): Promise<number> {
  const deadline = Date.now() + maxWaitMs;
  let best = 0;

  while (Date.now() < deadline) {
    const url =
      `${jaegerUrl}/api/traces?service=${encodeURIComponent(service)}` +
      `&start=${startEpochUs}&end=${endEpochUs}&limit=200`;
    const res = await fetch(url);

    if (res.ok) {
      const data: JaegerTracesResponse = await res.json();
      const matching = (data.data ?? []).filter((t) =>
        t.spans.some((s) => prefixes.some((p) => s.operationName.startsWith(p)))
      );
      best = Math.max(best, matching.length);
      if (best >= minExpected) return best;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return best;
}

/**
 * Verify OTEL traces in a local Jaeger instance. Returns pass/fail counts.
 * Throws on connectivity failure.
 */
export async function verifyOtelTracesLocal(
  config: VerifyOtelLocalConfig,
): Promise<VerifyOtelResult> {
  const {
    jaegerUrl,
    traceIdsPath,
    pollTimeoutMs = 30000,
    providerServiceName,
    sdkServiceName,
    councilServiceName,
  } = config;
  const PROVIDER_SERVICE = providerServiceName;
  const SDK_SERVICE = sdkServiceName;

  console.log("\n[OTEL] Verifying OpenTelemetry traces in local Jaeger\n");

  // 1. Verify Jaeger connectivity
  console.log("[1/3] Checking Jaeger connectivity...");
  console.log(`  Jaeger URL: ${jaegerUrl}`);
  try {
    const res = await fetch(`${jaegerUrl}/api/services`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    const services: string[] = data.data ?? [];
    console.log(`  Jaeger reachable (${services.length} services registered)`);
    for (const required of [PROVIDER_SERVICE, SDK_SERVICE]) {
      if (!services.includes(required)) {
        console.log(
          `  ⚠️  Service '${required}' not registered with Jaeger yet`,
        );
      }
    }
  } catch (err) {
    throw new Error(`Jaeger not reachable at ${jaegerUrl}: ${err}`);
  }

  // 2. Load trace data and fetch traces by ID
  console.log("\n[2/3] Loading trace data and fetching traces by ID...");
  const traceData: E2ETraceData = loadTraceData(traceIdsPath);
  console.log(`  Trace IDs: ${traceData.traceIds.length}`);
  console.log(
    `  Time window: ${new Date(traceData.startTimeUs / 1000).toISOString()} → ${
      new Date(traceData.endTimeUs / 1000).toISOString()
    }`,
  );

  const allSpans: NormalizedSpan[] = [];
  let tracesFound = 0;

  for (const id of traceData.traceIds) {
    const spans = await fetchTraceById(jaegerUrl, id, pollTimeoutMs);
    if (spans.length > 0) {
      allSpans.push(...spans);
      tracesFound++;
    } else {
      console.error(`  ⚠️  Trace ${id} not found in Jaeger`);
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
    councilService: councilServiceName,
    traceData,
    searchBackgroundTraces: async (prefixes, startUs, endUs, minExpected) => {
      return await searchTraceCountByPrefixes(
        jaegerUrl,
        PROVIDER_SERVICE,
        prefixes,
        startUs,
        endUs,
        minExpected,
        pollTimeoutMs,
      );
    },
  });
}
