/**
 * OTEL trace verification for the POS payment e2e test.
 *
 * Queries Jaeger's API to verify that all expected services emitted traces
 * during the POS payment flow. This ensures observability is working
 * end-to-end across pay-platform, provider-platform, and council-platform.
 */

const JAEGER_QUERY_URL = Deno.env.get("JAEGER_QUERY_URL")!;

interface JaegerService {
  data: string[];
}

interface JaegerTrace {
  data: Array<{
    traceID: string;
    spans: Array<{
      traceID: string;
      spanID: string;
      operationName: string;
      references: Array<{ refType: string; traceID: string; spanID: string }>;
      tags: Array<{ key: string; type: string; value: string }>;
      process: { serviceName: string };
    }>;
  }>;
}

async function queryServices(): Promise<string[]> {
  const res = await fetch(`${JAEGER_QUERY_URL}/api/services`);
  const body: JaegerService = await res.json();
  return body.data ?? [];
}

async function queryTraces(
  service: string,
  limit = 20,
): Promise<JaegerTrace["data"]> {
  const res = await fetch(
    `${JAEGER_QUERY_URL}/api/traces?service=${service}&limit=${limit}`,
  );
  const body: JaegerTrace = await res.json();
  return body.data ?? [];
}

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${name}${detail ? `: ${detail}` : ""}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

// Wait a moment for traces to be flushed to Jaeger
await new Promise((r) => setTimeout(r, 5000));

console.log("\n=== POS OTEL Trace Verification ===\n");

// Check that all expected services are registered in Jaeger
const services = await queryServices();
console.log("  Registered services:", services.join(", "));

check(
  "pay-platform service registered",
  services.includes("pay-platform"),
);
check(
  "provider-platform service registered",
  services.includes("provider-platform"),
);
check(
  "council-platform service registered",
  services.includes("council-platform"),
);

// Check pay-platform traces
if (services.includes("pay-platform")) {
  console.log("\n  Pay-platform:");
  const traces = await queryTraces("pay-platform");
  const spanCount = traces.reduce((n, t) => n + t.spans.length, 0);
  check(
    "Pay-platform has traces",
    traces.length > 0 || spanCount > 0,
    `${traces.length} traces, ${spanCount} spans`,
  );
} else {
  check("Pay-platform registered", false, "service not in Jaeger");
}

// Check provider-platform traces
if (services.includes("provider-platform")) {
  console.log("\n  Provider-platform:");
  const traces = await queryTraces("provider-platform");
  const spanCount = traces.reduce((n, t) => n + t.spans.length, 0);
  check(
    "Provider-platform has traces",
    traces.length > 0 || spanCount > 0,
    `${traces.length} traces, ${spanCount} spans`,
  );
} else {
  check("Provider-platform registered", false, "service not in Jaeger");
}

// Summary
console.log(`\n  Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n❌ OTEL verification failed");
  Deno.exit(1);
} else {
  console.log("\n✅ OTEL verification passed");
}
