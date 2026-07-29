/**
 * Entity actors: lifecycle steps (connect → register → transact) and the
 * three chain-shaped actions, built directly on lib/client — the exact
 * production path (SEP-10 session, per-PP entity registration, MLXDR bundles
 * through the provider API).
 */
import { Keypair } from "stellar-sdk";
import { NetworkConfig } from "@colibri/core";
import type { StellarNetworkId } from "@moonlight/moonlight-sdk";
import type { Config } from "../lib/client/config.ts";
import { authenticate } from "../lib/client/auth.ts";
import { registerEntity } from "../lib/client/register-entity.ts";
import { deposit } from "../lib/client/deposit.ts";
import { prepareReceive } from "../lib/client/receive.ts";
import { send } from "../lib/client/send.ts";
import { withdraw } from "../lib/client/withdraw.ts";
import { injectFailingBundle } from "../lib/client/fail-inject.ts";
import type { EngineEnv } from "./env.ts";
import type { KeyRing } from "./keys.ts";
import type { CouncilState, EngineState, EntityState } from "./state.ts";
import { entityKey } from "./state.ts";
import { friendbotFund } from "./funding.ts";
import { grantUsdc } from "./bootstrap.ts";

/**
 * lib/client Config for (council, asset, pp) — built directly instead of via
 * env-var mutation (send-loop's approach) so concurrent actors can't race.
 */
export function clientConfig(
  env: EngineEnv,
  council: CouncilState,
  assetCode: string,
  ppPublicKey: string,
): Config {
  const channelContractId = council.channels[assetCode];
  const channelAssetContractId = council.assets[assetCode];
  if (!channelContractId || !channelAssetContractId) {
    throw new Error(`Council ${council.key} has no ${assetCode} channel`);
  }
  return {
    networkPassphrase: env.networkPassphrase,
    rpcUrl: env.rpcUrl,
    horizonUrl: env.horizonUrl,
    friendbotUrl: env.friendbotUrl,
    providerUrl: env.providerUrl,
    ppPublicKey,
    channelContractId: channelContractId as Config["channelContractId"],
    channelAuthId: council.authId as Config["channelAuthId"],
    channelAssetContractId:
      channelAssetContractId as Config["channelAssetContractId"],
    networkConfig: NetworkConfig.CustomNet({
      networkPassphrase: env.networkPassphrase,
      rpcUrl: env.rpcUrl,
      horizonUrl: env.horizonUrl,
      friendbotUrl: env.friendbotUrl,
      allowHttp: env.isLocal,
    }),
    networkId: env.networkPassphrase as StellarNetworkId,
    urlShape: "multi-pp",
  };
}

export async function connectEntity(
  env: EngineEnv,
  ring: KeyRing,
  state: EngineState,
  providerKey: string,
  index: number,
  name: string,
  wantsUsdc: boolean,
): Promise<EntityState> {
  const kp = await ring.entity(providerKey, index);
  await friendbotFund(env, kp.publicKey());
  if (wantsUsdc && (env.isLocal || env.usdcTreasurySecret)) {
    await grantUsdc(env, ring, kp.secret(), 500);
  }
  const key = entityKey(providerKey, index);
  const entity: EntityState = {
    providerKey,
    index,
    name,
    connected: true,
    registered: false,
    balances: {},
    deposits: 0,
    sends: 0,
    withdraws: 0,
  };
  state.entities[key] = entity;
  return entity;
}

export async function registerEntityActor(
  env: EngineEnv,
  ring: KeyRing,
  entity: EntityState,
  country: string,
  ppPublicKey: string,
): Promise<void> {
  const kp = await ring.entity(entity.providerKey, entity.index);
  await registerEntity(
    env.providerUrl,
    ppPublicKey,
    kp,
    entity.name,
    [country],
  );
  entity.registered = true;
}

async function sessionFor(
  ring: KeyRing,
  entity: EntityState,
  config: Config,
): Promise<{ kp: Keypair; jwt: string }> {
  const kp = await ring.entity(entity.providerKey, entity.index);
  const jwt = await authenticate(kp, config);
  return { kp, jwt };
}

export async function actDeposit(
  env: EngineEnv,
  ring: KeyRing,
  state: EngineState,
  entity: EntityState,
  council: CouncilState,
  ppPublicKey: string,
  assetCode: string,
  amount: number,
): Promise<void> {
  const config = clientConfig(env, council, assetCode, ppPublicKey);
  const { kp, jwt } = await sessionFor(ring, entity, config);
  await deposit(kp.secret(), amount, jwt, config);
  entity.balances[assetCode] = (entity.balances[assetCode] ?? 0) + amount;
  entity.deposits++;
  state.totals.deposits++;
  state.totals.bundles++;
}

export async function actSend(
  env: EngineEnv,
  ring: KeyRing,
  state: EngineState,
  sender: EntityState,
  receiver: EntityState,
  council: CouncilState,
  senderPpPublicKey: string,
  assetCode: string,
  amount: number,
): Promise<void> {
  const config = clientConfig(env, council, assetCode, senderPpPublicKey);
  const { kp, jwt } = await sessionFor(ring, sender, config);
  const receiverKp = await ring.entity(receiver.providerKey, receiver.index);
  // The receive "code": receiver-derived UTXO creates, shared out of band.
  const receiverOps = await prepareReceive(receiverKp.secret(), amount, config);
  await send(kp.secret(), receiverOps, amount, jwt, config);
  sender.balances[assetCode] = Math.max(
    0,
    (sender.balances[assetCode] ?? 0) - amount,
  );
  receiver.balances[assetCode] = (receiver.balances[assetCode] ?? 0) + amount;
  sender.sends++;
  state.totals.sends++;
  state.totals.bundles++;
}

/** Submit a deliberately failing (overspend) bundle — dashboard seasoning. */
export async function actFail(
  env: EngineEnv,
  ring: KeyRing,
  state: EngineState,
  entity: EntityState,
  council: CouncilState,
  ppPublicKey: string,
): Promise<void> {
  const config = clientConfig(env, council, "XLM", ppPublicKey);
  const { kp, jwt } = await sessionFor(ring, entity, config);
  await injectFailingBundle(kp.secret(), jwt, config);
  state.totals.bundles++;
}

export async function actWithdraw(
  env: EngineEnv,
  ring: KeyRing,
  state: EngineState,
  entity: EntityState,
  council: CouncilState,
  ppPublicKey: string,
  assetCode: string,
  amount: number,
): Promise<void> {
  const config = clientConfig(env, council, assetCode, ppPublicKey);
  const { kp, jwt } = await sessionFor(ring, entity, config);
  await withdraw(kp.secret(), kp.publicKey(), amount, jwt, config);
  entity.balances[assetCode] = Math.max(
    0,
    (entity.balances[assetCode] ?? 0) - amount,
  );
  entity.withdraws++;
  state.totals.withdraws++;
  state.totals.bundles++;
}
