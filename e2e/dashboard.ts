import { Buffer } from "buffer";
import { Keypair } from "stellar-sdk";
import type { Config } from "./config.ts";
import { withE2ESpan } from "./tracer.ts";

/**
 * Dashboard E2E test — verifies the provider console API endpoints.
 *
 * Authenticates as the PP operator via dashboard auth (Ed25519 challenge/verify),
 * then hits each dashboard endpoint and validates the response structure.
 */

interface DashboardTestConfig {
  config: Config;
  providerSecretKey: string;
}

function dashboardAuth(
  providerUrl: string,
  keypair: Keypair,
): Promise<string> {
  return withE2ESpan("dashboard.auth", async () => {
    const publicKey = keypair.publicKey();

    // 1. Request challenge
    const challengeRes = await fetch(
      `${providerUrl}/api/v1/dashboard/auth/challenge`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey }),
      },
    );
    if (!challengeRes.ok) {
      throw new Error(
        `Dashboard challenge failed: ${challengeRes.status} ${await challengeRes
          .text()}`,
      );
    }
    const { data: { nonce } } = await challengeRes.json();

    // 2. Sign nonce
    const nonceBuffer = Buffer.from(nonce, "base64");
    const sigBuffer = keypair.sign(nonceBuffer);
    const signature = sigBuffer.toString("base64");

    // 3. Verify
    const verifyRes = await fetch(
      `${providerUrl}/api/v1/dashboard/auth/verify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce, signature, publicKey }),
      },
    );
    if (!verifyRes.ok) {
      throw new Error(
        `Dashboard verify failed: ${verifyRes.status} ${await verifyRes
          .text()}`,
      );
    }
    const { data: { token } } = await verifyRes.json();

    if (!token) throw new Error("No token in dashboard auth response");
    return token;
  });
}

async function fetchDashboard(
  providerUrl: string,
  token: string,
  path: string,
): Promise<unknown> {
  const res = await fetch(`${providerUrl}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  }
  const contentType = res.headers.get("Content-Type") || "";
  if (contentType.includes("text/csv")) {
    return res.text();
  }
  return res.json();
}

function assertField(obj: unknown, path: string): void {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (
      current === null || current === undefined || typeof current !== "object"
    ) {
      throw new Error(`Missing field: ${path} (stopped at ${part})`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (current === undefined) {
    throw new Error(`Missing field: ${path}`);
  }
}

export async function dashboardE2E(
  { config, providerSecretKey }: DashboardTestConfig,
): Promise<void> {
  const keypair = Keypair.fromSecret(providerSecretKey);
  const providerUrl = config.providerUrl;

  // 1. Authenticate
  console.log("  [dashboard] Authenticating as operator...");
  const token = await dashboardAuth(providerUrl, keypair);
  console.log("  [dashboard] Authenticated");

  // 2. Channels
  await withE2ESpan("dashboard.channels", async () => {
    console.log("  [dashboard] GET /dashboard/channels...");
    const res = await fetchDashboard(providerUrl, token, "/dashboard/channels");
    assertField(res, "data.channels");
    assertField(res, "data.summary.total");
    assertField(res, "data.summary.active");
    assertField(res, "data.summary.pending");
    assertField(res, "data.summary.inactive");
    console.log("  [dashboard] Channels OK");
  });

  // 3. Mempool
  await withE2ESpan("dashboard.mempool", async () => {
    console.log("  [dashboard] GET /dashboard/mempool...");
    const res = await fetchDashboard(providerUrl, token, "/dashboard/mempool");
    assertField(res, "data.platformVersion");
    assertField(res, "data.live.totalSlots");
    assertField(res, "data.live.totalBundles");
    assertField(res, "data.averages.sampleCount");
    assertField(res, "data.config.slotCapacity");
    console.log("  [dashboard] Mempool OK");
  });

  // 4. Operations
  await withE2ESpan("dashboard.operations", async () => {
    console.log("  [dashboard] GET /dashboard/operations...");
    const res = await fetchDashboard(
      providerUrl,
      token,
      "/dashboard/operations",
    );
    assertField(res, "data.bundles.total");
    assertField(res, "data.bundles.successRate");
    assertField(res, "data.transactions.total");
    console.log("  [dashboard] Operations OK");
  });

  // 5. Treasury
  await withE2ESpan("dashboard.treasury", async () => {
    console.log("  [dashboard] GET /dashboard/treasury...");
    const res = await fetchDashboard(
      providerUrl,
      token,
      `/dashboard/treasury?ppPublicKey=${keypair.publicKey()}`,
    );
    assertField(res, "data.address");
    assertField(res, "data.balances");
    console.log("  [dashboard] Treasury OK");
  });

  // 6. Audit export
  await withE2ESpan("dashboard.audit_export", async () => {
    console.log("  [dashboard] GET /dashboard/audit-export...");
    const csv = await fetchDashboard(
      providerUrl,
      token,
      "/dashboard/audit-export?status=COMPLETED",
    ) as string;
    if (typeof csv !== "string" || !csv.startsWith("id,")) {
      throw new Error(
        `Audit export returned unexpected format: ${String(csv).slice(0, 100)}`,
      );
    }
    console.log(
      `  [dashboard] Audit export OK (${csv.split("\n").length - 1} rows)`,
    );
  });

  // 7. Verify unauthenticated access is blocked
  await withE2ESpan("dashboard.auth_required", async () => {
    console.log("  [dashboard] Verifying auth is required...");
    const res = await fetch(`${providerUrl}/api/v1/dashboard/channels`);
    if (res.status !== 401 && res.status !== 403) {
      throw new Error(
        `Expected 401/403 for unauthenticated request, got ${res.status}`,
      );
    }
    console.log("  [dashboard] Auth enforcement OK");
  });

  console.log("  [dashboard] All dashboard checks passed");
}
