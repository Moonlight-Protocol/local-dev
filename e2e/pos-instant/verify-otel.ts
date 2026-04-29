/**
 * OTEL trace verification for the POS instant payment test.
 * Verifies pay-platform, provider-platform, and council-platform emitted traces.
 */
const JAEGER_QUERY_URL = Deno.env.get("JAEGER_QUERY_URL")!;

async function queryServices(): Promise<string[]> {
  const res = await fetch(`${JAEGER_QUERY_URL}/api/services`);
  const body = await res.json();
  return body.data ?? [];
}

async function queryTraces(service: string, limit = 20) {
  const res = await fetch(
    `${JAEGER_QUERY_URL}/api/traces?service=${service}&limit=${limit}`,
  );
  const body = await res.json();
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

await new Promise((r) => setTimeout(r, 5000));

console.log("\n=== POS Instant OTEL Trace Verification ===\n");

const services = await queryServices();
console.log("  Registered services:", services.join(", "));

check("pay-platform service registered", services.includes("pay-platform"));
check(
  "provider-platform service registered",
  services.includes("provider-platform"),
);
check(
  "council-platform service registered",
  services.includes("council-platform"),
);

if (services.includes("pay-platform")) {
  console.log("\n  Pay-platform:");
  const traces = await queryTraces("pay-platform");
  const spanCount = traces.reduce(
    (n: number, t: { spans: unknown[] }) => n + t.spans.length,
    0,
  );
  check(
    "Pay-platform has traces",
    traces.length > 0,
    `${traces.length} traces, ${spanCount} spans`,
  );
}

if (services.includes("provider-platform")) {
  console.log("\n  Provider-platform:");
  const traces = await queryTraces("provider-platform");
  const spanCount = traces.reduce(
    (n: number, t: { spans: unknown[] }) => n + t.spans.length,
    0,
  );
  check(
    "Provider-platform has traces",
    traces.length > 0,
    `${traces.length} traces, ${spanCount} spans`,
  );
}

console.log(`\n  Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n❌ OTEL verification failed");
  Deno.exit(1);
} else {
  console.log("\n✅ OTEL verification passed");
}
