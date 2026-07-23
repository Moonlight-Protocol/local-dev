/**
 * Deterministic timeline: expands scenario.ts into concrete virtual-day
 * schedules. Everything is a pure function of (engine seed, indices), so any
 * restart recomputes the identical history — the reconciler in main.ts just
 * compares "what should exist by virtual-now" against recorded state.
 *
 * Virtual time is measured in fractional days since genesis. SYNTRAF_TIME_SCALE
 * compresses it for local proving (e.g. scale 288 → one virtual day per 5 real
 * minutes).
 */
import {
  AGGREGATORS,
  type AggregatorSpec,
  COUNCILS,
  type CouncilSpec,
  ENTITY_TARGET_RANGE,
  namePool,
  tierOf,
  UTC_OFFSET_BY_COUNTRY,
} from "./scenario.ts";
import { Rng } from "./rng.ts";

/** How long a provider's entity roster takes to reach its target (days). */
const ROSTER_RAMP_DAYS = 30;

export interface ProviderSlot {
  council: CouncilSpec;
  country: string;
  /** Global, stable provider index (used in key derivation + names). */
  index: number;
  key: string;
  name: string;
  joinDay: number;
}

export interface EntitySchedule {
  /** Day the user "appears" (accounts funded, session established). */
  connectDay: number;
  /** Day they self-register with their home provider (0.5–2.5 d later). */
  registerDay: number;
  /** Day of their first deposit (0.2–1.5 d after registering). */
  firstDepositDay: number;
  name: string;
}

export function virtualDays(
  nowMs: number,
  genesisMs: number,
  timeScale: number,
): number {
  return ((nowMs - genesisMs) / 86_400_000) * timeScale;
}

export function councilFormationDay(seed: string, c: CouncilSpec): number {
  const rng = new Rng(seed, `council-formed:${c.key}`);
  return c.bootstrapDay + rng.uniform(0, 0.3);
}

/**
 * All provider slots across all councils, in a stable global order.
 * One provider per (council, jurisdiction). ~24 total.
 */
export function providerSlots(seed: string): ProviderSlot[] {
  const slots: ProviderSlot[] = [];
  let index = 0;
  for (const c of COUNCILS) {
    const formed = councilFormationDay(seed, c);
    for (let j = 0; j < c.jurisdictions.length; j++) {
      const country = c.jurisdictions[j];
      const rng = new Rng(seed, `provider-join:${c.key}:${country}`);
      // First provider follows formation closely; later ones stagger in.
      const joinDay = j === 0
        ? formed + rng.uniform(0.05, 0.2)
        : formed + 0.2 + j * rng.uniform(0.3, 0.9);
      slots.push({
        council: c,
        country,
        index,
        key: `${c.key}:${country}`,
        name: `${c.name} — ${country} Provider`,
        joinDay,
      });
      index++;
    }
  }
  return slots;
}

/** Deterministic entity-roster target for a provider (settled tier ranges). */
export function entityTarget(seed: string, p: ProviderSlot): number {
  const [min, max] = ENTITY_TARGET_RANGE[tierOf(p.country)];
  return new Rng(seed, `entity-target:${p.key}`).int(min, max);
}

/**
 * Lifecycle schedule of entity #i at provider p. Front-loaded ramp: early
 * users pile in just after the provider activates, the tail trickles in over
 * ROSTER_RAMP_DAYS. The connect→register gap keeps a slice of the cast
 * "present but unregistered" at any moment (the settled pending-KYC stand-in).
 */
export function entitySchedule(
  seed: string,
  p: ProviderSlot,
  i: number,
): EntitySchedule {
  const rng = new Rng(seed, `entity:${p.key}:${i}`);
  const ramp = ROSTER_RAMP_DAYS * Math.pow(rng.random(), 1.6);
  const connectDay = p.joinDay + 0.1 + ramp;
  const registerDay = connectDay + rng.uniform(0.5, 2.5);
  const firstDepositDay = registerDay + rng.uniform(0.2, 1.5);
  const pool = namePool(p.country);
  const name = `${rng.pick(pool.first)} ${rng.pick(pool.last)}`;
  return { connectDay, registerDay, firstDepositDay, name };
}

/** How many of provider p's entities should have connected by virtual day d. */
export function entitiesDueBy(
  seed: string,
  p: ProviderSlot,
  d: number,
): number {
  const target = entityTarget(seed, p);
  let due = 0;
  for (let i = 0; i < target; i++) {
    if (entitySchedule(seed, p, i).connectDay <= d) due++;
  }
  return due;
}

export interface AggregatorEntry {
  spec: AggregatorSpec;
  /** Day the aggregator's pay-accounts appear (per settled entry lag). */
  entryDay: number;
}

export function aggregatorEntries(seed: string): AggregatorEntry[] {
  const slots = providerSlots(seed);
  return AGGREGATORS.map((spec) => {
    const homeJoins = spec.countries.map((country) => {
      // The aggregator waits for its home provider in each country; where a
      // country has two councils (MX), the earliest provider counts.
      const joins = slots.filter((s) => s.country === country)
        .map((s) => s.joinDay);
      return Math.min(...joins);
    });
    const rng = new Rng(seed, `aggregator-entry:${spec.key}`);
    const entryDay = Math.max(...homeJoins) + spec.entryLagDays +
      rng.uniform(0, 1);
    return { spec, entryDay };
  });
}

/**
 * Diurnal shape for a country's local hour: quiet nights, morning ramp,
 * evening peak. Mean ≈ 0.55, peak 1.0 — steady-state peak rates from
 * scenario.ts land in the settled 2–6 bundles/hour band.
 */
export function diurnalFactor(country: string, utcHourFloat: number): number {
  const offset = UTC_OFFSET_BY_COUNTRY[country] ?? 0;
  const local = (((utcHourFloat + offset) % 24) + 24) % 24;
  if (local < 6) return 0.08;
  if (local < 9) return 0.35 + (local - 6) * 0.15;
  if (local < 18) return 0.8;
  if (local < 22) return 1.0;
  return 0.3;
}

/** Weekends run visibly quieter. */
export function weekdayFactor(nowMs: number): number {
  const dow = new Date(nowMs).getUTCDay();
  return dow === 0 || dow === 6 ? 0.55 : 1.0;
}

/**
 * Network-adoption ramp: a provider's traffic grows with its roster — thin at
 * join, full volume once the roster ramp completes.
 */
export function adoptionFactor(p: ProviderSlot, day: number): number {
  const age = day - p.joinDay;
  if (age <= 0) return 0;
  return Math.min(1, 0.15 + (0.85 * age) / ROSTER_RAMP_DAYS);
}
