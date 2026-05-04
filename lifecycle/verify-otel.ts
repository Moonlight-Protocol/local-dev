/**
 * OTEL Verification for Lifecycle flow.
 *
 * Thin wrapper around the shared verify-otel lib. Reads trace IDs
 * written by lifecycle/testnet-verify.ts and checks them in Tempo.
 *
 * Prerequisites:
 *   - lifecycle/testnet-verify.ts completed with OTEL_DENO=true
 *     (writes e2e-trace-ids.json via the shared tracer)
 *   - TEMPO_URL, TEMPO_AUTH env vars set
 *   - MOONLIGHT_NETWORK env var set (testnet|mainnet); defaults to testnet
 *
 * Usage:
 *   deno run --allow-all lifecycle/verify-otel.ts
 */
import {
  type NetworkName,
  VALID_NETWORKS,
  verifyOtelTraces,
} from "../lib/verify-otel.ts";

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
const NETWORK = (Deno.env.get("MOONLIGHT_NETWORK") ?? "testnet") as NetworkName;
if (!VALID_NETWORKS.includes(NETWORK)) {
  console.error(
    `❌ MOONLIGHT_NETWORK must be one of ${
      VALID_NETWORKS.join("|")
    }, got: ${NETWORK}`,
  );
  Deno.exit(1);
}

const TRACE_IDS_PATH =
  new URL("../e2e/e2e-trace-ids.json", import.meta.url).pathname;

const result = await verifyOtelTraces({
  tempoUrl: TEMPO_URL,
  tempoAuth: TEMPO_AUTH,
  traceIdsPath: TRACE_IDS_PATH,
  pollTimeoutMs: Number(Deno.env.get("TRACE_POLL_TIMEOUT_MS") ?? "30000"),
  network: NETWORK,
});

if (result.failed > 0) {
  console.error("\n❌ OTEL verification failed");
  Deno.exit(1);
}

console.log("\n✅ OTEL verification passed — traces visible in Grafana Cloud");
