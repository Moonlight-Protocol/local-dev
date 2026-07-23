/**
 * Traffic planner: turns the virtual-time window since the last tick into a
 * concrete list of actions, shaped by tier peak rates, council busyness,
 * roster adoption, timezone diurnal curves, weekday dips, corridor-biased
 * receiver picks and lognormal amounts.
 */
import {
  CORRIDORS,
  DOMESTIC_SHARE,
  PEAK_RATE_BY_TIER,
  tierOf,
  usdcEligible,
} from "./scenario.ts";
import {
  adoptionFactor,
  diurnalFactor,
  entitySchedule,
  type ProviderSlot,
  weekdayFactor,
} from "./timeline.ts";
import { Rng } from "./rng.ts";
import type { EngineState, EntityState } from "./state.ts";
import { entityKey } from "./state.ts";

export interface PlannedAction {
  type: "deposit" | "send" | "withdraw";
  providerKey: string;
  entityIdx: number;
  /** send only */
  receiverProviderKey?: string;
  receiverIdx?: number;
  assetCode: string;
  amount: number;
}

function registeredEntities(
  state: EngineState,
  providerKey: string,
): EntityState[] {
  return Object.values(state.entities).filter(
    (e) => e.providerKey === providerKey && e.registered,
  );
}

function corridorPartner(country: string): string | null {
  for (const [a, b] of CORRIDORS) {
    if (a === country) return b;
    if (b === country) return a;
  }
  return null;
}

/** Clamp to 2 decimal places with a clean decimal repr — the SDK converts
 * amounts via their string form and rejects float artifacts like
 * 29.080000000000002 ("too many fractional digits"). */
function money(x: number): number {
  return Number(x.toFixed(2));
}

function pickAmount(rng: Rng, type: PlannedAction["type"]): number {
  switch (type) {
    case "deposit":
      return money(rng.lognormal(40, 0.8, 10, 400));
    case "send":
      return money(rng.lognormal(5, 1.0, 0.5, 150));
    case "withdraw":
      return 0; // caller derives from balance
  }
}

/**
 * Plan the actions for the window (cursorDay, nowDay]. Poisson arrivals per
 * provider; the caller enforces maxActionsPerTick as the catch-up bound and
 * logs anything dropped.
 */
export function planTick(
  seed: string,
  state: EngineState,
  slots: ProviderSlot[],
  cursorDay: number,
  nowDay: number,
  nowMs: number,
  firstDepositGate: (providerKey: string, idx: number) => boolean,
): PlannedAction[] {
  const windowDays = Math.max(0, nowDay - cursorDay);
  if (windowDays === 0) return [];
  const utcHour = (nowMs / 3_600_000) % 24;
  const tickTag = Math.floor(nowDay * 288); // stable per ~5-virtual-minute slot
  const actions: PlannedAction[] = [];

  for (const slot of slots) {
    const provider = state.providers[slot.key];
    if (!provider?.membershipActive) continue;
    const roster = registeredEntities(state, slot.key);
    if (roster.length === 0) continue;

    const rate = PEAK_RATE_BY_TIER[tierOf(slot.country)] *
      slot.council.activity *
      adoptionFactor(slot, nowDay) *
      diurnalFactor(slot.country, utcHour) *
      weekdayFactor(nowMs);
    const lambda = rate * windowDays * 24;
    const rng = new Rng(seed, `tick:${slot.key}:${tickTag}`);
    const n = rng.poisson(lambda);

    for (let k = 0; k < n; k++) {
      const actor = rng.pick(roster);
      const gateOpen = firstDepositGate(slot.key, actor.index);
      const xlm = actor.balances["XLM"] ?? 0;
      const usdc = actor.balances["USDC"] ?? 0;
      // Asset mix: mostly XLM; USDC once in-channel, and USDC-capable actors
      // occasionally make their FIRST USDC deposit from their classic balance.
      let assetCode = usdc > 5 && rng.random() < 0.25 ? "USDC" : "XLM";
      if (
        assetCode === "XLM" && usdc <= 5 && usdcEligible(actor.index) &&
        rng.random() < 0.15
      ) {
        assetCode = "USDC";
      }
      const balance = assetCode === "USDC" ? usdc : xlm;

      let type: PlannedAction["type"];
      if (balance < 1) {
        if (!gateOpen) continue; // still pre-first-deposit in their lifecycle
        type = "deposit";
      } else {
        type = rng.weighted<PlannedAction["type"]>([
          ["send", 0.75],
          ["deposit", 0.15],
          ["withdraw", 0.10],
        ]);
      }

      if (type === "send") {
        const receiver = pickReceiver(state, slots, slot, actor, rng);
        if (!receiver) continue;
        const amount = money(Math.min(pickAmount(rng, "send"), balance * 0.8));
        if (amount < 0.5) continue;
        actions.push({
          type,
          providerKey: slot.key,
          entityIdx: actor.index,
          receiverProviderKey: receiver.providerKey,
          receiverIdx: receiver.index,
          assetCode,
          amount,
        });
      } else if (type === "withdraw") {
        const amount = money(balance * rng.uniform(0.3, 0.8));
        if (amount < 1) continue;
        actions.push({
          type,
          providerKey: slot.key,
          entityIdx: actor.index,
          assetCode,
          amount,
        });
      } else {
        actions.push({
          type,
          providerKey: slot.key,
          entityIdx: actor.index,
          assetCode,
          amount: pickAmount(rng, "deposit"),
        });
      }
    }
  }
  return actions;
}

/**
 * Receiver pick: ~87.5% domestic; the rest goes cross-country inside the same
 * council, biased to the named corridor partner where one exists (country
 * lives at the ramps — the send itself is mechanically identical).
 */
function pickReceiver(
  state: EngineState,
  slots: ProviderSlot[],
  senderSlot: ProviderSlot,
  sender: EntityState,
  rng: Rng,
): EntityState | null {
  const domestic = rng.random() < DOMESTIC_SHARE;
  let pool: EntityState[] = [];

  if (!domestic) {
    const councilMates = slots.filter(
      (s) =>
        s.council.key === senderSlot.council.key && s.key !== senderSlot.key,
    );
    if (councilMates.length > 0) {
      const partner = corridorPartner(senderSlot.country);
      const partnerSlot = councilMates.find((s) => s.country === partner);
      const target = partnerSlot && rng.random() < 0.7
        ? partnerSlot
        : rng.pick(councilMates);
      pool = registeredEntities(state, target.key);
    }
  }
  if (pool.length === 0) {
    pool = registeredEntities(state, senderSlot.key).filter(
      (e) => e.index !== sender.index,
    );
  }
  if (pool.length === 0) return null;
  return rng.pick(pool);
}

export function firstDepositGateFactory(
  seed: string,
  slots: ProviderSlot[],
  nowDay: number,
): (providerKey: string, idx: number) => boolean {
  const byKey = new Map(slots.map((s) => [s.key, s]));
  return (providerKey, idx) => {
    const slot = byKey.get(providerKey);
    if (!slot) return false;
    return entitySchedule(seed, slot, idx).firstDepositDay <= nowDay;
  };
}

/** Actions the engine had to drop this tick (catch-up bound) — always logged. */
export function describeDrop(planned: number, executed: number): string | null {
  if (planned <= executed) return null;
  return `traffic: dropped ${
    planned - executed
  }/${planned} planned actions (catch-up bound) — never silently`;
}

export { entityKey };
