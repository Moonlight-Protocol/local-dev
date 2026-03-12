import type { Config } from "./config.ts";
import { withE2ESpan } from "./tracer.ts";

export async function submitBundle(
  jwt: string,
  operationsMLXDR: string[],
  config: Config,
): Promise<string> {
  return withE2ESpan("bundle.submit", async () => {
    const maxRetries = 10;
    const retryDelayMs = 5_000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const res = await fetch(`${config.providerUrl}/api/v1/bundle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${jwt}`,
        },
        body: JSON.stringify({ operationsMLXDR }),
      });

      if (res.status === 429) {
        await res.text(); // drain body
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

    throw new Error(`Bundle submission failed: rate limited after ${maxRetries} retries`);
  });
}

export async function waitForBundle(
  jwt: string,
  bundleId: string,
  config: Config,
  timeoutMs = 120_000,
  pollIntervalMs = 5_000,
): Promise<void> {
  return withE2ESpan("bundle.wait", async () => {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));

      const res = await fetch(
        `${config.providerUrl}/api/v1/bundle/${bundleId}`,
        { headers: { "Authorization": `Bearer ${jwt}` } },
      );

      // Retry on rate limit
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
