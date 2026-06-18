/**
 * OTEL verification for the standin lifecycle flow against local Jaeger.
 *
 * Mirrors lifecycle/verify-otel-local.ts but asks Jaeger for the standin's
 * service name (`provider-platform-standin`) instead of the Deno provider's
 * (`provider-platform`). Both services emit to the same Jaeger instance, so
 * the override is the only way to fetch the standin's traces without
 * picking up the Deno provider's.
 *
 * Prerequisites:
 *   - lifecycle/standin-verify.ts completed with OTEL exporter pointed at
 *     local OTLP collector (writes e2e-trace-ids.json via the shared tracer)
 *   - JAEGER_URL env var set (defaults to http://localhost:16686)
 *
 * Usage:
 *   deno run --allow-all lifecycle/standin-verify-otel-local.ts
 */
import { verifyOtelTracesLocal } from "../lib/verify-otel-local.ts";

const JAEGER_URL = Deno.env.get("JAEGER_URL") ?? "http://localhost:16686";

const TRACE_IDS_PATH =
  new URL("../e2e/e2e-trace-ids.json", import.meta.url).pathname;

const result = await verifyOtelTracesLocal({
  jaegerUrl: JAEGER_URL,
  traceIdsPath: TRACE_IDS_PATH,
  pollTimeoutMs: Number(Deno.env.get("TRACE_POLL_TIMEOUT_MS") ?? "30000"),
  network: "local",
  providerServiceOverride: "provider-platform-standin",
});

if (result.failed > 0) {
  console.error("\n❌ OTEL verification (standin) failed");
  Deno.exit(1);
}

console.log(
  "\n✅ OTEL verification (standin) passed — traces visible in local Jaeger",
);
