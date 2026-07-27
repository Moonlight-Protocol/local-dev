/**
 * synthetic-traffic — slow, continuous, realistic-looking Moonlight testnet
 * activity. NOT a load test.
 *
 * Each tick the reconciler compares the deterministic timeline ("what should
 * exist by virtual-now") with recorded state, creates whatever is due
 * (councils → providers → entities, bootstrap-as-history), then the planner
 * emits a Poisson-sampled, diurnally-shaped batch of deposit/send/withdraw
 * actions through the production APIs.
 *
 * TESTNET/LOCAL ONLY — see env.ts for the hard guard.
 *
 * Modes:
 *   deno task run                    # continuous loop (Fly instance mode)
 *   SYNTRAF_ONCE=true deno task run  # single tick (cron / smoke tests)
 */
import { loadEngineEnv } from "./env.ts";
import { KeyRing } from "./keys.ts";
import {
  emptyState,
  type EngineState,
  entityKey,
  loadState,
  saveState,
} from "./state.ts";
import {
  aggregatorEntries,
  councilFormationDay,
  entitySchedule,
  entityTarget,
  providerSlots,
  virtualDays,
} from "./timeline.ts";
import { COUNCILS, usdcEligible } from "./scenario.ts";
import { bootstrapCouncil, bootstrapProvider } from "./bootstrap.ts";
import {
  actDeposit,
  actFail,
  actSend,
  actWithdraw,
  connectEntity,
  registerEntityActor,
} from "./actors.ts";
import { describeDrop, firstDepositGateFactory, planTick } from "./traffic.ts";
import { discordAlert, ensureRunway } from "./funding.ts";
import {
  aggregatorPayment,
  ensurePayMirror,
  setupMerchant,
} from "./aggregators.ts";
import { AGGREGATORS } from "./scenario.ts";
import { Rng } from "./rng.ts";
import { archiveState, detectReset } from "./reset.ts";
import { warmupService } from "./platform.ts";

/** Per-tick creation bounds — a long-dead engine catches up over several
 * ticks instead of stampeding the platforms. Drops are logged, never silent. */
const MAX_ENTITY_CONNECTS_PER_TICK = 25;
const MAX_PROVIDERS_PER_TICK = 3;

async function reconcileRoster(
  env: ReturnType<typeof loadEngineEnv>,
  ring: KeyRing,
  state: EngineState,
  seed: string,
  nowDay: number,
): Promise<void> {
  // Councils due.
  for (const spec of COUNCILS) {
    if (state.councils[spec.key]) continue;
    const due = councilFormationDay(seed, spec);
    if (due <= nowDay) {
      await bootstrapCouncil(env, ring, state, spec, nowDay);
      saveState(env.stateFile, state);
    }
  }

  // Providers due (bounded per tick).
  let providersThisTick = 0;
  const slots = providerSlots(seed);
  for (const slot of slots) {
    if (state.providers[slot.key]) continue;
    if (!state.councils[slot.council.key]) continue;
    if (slot.joinDay > nowDay) continue;
    if (providersThisTick >= MAX_PROVIDERS_PER_TICK) {
      console.log("[reconcile] provider backlog remains; next tick continues");
      break;
    }
    await bootstrapProvider(env, ring, state, slot, nowDay);
    providersThisTick++;
    saveState(env.stateFile, state);
  }

  // Entity lifecycles due (connect, then register on their later day).
  let connects = 0;
  for (const slot of slots) {
    if (!state.providers[slot.key]?.membershipActive) continue;
    const target = entityTarget(seed, slot);
    for (let i = 0; i < target; i++) {
      const key = entityKey(slot.key, i);
      const existing = state.entities[key];
      const sched = entitySchedule(seed, slot, i);
      if (!existing) {
        if (sched.connectDay > nowDay) continue;
        if (connects >= MAX_ENTITY_CONNECTS_PER_TICK) continue;
        try {
          await connectEntity(
            env,
            ring,
            state,
            slot.key,
            i,
            sched.name,
            usdcEligible(i),
          );
          connects++;
        } catch (err) {
          console.error(
            `[reconcile] connect ${key} failed: ${(err as Error).message}`,
          );
        }
      } else if (!existing.registered && sched.registerDay <= nowDay) {
        try {
          await registerEntityActor(
            env,
            ring,
            existing,
            slot.country,
            state.providers[slot.key].publicKey,
          );
        } catch (err) {
          console.error(
            `[reconcile] register ${key} failed: ${(err as Error).message}`,
          );
        }
      }
    }
  }
  if (connects > 0) {
    console.log(`[reconcile] connected ${connects} new entities`);
  }

  // Aggregators (pay-platform instant flow), behind SYNTRAF_AGGREGATORS.
  for (const { spec, entryDay } of aggregatorEntries(seed)) {
    if (entryDay > nowDay || state.aggregators[spec.key]) continue;
    if (!env.aggregatorsEnabled) {
      console.log(
        `[reconcile] aggregator "${spec.name}" is due — driver disabled ` +
          `(SYNTRAF_AGGREGATORS=false)`,
      );
      continue;
    }
    await ensurePayMirror(env, state);
    const accounts: Record<string, { created: boolean }> = {};
    for (const country of spec.countries) {
      await setupMerchant(env, ring, spec, country);
      accounts[country] = { created: true };
    }
    state.aggregators[spec.key] = {
      key: spec.key,
      accounts,
      enteredAtDay: nowDay,
    };
    saveState(env.stateFile, state);
  }
}

async function runTraffic(
  env: ReturnType<typeof loadEngineEnv>,
  ring: KeyRing,
  state: EngineState,
  seed: string,
  nowDay: number,
  nowMs: number,
): Promise<void> {
  const slots = providerSlots(seed);
  const gate = firstDepositGateFactory(seed, slots, nowDay);
  const planned = planTick(
    seed,
    state,
    slots,
    state.trafficCursorDay,
    nowDay,
    nowMs,
    gate,
  );
  state.trafficCursorDay = nowDay;

  const batch = planned.slice(0, env.maxActionsPerTick);
  const dropNote = describeDrop(planned.length, batch.length);
  if (dropNote) console.log(`[traffic] ${dropNote}`);

  let failures = 0;
  for (const a of batch) {
    const provider = state.providers[a.providerKey];
    const council = state.councils[provider.councilKey];
    const actor = state.entities[entityKey(a.providerKey, a.entityIdx)];
    if (!actor) continue;
    try {
      if (a.type === "deposit") {
        await actDeposit(
          env,
          ring,
          state,
          actor,
          council,
          provider.publicKey,
          a.assetCode,
          a.amount,
        );
      } else if (a.type === "send") {
        const receiver =
          state.entities[entityKey(a.receiverProviderKey!, a.receiverIdx!)];
        if (!receiver) continue;
        await actSend(
          env,
          ring,
          state,
          actor,
          receiver,
          council,
          provider.publicKey,
          a.assetCode,
          a.amount,
        );
      } else if (a.type === "fail") {
        await actFail(env, ring, state, actor, council, provider.publicKey);
      } else {
        await actWithdraw(
          env,
          ring,
          state,
          actor,
          council,
          provider.publicKey,
          a.assetCode,
          a.amount,
        );
      }
      console.log(
        `[traffic] ${a.type} ${a.amount} ${a.assetCode} @ ${a.providerKey}`,
      );
    } catch (err) {
      failures++;
      console.error(
        `[traffic] ${a.type} @ ${a.providerKey} failed: ${
          (err as Error).message
        }`,
      );
    }
    // Organic pacing inside the tick.
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 2000));
  }

  // Aggregator end-user payments (small, frequent, POS/P2P-shaped).
  if (env.aggregatorsEnabled) {
    for (const spec of AGGREGATORS) {
      const agg = state.aggregators[spec.key];
      if (!agg) continue;
      for (const country of spec.countries) {
        if (!agg.accounts[country]?.created) continue;
        const rng = new Rng(
          ring.rngSeed,
          `agg:${spec.key}:${country}:${Math.floor(nowDay * 288)}`,
        );
        const perUser = spec.endUsers / spec.countries.length;
        const lambda = Math.min(3, perUser * 0.002);
        const n = rng.poisson(lambda);
        for (let k = 0; k < n; k++) {
          const amount = Number(rng.lognormal(1.2, 0.6, 0.5, 3).toFixed(2));
          try {
            await aggregatorPayment(
              env,
              ring,
              state,
              spec,
              country,
              amount,
              rng.int(0, 1000),
            );
            console.log(
              `[traffic] agg-payment ${amount} XLM @ ${spec.key}:${country}`,
            );
          } catch (err) {
            failures++;
            console.error(
              `[traffic] agg-payment @ ${spec.key}:${country} failed: ${
                (err as Error).message
              }`,
            );
          }
          await new Promise((r) => setTimeout(r, 500 + Math.random() * 1500));
        }
      }
    }
  }

  if (batch.length > 0 && failures === batch.length) {
    await discordAlert(
      env,
      `every action this tick failed (${failures}/${batch.length}) — platform down or config broken?`,
    );
  }
}

async function runwayCheck(
  env: ReturnType<typeof loadEngineEnv>,
  ring: KeyRing,
  state: EngineState,
): Promise<void> {
  // The engine's own working accounts: council admins (deploy + approve fees).
  for (const key of Object.keys(state.councils)) {
    const admin = await ring.councilAdmin(key);
    const { balance, ok } = await ensureRunway(env, admin.publicKey());
    if (!ok) {
      await discordAlert(
        env,
        `runway low: council admin ${key} at ${balance} XLM and friendbot won't top up`,
      );
    }
  }
}

async function tick(
  env: ReturnType<typeof loadEngineEnv>,
  ring: KeyRing,
): Promise<void> {
  let state = loadState(env.stateFile);

  if (state && state.networkPassphrase !== env.networkPassphrase) {
    throw new Error(
      "State file belongs to a different network — refusing. " +
        "Move SYNTRAF_STATE_FILE or clear it deliberately.",
    );
  }

  if (state && (await detectReset(env, state))) {
    const archived = archiveState(env.stateFile);
    await discordAlert(
      env,
      `network reset detected — state archived to ${archived}; re-bootstrapping from a fresh genesis`,
    );
    state = null;
  }

  if (!state) {
    state = emptyState(Date.now(), env.networkPassphrase);
    console.log("[engine] fresh genesis — day 0 begins now");
  }

  const nowMs = Date.now();
  const nowDay = virtualDays(nowMs, state.genesisMs, env.timeScale);
  console.log(
    `\n[tick] virtual day ${nowDay.toFixed(3)} | councils ${
      Object.keys(state.councils).length
    } | providers ${Object.keys(state.providers).length} | entities ${
      Object.keys(state.entities).length
    } | bundles ${state.totals.bundles}`,
  );

  await reconcileRoster(env, ring, state, ring.rngSeed, nowDay);
  await runwayCheck(env, ring, state);
  await runTraffic(env, ring, state, ring.rngSeed, nowDay, nowMs);

  state.lastLedgerSeq = Math.max(state.lastLedgerSeq, 0);
  saveState(env.stateFile, state);
}

async function main() {
  const env = loadEngineEnv();
  console.log("=== synthetic-traffic ===");
  console.log(`  network:   ${env.networkPassphrase}`);
  console.log(`  rpc:       ${env.rpcUrl}`);
  console.log(`  provider:  ${env.providerUrl}`);
  console.log(`  council:   ${env.councilUrl}`);
  console.log(`  registry:  ${env.registryContractId}`);
  console.log(`  timeScale: ${env.timeScale}  tick: ${env.tickMs}ms`);

  await warmupService("provider-platform", env.providerUrl);
  await warmupService("council-platform", env.councilUrl);

  const ring = await KeyRing.open(env.masterSecret);
  const once = (Deno.env.get("SYNTRAF_ONCE") ?? "false") === "true";

  while (true) {
    try {
      await tick(env, ring);
    } catch (err) {
      console.error(`[engine] tick failed: ${(err as Error).message}`);
    }
    if (once) break;
    const jitter = env.tickMs * (0.85 + Math.random() * 0.3);
    await new Promise((r) => setTimeout(r, jitter));
  }
}

if (import.meta.main) {
  await main();
}
