/**
 * Reconciler creation paths: councils and providers come into existence here,
 * on their scheduled virtual days — the bootstrap-as-history mechanic. All
 * contract deploys go through the Stellar Registry CLI; all platform state is
 * created through the production APIs.
 */
// lib/deploy.ts + lib/admin.ts are pinned to stellar-sdk 14.2.0 (same as the
// setup scripts); keypairs/servers passed to them must come from that version.
import { Keypair as Keypair14, rpc as rpc14 } from "stellar-sdk-14";
import { Buffer } from "node:buffer";
import {
  deployPrivacyChannel,
  getOrDeployCustomSac,
  getOrDeployNativeSac,
} from "../lib/deploy.ts";
import { addProvider } from "../lib/admin.ts";
import { establishTrustline, issueAssetTo } from "../lib/classic-asset.ts";
import { submitClassicTx } from "../lib/soroban.ts";
import { Asset as Asset14, Operation as Operation14 } from "stellar-sdk-14";
import type { EngineEnv } from "./env.ts";
import type { KeyRing } from "./keys.ts";
import type { CouncilSpec } from "./scenario.ts";
import type { ProviderSlot } from "./timeline.ts";
import type { CouncilState, EngineState, ProviderState } from "./state.ts";
import {
  contractName,
  deployNamed,
  fetchContractId,
  fetchWasmHash,
  publishWasm,
  registerContract,
  WASM_NAMES,
} from "./registry.ts";
import { friendbotFund } from "./funding.ts";
import {
  addCouncilChannel,
  addCouncilJurisdiction,
  approveJoinRequest,
  councilAdminAuth,
  createCouncilMetadata,
  pollMembershipActive,
  providerDashboardAuth,
  registerPp,
  submitJoinRequest,
} from "./platform.ts";

export const CONTRACTS_VERSION = Deno.env.get("SYNTRAF_CONTRACTS_VERSION") ??
  "0.5.0";

/** Circle's testnet USDC issuer (no local issuance on testnet). */
const CIRCLE_TESTNET_USDC_ISSUER =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function server14(env: EngineEnv): rpc14.Server {
  return new rpc14.Server(env.rpcUrl, { allowHttp: env.isLocal });
}

async function ensureWasmsPublished(
  env: EngineEnv,
  state: EngineState,
  sourceSecret: string,
): Promise<void> {
  const wasms: Array<[string, string]> = [
    [WASM_NAMES.council, `${env.wasmDir}/channel_auth_contract.wasm`],
    [WASM_NAMES.channel, `${env.wasmDir}/privacy_channel.wasm`],
  ];
  for (const [name, path] of wasms) {
    const stamp = `${name}@${CONTRACTS_VERSION}`;
    if (state.publishedWasms[stamp]) continue;
    console.log(`[registry] publish ${stamp}`);
    await publishWasm(env, sourceSecret, name, path, CONTRACTS_VERSION);
    state.publishedWasms[stamp] = new Date().toISOString();
  }
}

async function usdcIssuer(env: EngineEnv, ring: KeyRing): Promise<string> {
  if (!env.isLocal) return CIRCLE_TESTNET_USDC_ISSUER;
  return (await ring.usdcIssuer()).publicKey();
}

/** Create one council: contracts via registry, metadata via council-platform. */
export async function bootstrapCouncil(
  env: EngineEnv,
  ring: KeyRing,
  state: EngineState,
  spec: CouncilSpec,
  day: number,
): Promise<CouncilState> {
  console.log(
    `\n[bootstrap] council "${spec.name}" (virtual day ${day.toFixed(2)})`,
  );
  const admin = await ring.councilAdmin(spec.key);
  await friendbotFund(env, admin.publicKey());

  await ensureWasmsPublished(env, state, env.registrySourceSecret);

  const authId = await deployNamed(
    env,
    env.registrySourceSecret,
    contractName(`syntraf-${spec.key}-council`),
    WASM_NAMES.council,
    CONTRACTS_VERSION,
    ["--admin", admin.publicKey()],
  );
  console.log(`  council (channel-auth): ${authId}`);

  const server = server14(env);
  const admin14 = Keypair14.fromSecret(admin.secret());
  const xlmSac = await getOrDeployNativeSac(
    server,
    admin14,
    env.networkPassphrase,
  );
  const usdcSac = await getOrDeployCustomSac(
    server,
    admin14,
    env.networkPassphrase,
    "USDC",
    await usdcIssuer(env, ring),
  );

  // Channels deploy directly (deployer = admin: the privacy-channel
  // constructor calls admin.require_auth(), which `stellar registry deploy`
  // cannot satisfy nested in recording mode — upstream CLI limitation), then
  // get named in the registry via register-contract.
  const channelWasmHash = Buffer.from(
    await fetchWasmHash(
      env,
      env.registrySourceSecret,
      WASM_NAMES.channel,
      CONTRACTS_VERSION,
    ),
    "hex",
  );
  const channels: Record<string, string> = {};
  const assets: Record<string, string> = { XLM: xlmSac, USDC: usdcSac };
  for (const [code, sac] of Object.entries(assets)) {
    const name = contractName(
      `syntraf-${spec.key}-channel-${code.toLowerCase()}`,
    );
    const registered = await fetchContractId(
      env,
      env.registrySourceSecret,
      name,
    ).catch(() => null);
    if (registered) {
      channels[code] = registered;
      console.log(`  ${code} channel (registered): ${registered}`);
      continue;
    }
    const salt = Buffer.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`syntraf:${spec.key}:${code}`),
        ),
      ),
    );
    channels[code] = await deployPrivacyChannel(
      server,
      admin14,
      env.networkPassphrase,
      channelWasmHash,
      authId,
      sac,
      salt,
    );
    await registerContract(
      env,
      env.registrySourceSecret,
      name,
      channels[code],
    );
    console.log(`  ${code} channel: ${channels[code]}`);
  }

  const adminJwt = await councilAdminAuth(env.councilUrl, admin);
  await createCouncilMetadata(env.councilUrl, adminJwt, authId, spec.name);
  for (const [code, channelId] of Object.entries(channels)) {
    await addCouncilChannel(
      env.councilUrl,
      adminJwt,
      authId,
      channelId,
      code,
      assets[code],
    );
  }
  for (const j of spec.jurisdictions) {
    await addCouncilJurisdiction(env.councilUrl, adminJwt, authId, j);
  }

  const councilState: CouncilState = {
    key: spec.key,
    authId,
    channels,
    assets,
    formedAtDay: day,
  };
  state.councils[spec.key] = councilState;
  return councilState;
}

/** Full production join flow: register → join → approve → add_provider → ACTIVE. */
export async function bootstrapProvider(
  env: EngineEnv,
  ring: KeyRing,
  state: EngineState,
  slot: ProviderSlot,
  day: number,
): Promise<ProviderState> {
  const council = state.councils[slot.council.key];
  if (!council) {
    throw new Error(
      `Provider ${slot.key} due before council ${slot.council.key} exists`,
    );
  }
  console.log(
    `\n[bootstrap] provider "${slot.name}" (virtual day ${day.toFixed(2)})`,
  );

  const kp = await ring.provider(slot.key);
  await friendbotFund(env, kp.publicKey());

  // Each provider operates its own dashboard identity (wallet-auth), so the
  // console shows ~24 independent operators rather than one mega-operator.
  const dashboardJwt = await providerDashboardAuth(env.providerUrl, kp);
  await registerPp(env.providerUrl, dashboardJwt, kp, slot.index, slot.name);
  await submitJoinRequest(
    env.providerUrl,
    env.councilInternalUrl,
    dashboardJwt,
    kp,
    council.authId,
    slot.council.name,
    slot.name,
    slot.country,
  );

  const admin = await ring.councilAdmin(slot.council.key);
  const adminJwt = await councilAdminAuth(env.councilUrl, admin);
  await approveJoinRequest(
    env.councilUrl,
    adminJwt,
    council.authId,
    kp.publicKey(),
  );

  await addProvider(
    server14(env),
    Keypair14.fromSecret(admin.secret()),
    env.networkPassphrase,
    council.authId,
    kp.publicKey(),
  );

  await pollMembershipActive(env.providerUrl, kp.publicKey(), dashboardJwt);
  console.log("  membership ACTIVE");

  const providerState: ProviderState = {
    key: slot.key,
    councilKey: slot.council.key,
    country: slot.country,
    publicKey: kp.publicKey(),
    membershipActive: true,
    joinedAtDay: day,
  };
  state.providers[slot.key] = providerState;
  return providerState;
}

/**
 * Hand an entity classic USDC so USDC deposits are possible. Locally the
 * engine's derived issuer self-issues; on testnet a Circle-faucet-funded
 * treasury account (SYNTRAF_USDC_TREASURY_SECRET) pays real testnet USDC.
 * No treasury configured on testnet → no-op (engine stays XLM-only, logged
 * once at startup by main.ts).
 */
export async function grantUsdc(
  env: EngineEnv,
  ring: KeyRing,
  entitySecret: string,
  amount: number,
): Promise<void> {
  const entity = Keypair14.fromSecret(entitySecret);
  const server = server14(env);
  if (env.isLocal) {
    const issuer = Keypair14.fromSecret((await ring.usdcIssuer()).secret());
    await friendbotFund(env, issuer.publicKey());
    // issueAssetTo = trustline + issuer payment in one step.
    await issueAssetTo(
      server,
      issuer,
      entity,
      env.networkPassphrase,
      "USDC",
      String(amount),
    );
    return;
  }
  if (!env.usdcTreasurySecret) return;
  const treasury = Keypair14.fromSecret(env.usdcTreasurySecret);
  await establishTrustline(
    server,
    entity,
    env.networkPassphrase,
    "USDC",
    CIRCLE_TESTNET_USDC_ISSUER,
  );
  await submitClassicTx(server, treasury, env.networkPassphrase, [
    Operation14.payment({
      destination: entity.publicKey(),
      asset: new Asset14("USDC", CIRCLE_TESTNET_USDC_ISSUER),
      amount: String(amount),
    }),
  ]);
}
