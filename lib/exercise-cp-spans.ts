/**
 * Drive the council-platform endpoints whose handlers are wrapped in
 * withSpan, so the lifecycle/testnet flows actually emit:
 *
 *   - Channel.queryState                      (GET  /council/channels/:id)
 *   - Custody.registerUser                    (POST /council/sign/register)
 *   - KeyDerivation.deriveP256Keypair         (called from registerUser)
 *   - Custody.getUserPublicKeys               (POST /council/sign/keys)
 *   - KeyDerivation.signWithDerivedKey        (POST /council/sign/spend)
 *   - Escrow.getRecipientUtxos                (GET  /council/recipient/:addr/utxos)
 *   - Escrow.create                           (POST /council/escrow)
 *   - Escrow.getSummary                       (GET  /council/escrow/:addr)
 *   - Escrow.releaseForRecipient              (POST /council/escrow/:addr/release)
 *
 * Each call is wrapped in withE2ESpan so Deno's auto-instrumented fetch
 * propagates a W3C traceparent header, giving us SDK-driver↔council-platform
 * trace continuity to assert against.
 */
import { withE2ESpan } from "../e2e/tracer.ts";

export interface ExerciseCouncilSpansConfig {
  councilUrl: string;
  /** JWT minted by /admin/auth/verify for the *PP operator* (must be an ACTIVE provider). */
  ppCouncilJwt: string;
  /** JWT minted by /admin/auth/verify for the council *admin* (owner). */
  adminCouncilJwt: string;
  councilId: string;
  channelContractId: string;
  /** Council DB row id returned by addChannelHandler — used to call GET /council/channels/:id. */
  channelDbId: string;
  /** Stellar G... address used as recipient + custodial-user external id seed. */
  recipientAddress: string;
  /** Provider operator address (sender for escrow create). */
  senderAddress: string;
  assetCode: string;
}

async function postJson(
  url: string,
  jwt: string,
  body: unknown,
): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  });
}

async function getJson(url: string, jwt: string): Promise<Response> {
  return await fetch(url, {
    headers: { "Authorization": `Bearer ${jwt}` },
  });
}

function logResult(res: Response, label: string, body: string): void {
  if (!res.ok) {
    // The goal is to *exercise* cp's withSpan-wrapped handlers so the
    // cp#28 spans emit. The handler runs (and its span emits) even on
    // 4xx/5xx — e.g. Escrow.releaseForRecipient legitimately 500s on a
    // freshly-created council with no on-chain UTXOs to release. Log
    // the failure and move on; the verifier asserts on span counts.
    console.log(`    ⚠️  ${label} returned ${res.status}: ${body.slice(0, 200)}`);
  }
}

export async function exerciseCouncilSpans(
  config: ExerciseCouncilSpansConfig,
): Promise<void> {
  const {
    councilUrl,
    ppCouncilJwt,
    adminCouncilJwt,
    councilId,
    channelContractId,
    channelDbId,
    recipientAddress,
    senderAddress,
    assetCode,
  } = config;
  const externalId = `cp-spans-${Date.now()}`;

  console.log("\n  Exercising council-platform cp#28 spans...");

  // 1. Channel.queryState — admin-only handler
  await withE2ESpan("e2e.cp.get_channel", async () => {
    const res = await getJson(
      `${councilUrl}/api/v1/council/channels/${encodeURIComponent(channelDbId)}`,
      adminCouncilJwt,
    );
    const text = await res.text();
    logResult(res, "GET /council/channels/:id", text);
    console.log("    Channel.queryState: triggered");
  });

  // 2. Custody.registerUser + KeyDerivation.deriveP256Keypair
  await withE2ESpan("e2e.cp.sign_register", async () => {
    const res = await postJson(
      `${councilUrl}/api/v1/council/sign/register`,
      ppCouncilJwt,
      { councilId, externalId, channelContractId },
    );
    const text = await res.text();
    logResult(res, "POST /council/sign/register", text);
    console.log("    Custody.registerUser + KeyDerivation.deriveP256Keypair: triggered");
  });

  // 3. Custody.getUserPublicKeys (covers KeyDerivation.deriveP256Keypair via cache miss path)
  await withE2ESpan("e2e.cp.sign_keys", async () => {
    const res = await postJson(
      `${councilUrl}/api/v1/council/sign/keys`,
      ppCouncilJwt,
      { councilId, externalId, channelContractId, indices: [0, 1, 2] },
    );
    const text = await res.text();
    logResult(res, "POST /council/sign/keys", text);
    console.log("    Custody.getUserPublicKeys: triggered");
  });

  // 4. KeyDerivation.signWithDerivedKey (32-byte hex message → fake operation hash)
  await withE2ESpan("e2e.cp.sign_spend", async () => {
    const message = "00".repeat(32); // 32-byte zero message — backend just signs whatever we hand it
    const res = await postJson(
      `${councilUrl}/api/v1/council/sign/spend`,
      ppCouncilJwt,
      {
        councilId,
        channelContractId,
        spends: [{ externalId, utxoIndex: 0, message }],
      },
    );
    const text = await res.text();
    logResult(res, "POST /council/sign/spend", text);
    console.log("    KeyDerivation.signWithDerivedKey: triggered");
  });

  // 5. Escrow.getRecipientUtxos
  await withE2ESpan("e2e.cp.recipient_utxos", async () => {
    const url = `${councilUrl}/api/v1/council/recipient/${
      encodeURIComponent(recipientAddress)
    }/utxos?channelContractId=${encodeURIComponent(channelContractId)}` +
      `&councilId=${encodeURIComponent(councilId)}&count=1`;
    const res = await getJson(url, ppCouncilJwt);
    const text = await res.text();
    logResult(res, "GET /council/recipient/:addr/utxos", text);
    console.log("    Escrow.getRecipientUtxos: triggered");
  });

  // 6. Escrow.create
  await withE2ESpan("e2e.cp.escrow_create", async () => {
    const res = await postJson(
      `${councilUrl}/api/v1/council/escrow`,
      ppCouncilJwt,
      {
        councilId,
        senderAddress,
        recipientAddress,
        amount: "1000",
        assetCode,
        channelContractId,
      },
    );
    const text = await res.text();
    logResult(res, "POST /council/escrow", text);
    console.log("    Escrow.create: triggered");
  });

  // 7. Escrow.getSummary
  await withE2ESpan("e2e.cp.escrow_summary", async () => {
    const res = await getJson(
      `${councilUrl}/api/v1/council/escrow/${
        encodeURIComponent(recipientAddress)
      }`,
      ppCouncilJwt,
    );
    const text = await res.text();
    logResult(res, "GET /council/escrow/:addr", text);
    console.log("    Escrow.getSummary: triggered");
  });

  // 8. Escrow.releaseForRecipient
  await withE2ESpan("e2e.cp.escrow_release", async () => {
    const res = await postJson(
      `${councilUrl}/api/v1/council/escrow/${
        encodeURIComponent(recipientAddress)
      }/release`,
      ppCouncilJwt,
      { channelContractId },
    );
    const text = await res.text();
    logResult(res, "POST /council/escrow/:addr/release", text);
    console.log("    Escrow.releaseForRecipient: triggered");
  });

  console.log("  cp#28 spans exercised\n");
}
