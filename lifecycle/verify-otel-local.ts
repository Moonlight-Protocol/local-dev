/**
 * OTEL Verification for Lifecycle flow against a local Jaeger instance.
 *
 * Thin wrapper around the shared verify-otel-local lib. Reads trace IDs
 * written by lifecycle/testnet-verify.ts and checks them in local Jaeger.
 *
 * Prerequisites:
 *   - lifecycle/testnet-verify.ts completed with OTEL exporter pointed at
 *     local OTLP collector (writes e2e-trace-ids.json via the shared tracer)
 *   - JAEGER_URL env var set (defaults to http://localhost:16686)
 *   - PROVIDER_SERVICE_NAME, SDK_SERVICE_NAME env vars set
 *
 * Usage:
 *   deno run --allow-all lifecycle/verify-otel-local.ts
 */
import { verifyOtelTracesLocal } from "../lib/verify-otel-local.ts";

const JAEGER_URL = Deno.env.get("JAEGER_URL") ?? "http://localhost:16686";

const PROVIDER_SERVICE_NAME = Deno.env.get("PROVIDER_SERVICE_NAME");
if (!PROVIDER_SERVICE_NAME) {
  console.error("❌ PROVIDER_SERVICE_NAME env var is required");
  Deno.exit(1);
}
const SDK_SERVICE_NAME = Deno.env.get("SDK_SERVICE_NAME");
if (!SDK_SERVICE_NAME) {
  console.error("❌ SDK_SERVICE_NAME env var is required");
  Deno.exit(1);
}
const COUNCIL_SERVICE_NAME = Deno.env.get("COUNCIL_SERVICE_NAME");

const TRACE_IDS_PATH =
  new URL("../e2e/e2e-trace-ids.json", import.meta.url).pathname;

const result = await verifyOtelTracesLocal({
  jaegerUrl: JAEGER_URL,
  traceIdsPath: TRACE_IDS_PATH,
  pollTimeoutMs: Number(Deno.env.get("TRACE_POLL_TIMEOUT_MS") ?? "30000"),
  providerServiceName: PROVIDER_SERVICE_NAME,
  sdkServiceName: SDK_SERVICE_NAME,
  councilServiceName: COUNCIL_SERVICE_NAME,
});

if (result.failed > 0) {
  console.error("\n❌ OTEL verification failed");
  Deno.exit(1);
}

console.log("\n✅ OTEL verification passed — traces visible in local Jaeger");
