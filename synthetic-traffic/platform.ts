/**
 * council-platform + provider-platform HTTP surface used by the reconciler.
 * Mirrors setup-c.ts / setup-pp.ts exactly (same production-API-only
 * philosophy — no DB writes, no shortcuts). Kept self-contained inside
 * synthetic-traffic/ so the engine ships as one reviewable unit; if Gorka
 * prefers, these can later be extracted to lib/ and shared with the setup
 * scripts.
 */
import { Keypair } from "stellar-sdk";
import { Buffer } from "node:buffer";

export async function warmupService(name: string, url: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${url}/api/v1/health`);
      await res.body?.cancel();
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${name} not reachable at ${url}`);
}

/** Challenge/verify wallet auth (council admin + provider dashboard). */
export async function walletAuth(
  baseUrl: string,
  authRoute: string,
  keypair: Keypair,
): Promise<string> {
  const challengeRes = await fetch(`${baseUrl}${authRoute}/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: keypair.publicKey() }),
  });
  if (!challengeRes.ok) {
    throw new Error(
      `Auth challenge failed (${baseUrl}${authRoute}): ${challengeRes.status} ${await challengeRes
        .text()}`,
    );
  }
  const { data: { nonce } } = await challengeRes.json();

  const nonceBytes = Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0));
  const sig = keypair.sign(Buffer.from(nonceBytes));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));

  const verifyRes = await fetch(`${baseUrl}${authRoute}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, signature, publicKey: keypair.publicKey() }),
  });
  if (!verifyRes.ok) {
    throw new Error(
      `Auth verify failed (${baseUrl}${authRoute}): ${verifyRes.status} ${await verifyRes
        .text()}`,
    );
  }
  const { data: { token } } = await verifyRes.json();
  return token;
}

export function councilAdminAuth(
  councilUrl: string,
  admin: Keypair,
): Promise<string> {
  return walletAuth(councilUrl, "/api/v1/admin/auth", admin);
}

export function providerDashboardAuth(
  providerUrl: string,
  operator: Keypair,
): Promise<string> {
  return walletAuth(providerUrl, "/api/v1/dashboard/auth", operator);
}

async function expectOk(res: Response, what: string): Promise<void> {
  if (!res.ok) {
    throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
  }
  await res.body?.cancel();
}

export async function createCouncilMetadata(
  councilUrl: string,
  adminJwt: string,
  councilId: string,
  name: string,
): Promise<void> {
  const res = await fetch(`${councilUrl}/api/v1/council/metadata`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${adminJwt}`,
    },
    body: JSON.stringify({
      councilId,
      name,
      description: `${name} — Moonlight council`,
      contactEmail: "synthetic-traffic@moonlight.test",
    }),
  });
  await expectOk(res, `Create council ${name}`);
}

export async function addCouncilChannel(
  councilUrl: string,
  adminJwt: string,
  councilId: string,
  channelContractId: string,
  assetCode: string,
  assetContractId: string,
): Promise<void> {
  const res = await fetch(
    `${councilUrl}/api/v1/council/channels?councilId=${
      encodeURIComponent(councilId)
    }`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${adminJwt}`,
      },
      body: JSON.stringify({
        channelContractId,
        assetCode,
        assetContractId,
        label: `${assetCode} channel`,
      }),
    },
  );
  await expectOk(res, `Add ${assetCode} channel`);
}

export async function addCouncilJurisdiction(
  councilUrl: string,
  adminJwt: string,
  councilId: string,
  countryCode: string,
): Promise<void> {
  const res = await fetch(
    `${councilUrl}/api/v1/council/jurisdictions?councilId=${
      encodeURIComponent(councilId)
    }`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${adminJwt}`,
      },
      body: JSON.stringify({ countryCode }),
    },
  );
  await expectOk(res, `Add jurisdiction ${countryCode}`);
}

async function signJoinEnvelope<T>(
  payload: T,
  keypair: Keypair,
): Promise<
  { payload: T; signature: string; publicKey: string; timestamp: number }
> {
  const timestamp = Date.now();
  const canonical = JSON.stringify({ payload, timestamp });
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
  const signature = Buffer.from(keypair.sign(Buffer.from(hash))).toString(
    "base64",
  );
  return { payload, signature, publicKey: keypair.publicKey(), timestamp };
}

export async function registerPp(
  providerUrl: string,
  dashboardJwt: string,
  kp: Keypair,
  derivationIndex: number,
  label: string,
): Promise<void> {
  const res = await fetch(`${providerUrl}/api/v1/dashboard/pp/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${dashboardJwt}`,
    },
    body: JSON.stringify({
      secretKey: kp.secret(),
      derivationIndex,
      label,
    }),
  });
  await expectOk(res, `PP register ${label}`);
}

export async function submitJoinRequest(
  providerUrl: string,
  councilUrl: string,
  dashboardJwt: string,
  kp: Keypair,
  councilId: string,
  councilName: string,
  label: string,
  jurisdiction: string,
): Promise<void> {
  const joinPayload = {
    publicKey: kp.publicKey(),
    councilId,
    label,
    contactEmail: `${jurisdiction.toLowerCase()}-pp@synthetic.moonlight.test`,
    jurisdictions: [jurisdiction],
    callbackEndpoint: Deno.env.get("SYNTRAF_PROVIDER_INTERNAL_URL") ??
      providerUrl,
  };
  const signedEnvelope = await signJoinEnvelope(joinPayload, kp);
  const res = await fetch(
    `${providerUrl}/api/v1/providers/${
      encodeURIComponent(kp.publicKey())
    }/council/join`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${dashboardJwt}`,
      },
      body: JSON.stringify({
        councilUrl,
        councilId,
        councilName,
        label,
        contactEmail:
          `${jurisdiction.toLowerCase()}-pp@synthetic.moonlight.test`,
        signedEnvelope,
      }),
    },
  );
  await expectOk(res, `Join request ${label}`);
}

export async function approveJoinRequest(
  councilUrl: string,
  adminJwt: string,
  councilId: string,
  ppPublicKey: string,
): Promise<void> {
  const listRes = await fetch(
    `${councilUrl}/api/v1/council/provider-requests?councilId=${
      encodeURIComponent(councilId)
    }`,
    { headers: { "Authorization": `Bearer ${adminJwt}` } },
  );
  if (!listRes.ok) {
    throw new Error(
      `List join requests failed: ${listRes.status} ${await listRes.text()}`,
    );
  }
  const { data: requests } = await listRes.json();
  const ours = requests?.find?.(
    (r: { publicKey: string }) => r.publicKey === ppPublicKey,
  );
  if (!ours) {
    throw new Error(
      `Join request for ${ppPublicKey} not found among ${
        requests?.length ?? 0
      }`,
    );
  }
  const approveRes = await fetch(
    `${councilUrl}/api/v1/council/provider-requests/${ours.id}/approve`,
    { method: "POST", headers: { "Authorization": `Bearer ${adminJwt}` } },
  );
  await expectOk(approveRes, `Approve join ${ppPublicKey}`);
}

export async function pollMembershipActive(
  providerUrl: string,
  ppPublicKey: string,
  dashboardJwt: string,
  maxAttempts = 90,
  intervalMs = 2000,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(
      `${providerUrl}/api/v1/providers/${
        encodeURIComponent(ppPublicKey)
      }/council/membership`,
      { headers: { "Authorization": `Bearer ${dashboardJwt}` } },
    );
    if (res.status === 200) {
      const { data } = await res.json();
      if (data?.status === "ACTIVE") return;
    } else {
      await res.body?.cancel();
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Membership for ${ppPublicKey} did not become ACTIVE`);
}
