/**
 * OTEL Verification for Testnet E2E.
 *
 * Thin wrapper around the shared verify-otel lib. Reads TEMPO_URL and
 * TEMPO_AUTH from env, resolves the trace IDs file, and exits with the
 * appropriate code.
 *
 * Prerequisites:
 *   - E2E test completed with OTEL_DENO=true (writes e2e-trace-ids.json)
 *   - TEMPO_URL and TEMPO_AUTH env vars set
 *
 * Usage:
 *   deno run --allow-all verify-otel.ts
 */
import { verifyOtelTraces } from "../lib/verify-otel.ts";

const TEMPO_URL = Deno.env.get("TEMPO_URL");
if (!TEMPO_URL) {
  console.error("❌ TEMPO_URL env var is required");
  Deno.exit(1);
}
const TEMPO_AUTH = Deno.env.get("TEMPO_AUTH");
if (!TEMPO_AUTH) {
  console.error("❌ TEMPO_AUTH env var is required");
  Deno.exit(1);
}
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

const TRACE_IDS_PATH = (() => {
  const localPath = new URL("./e2e-trace-ids.json", import.meta.url).pathname;
  try {
    Deno.statSync(localPath);
    return localPath;
  } catch {
    return new URL("../e2e/e2e-trace-ids.json", import.meta.url).pathname;
  }
})();

const result = await verifyOtelTraces({
  tempoUrl: TEMPO_URL,
  tempoAuth: TEMPO_AUTH,
  traceIdsPath: TRACE_IDS_PATH,
  pollTimeoutMs: Number(Deno.env.get("TRACE_POLL_TIMEOUT_MS") ?? "30000"),
  providerServiceName: PROVIDER_SERVICE_NAME,
  sdkServiceName: SDK_SERVICE_NAME,
});

if (result.failed > 0) {
  console.error("\n❌ OTEL verification failed");
  Deno.exit(1);
}

console.log("\n✅ OTEL verification passed — traces visible in Grafana Cloud");
