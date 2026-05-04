/**
 * OTEL Verification for Testnet E2E against a local Jaeger instance.
 *
 * Mirrors verify-otel.ts but reads JAEGER_URL instead of TEMPO_URL/TEMPO_AUTH.
 * Use this when running the testnet scripts against the local stack so we
 * don't need Grafana Cloud credentials. Always runs against the local stack —
 * service names are unsuffixed.
 *
 * Prerequisites:
 *   - E2E test completed with OTEL exporter pointed at local OTLP collector
 *     (writes e2e-trace-ids.json)
 *   - JAEGER_URL env var set (defaults to http://localhost:16686)
 *
 * Usage:
 *   deno run --allow-all verify-otel-local.ts
 */
import { verifyOtelTracesLocal } from "../lib/verify-otel-local.ts";

const JAEGER_URL = Deno.env.get("JAEGER_URL") ?? "http://localhost:16686";

const TRACE_IDS_PATH = (() => {
  const localPath = new URL("./e2e-trace-ids.json", import.meta.url).pathname;
  try {
    Deno.statSync(localPath);
    return localPath;
  } catch {
    return new URL("../e2e/e2e-trace-ids.json", import.meta.url).pathname;
  }
})();

const result = await verifyOtelTracesLocal({
  jaegerUrl: JAEGER_URL,
  traceIdsPath: TRACE_IDS_PATH,
  pollTimeoutMs: Number(Deno.env.get("TRACE_POLL_TIMEOUT_MS") ?? "30000"),
  network: "local",
});

if (result.failed > 0) {
  console.error("\n❌ OTEL verification failed");
  Deno.exit(1);
}

console.log("\n✅ OTEL verification passed — traces visible in local Jaeger");
