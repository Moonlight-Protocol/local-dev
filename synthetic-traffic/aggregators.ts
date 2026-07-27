/**
 * Aggregator (pay-entity) driver — the settled RappiPay/Venmo types. One
 * pay-platform merchant account per (aggregator, country); invisible end
 * users are a small pool of funded customer wallets making the instant-flow
 * payment: prepare → classic payment to the merchant's OpEx → execute (the
 * platform deposits OpEx→channel and runs the temp-P256-hop bundle to the
 * merchant's receive UTXOs via the PP).
 *
 * Merchant receive-UTXO keys are freshly generated P-256 pubkeys (privates
 * discarded) — same ephemeral pattern the platform itself uses for temp hop
 * keys; synthetic merchant balances are display-only by design.
 */
import { Keypair } from "stellar-sdk";
import {
  Asset as Asset14,
  Keypair as Keypair14,
  Operation as Operation14,
} from "stellar-sdk-14";
import { Buffer } from "node:buffer";
import { submitClassicTx } from "../lib/soroban.ts";
import type { EngineEnv } from "./env.ts";
import type { KeyRing } from "./keys.ts";
import type { EngineState } from "./state.ts";
import { friendbotFund } from "./funding.ts";
import { type AggregatorSpec, COUNCILS } from "./scenario.ts";
import { registerEntity } from "../lib/client/register-entity.ts";

const CUSTOMER_POOL = 25;

async function payAuth(env: EngineEnv, kp: Keypair): Promise<string> {
  const ch = await (await fetch(`${env.payUrl}/api/v1/auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: kp.publicKey() }),
  })).json();
  const nonce: string = ch.data.nonce;
  const nonceBytes = Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0));
  const signature = Buffer.from(kp.sign(Buffer.from(nonceBytes))).toString(
    "base64",
  );
  const res = await fetch(`${env.payUrl}/api/v1/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, signature, publicKey: kp.publicKey() }),
  });
  if (!res.ok) throw new Error(`pay auth failed: ${res.status}`);
  return (await res.json()).data.token;
}

async function payApi(
  env: EngineEnv,
  jwt: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await fetch(`${env.payUrl}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(jwt ? { "Authorization": `Bearer ${jwt}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Mirror the engine's councils (+ ACTIVE providers) into pay-platform. */
export async function ensurePayMirror(
  env: EngineEnv,
  state: EngineState,
): Promise<void> {
  const admin = Keypair.fromSecret(env.payAdminSecret);
  await friendbotFund(env, admin.publicKey());
  const jwt = await payAuth(env, admin);
  const listRes = await payApi(env, jwt, "GET", "/admin/councils");
  if (!listRes.ok) {
    throw new Error(`pay admin councils list: ${listRes.status}`);
  }
  const existing = new Set(
    (((await listRes.json()).data ?? []) as Array<{ channelAuthId: string }>)
      .map((c) => c.channelAuthId),
  );
  // The PP verifies bundle submitters: pay-platform's service key must be a
  // registered entity with every PP it submits through.
  const paySvc = Keypair.fromSecret(env.payServiceSecret);
  await friendbotFund(env, paySvc.publicKey());
  for (const p of Object.values(state.providers)) {
    if (!p.membershipActive) continue;
    try {
      await registerEntity(
        env.providerUrl,
        p.publicKey,
        paySvc,
        "Moonlight Pay",
        [
          p.country,
        ],
      );
    } catch { /* 409 already-approved is fine */ }
  }

  for (const c of Object.values(state.councils)) {
    if (existing.has(c.authId)) continue;
    const providers = Object.values(state.providers)
      .filter((p) => p.councilKey === c.key && p.membershipActive)
      .map((p) => ({
        publicKey: p.publicKey,
        providerUrl: env.providerInternalUrl,
        label: p.key,
      }));
    // Jurisdictions from the scenario spec, NOT from currently-active
    // providers — late joiners' countries must match at prepare time.
    const jurisdictions = COUNCILS.find((s) =>
      s.key === c.key
    )?.jurisdictions ?? [];
    const res = await payApi(env, jwt, "POST", "/admin/councils", {
      name: c.key,
      channelAuthId: c.authId,
      councilUrl: env.councilInternalUrl,
      active: true,
      channels: Object.entries(c.channels).map(([assetCode, channelId]) => ({
        assetCode,
        assetContractId: c.assets[assetCode],
        privacyChannelId: channelId,
        active: true,
      })),
      jurisdictions,
      providers,
    });
    if (!res.ok) {
      throw new Error(
        `pay mirror ${c.key}: ${res.status} ${await res.text()}`,
      );
    }
    console.log(`[aggregator] pay mirror: ${c.key}`);
  }
}

/** Random valid P-256 pubkey (uncompressed point), private discarded. */
async function randomP256PubkeyB64(): Promise<string> {
  const key = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", key.publicKey),
  );
  return Buffer.from(raw).toString("base64");
}

export async function setupMerchant(
  env: EngineEnv,
  ring: KeyRing,
  spec: AggregatorSpec,
  country: string,
): Promise<void> {
  const wallet = await ring.aggregator(spec.key, country);
  const opex = await ring.aggregatorOpex(spec.key, country);
  await friendbotFund(env, wallet.publicKey());
  await friendbotFund(env, opex.publicKey());
  const jwt = await payAuth(env, Keypair.fromSecret(wallet.secret()));

  let res = await payApi(env, jwt, "POST", "/account", {
    email: `${spec.key}-${country.toLowerCase()}@synthetic.moonlight.test`,
    jurisdictionCountryCode: country,
    displayName: `${spec.name} ${country}`,
  });
  if (!res.ok) {
    throw new Error(`pay account: ${res.status} ${await res.text()}`);
  }

  res = await payApi(env, jwt, "POST", "/account/opex", {
    secretKey: opex.secret(),
    publicKey: opex.publicKey(),
    feePct: 1,
  });
  if (!res.ok) throw new Error(`pay opex: ${res.status} ${await res.text()}`);

  // Delegated root: the platform derives merchant receive-UTXO keys itself
  // from a registered 32-byte root (deterministic from the merchant key, so
  // nothing to store).
  const utxoRoot = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new Uint8Array(wallet.rawSecretKey()),
    ),
  );
  res = await payApi(env, jwt, "POST", "/account/delegation-key", {
    utxoRoot: Buffer.from(utxoRoot).toString("base64"),
  });
  if (!res.ok) {
    throw new Error(`pay delegation-key: ${res.status} ${await res.text()}`);
  }
  console.log(`[aggregator] merchant ready: ${spec.name} ${country}`);
}

/** One invisible-end-user payment through the instant flow. */
export async function aggregatorPayment(
  env: EngineEnv,
  ring: KeyRing,
  state: EngineState,
  spec: AggregatorSpec,
  country: string,
  amountXlm: number,
  customerIdx: number,
): Promise<void> {
  const merchant = await ring.aggregator(spec.key, country);
  const customer = await ring.aggregatorUser(
    spec.key,
    country,
    customerIdx % CUSTOMER_POOL,
  );
  await friendbotFund(env, customer.publicKey());

  const prepRes = await payApi(env, null, "POST", "/pay/instant/prepare", {
    merchantWallet: merchant.publicKey(),
    amountXlm,
    customerWallet: customer.publicKey(),
    assetCode: "XLM",
  });
  if (!prepRes.ok) {
    throw new Error(`prepare: ${prepRes.status} ${await prepRes.text()}`);
  }
  const prep = (await prepRes.json()).data;
  if (!prep.opex?.publicKey) throw new Error("prepare returned no opex");

  // The customer's ordinary on-chain payment to the merchant's OpEx.
  const sdk14 = await import("stellar-sdk-14");
  const server = new sdk14.rpc.Server(env.rpcUrl, { allowHttp: env.isLocal });
  const tx = await submitClassicTx(
    server,
    Keypair14.fromSecret(customer.secret()),
    env.networkPassphrase,
    [
      Operation14.payment({
        destination: prep.opex.publicKey,
        asset: Asset14.native(),
        amount: String(amountXlm),
      }),
    ],
  );

  const execRes = await payApi(env, null, "POST", "/pay/instant/execute", {
    customerPaymentHash: tx.txHash,
    merchantWallet: merchant.publicKey(),
    amountStroops: prep.amountStroops,
    assetCode: "XLM",
    merchantUtxoIndexes: prep.merchantUtxos.map(
      (u: { derivationIndex: number }) => u.derivationIndex,
    ),
  });
  if (!execRes.ok) {
    throw new Error(`execute: ${execRes.status} ${await execRes.text()}`);
  }
  state.totals.bundles++;
  state.totals.deposits++;
}
