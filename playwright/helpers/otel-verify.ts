/**
 * OTEL trace verification against Jaeger (local) or Grafana Cloud Tempo (testnet/mainnet).
 *
 * Local stack sends traces to Jaeger (port 16686).
 * Testnet/mainnet send traces to Grafana Cloud Tempo.
 */
import { getTarget, getJaegerUrl } from "./urls";

export interface OtelVerifyConfig {
  /** "jaeger" for local, "tempo" for testnet/mainnet */
  backend: "jaeger" | "tempo";
  /** Jaeger UI base URL (e.g. http://localhost:16686) */
  jaegerUrl?: string;
  /** Tempo base URL (e.g. https://tempo-prod-13-prod-ca-east-0.grafana.net/tempo) */
  tempoUrl?: string;
  /** Tempo auth header (e.g. "Basic MTUxMzA1MTp...") */
  tempoAuth?: string;
  /** Test window start (epoch seconds) */
  startEpochS: number;
  /** Test window end (epoch seconds) */
  endEpochS: number;
  /** Service names to check for traces */
  services: string[];
  /** Max time to wait for traces to appear (ms) */
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface OtelVerifyResult {
  passed: boolean;
  serviceResults: Record<string, { found: boolean; traceCount: number }>;
}

// ─── Jaeger API ─────────────────────────────────────────────────────

interface JaegerTrace {
  traceID: string;
  spans: { operationName: string; serviceName?: string }[];
}

interface JaegerSearchResponse {
  data: JaegerTrace[];
}

async function searchJaeger(
  jaegerUrl: string,
  service: string,
  startEpochUs: number,
  endEpochUs: number,
  maxWaitMs: number,
  intervalMs: number,
): Promise<number> {
  const deadline = Date.now() + maxWaitMs;
  let best = 0;

  while (Date.now() < deadline) {
    try {
      const url =
        `${jaegerUrl}/api/traces?service=${encodeURIComponent(service)}` +
        `&start=${startEpochUs}&end=${endEpochUs}&limit=50`;
      const res = await fetch(url);

      if (res.ok) {
        const data: JaegerSearchResponse = await res.json();
        const count = (data.data ?? []).length;
        best = Math.max(best, count);
        if (best > 0) return best;
      }
    } catch {
      // retry
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return best;
}

async function checkJaegerConnectivity(jaegerUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${jaegerUrl}/api/services`);
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Tempo API ──────────────────────────────────────────────────────

interface TempoSearchResponse {
  traces?: { traceID: string }[];
}

async function searchTempo(
  tempoUrl: string,
  tempoAuth: string,
  service: string,
  startEpochS: number,
  endEpochS: number,
  maxWaitMs: number,
  intervalMs: number,
): Promise<number> {
  const deadline = Date.now() + maxWaitMs;
  let best = 0;

  while (Date.now() < deadline) {
    try {
      const traceql = `{resource.service.name="${service}"}`;
      const q = encodeURIComponent(traceql);
      const url = `${tempoUrl}/api/search?q=${q}&start=${startEpochS}&end=${endEpochS}&limit=50`;
      const res = await fetch(url, {
        headers: { Authorization: tempoAuth },
      });

      if (res.ok) {
        const data: TempoSearchResponse = await res.json();
        const count = (data.traces ?? []).length;
        best = Math.max(best, count);
        if (best > 0) return best;
      }
    } catch {
      // retry
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return best;
}

async function checkTempoConnectivity(
  tempoUrl: string,
  tempoAuth: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${tempoUrl}/api/echo`, {
      headers: { Authorization: tempoAuth },
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

// ─── Unified verify ─────────────────────────────────────────────────

/**
 * Build a config from environment and target.
 */
export function buildOtelConfig(
  startEpochS: number,
  endEpochS: number,
  services: string[],
): OtelVerifyConfig {
  const target = getTarget();

  if (target === "local") {
    return {
      backend: "jaeger",
      jaegerUrl: getJaegerUrl(),
      startEpochS,
      endEpochS,
      services,
    };
  }

  return {
    backend: "tempo",
    tempoUrl:
      process.env.TEMPO_URL ??
      "https://tempo-prod-13-prod-ca-east-0.grafana.net/tempo",
    tempoAuth: process.env.TEMPO_AUTH ?? "",
    startEpochS,
    endEpochS,
    services,
  };
}

/**
 * Check that the OTEL backend is reachable.
 */
export async function checkOtelConnectivity(
  config: OtelVerifyConfig,
): Promise<boolean> {
  if (config.backend === "jaeger") {
    return checkJaegerConnectivity(config.jaegerUrl!);
  }
  return checkTempoConnectivity(config.tempoUrl!, config.tempoAuth!);
}

/**
 * Verify that each service produced at least one trace in the time window.
 */
export async function verifyOtelTraces(
  config: OtelVerifyConfig,
): Promise<OtelVerifyResult> {
  const {
    backend,
    startEpochS,
    endEpochS,
    services,
    pollTimeoutMs = 60_000,
    pollIntervalMs = 3_000,
  } = config;

  const serviceResults: Record<string, { found: boolean; traceCount: number }> =
    {};
  let allPassed = true;

  for (const service of services) {
    let count: number;

    if (backend === "jaeger") {
      // Jaeger API uses microseconds for start/end
      count = await searchJaeger(
        config.jaegerUrl!,
        service,
        startEpochS * 1_000_000,
        (endEpochS + 120) * 1_000_000,
        pollTimeoutMs,
        pollIntervalMs,
      );
    } else {
      count = await searchTempo(
        config.tempoUrl!,
        config.tempoAuth!,
        service,
        startEpochS,
        endEpochS + 120,
        pollTimeoutMs,
        pollIntervalMs,
      );
    }

    const found = count > 0;
    serviceResults[service] = { found, traceCount: count };
    if (!found) allPassed = false;
  }

  return { passed: allPassed, serviceResults };
}

/**
 * Format verification results for console output.
 */
export function formatOtelResults(result: OtelVerifyResult): string {
  const lines: string[] = ["OTEL Trace Verification:"];
  for (const [service, r] of Object.entries(result.serviceResults)) {
    const icon = r.found ? "pass" : "FAIL";
    lines.push(`  [${icon}] ${service}: ${r.traceCount} trace(s)`);
  }
  lines.push(`  Overall: ${result.passed ? "PASSED" : "FAILED"}`);
  return lines.join("\n");
}
