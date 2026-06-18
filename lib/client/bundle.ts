import type { Config } from "./config.ts";
import { withE2ESpan } from "./tracer.ts";

export function submitBundle(
  jwt: string,
  operationsMLXDR: string[],
  config: Config,
): Promise<string> {
  return withE2ESpan("bundle.submit", async () => {
    const maxRetries = 10;
    const retryDelayMs = 5_000;
    const url = config.urlShape === "single-pp"
      ? `${config.providerUrl}/api/v1/provider/entity/bundles`
      : `${config.providerUrl}/api/v1/providers/${config.ppPublicKey}/entity/bundles`;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          operationsMLXDR,
          channelContractId: config.channelContractId,
        }),
      });

      if (res.status === 429) {
        await res.text();
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }

      if (!res.ok) {
        throw new Error(
          `Bundle submission failed: ${res.status} ${await res.text()}`,
        );
      }

      const data = await res.json();
      return data.data.operationsBundleId;
    }

    throw new Error(
      `Bundle submission failed: rate limited after ${maxRetries} retries`,
    );
  });
}

export function waitForBundle(
  jwt: string,
  bundleId: string,
  config: Config,
  timeoutMs = 120_000,
  pollIntervalMs = 5_000,
): Promise<void> {
  return withE2ESpan("bundle.wait", async () => {
    const start = Date.now();
    const url = config.urlShape === "single-pp"
      ? `${config.providerUrl}/api/v1/provider/entity/bundles/${bundleId}`
      : `${config.providerUrl}/api/v1/providers/${config.ppPublicKey}/entity/bundles/${bundleId}`;

    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));

      const res = await fetch(url, {
        headers: { "Authorization": `Bearer ${jwt}` },
      });

      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }

      if (!res.ok) {
        throw new Error(
          `Bundle poll failed: ${res.status} ${await res.text()}`,
        );
      }

      const data = await res.json();
      const status = data.data.status;

      if (status === "COMPLETED") {
        return;
      }
      if (status === "FAILED" || status === "EXPIRED") {
        throw new Error(`Bundle ${bundleId} ${status}`);
      }
    }

    throw new Error(`Bundle ${bundleId} timed out after ${timeoutMs}ms`);
  });
}
