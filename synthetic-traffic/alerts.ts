/**
 * Alert policy — when an all-failed tick is evidence of an outage.
 *
 * Pure decision logic, no I/O, so the thresholds are unit-testable
 * (`deno task test`). Delivery lives in funding.ts (`discordAlert`).
 *
 * The engine plans a Poisson batch per tick, so off-peak ticks routinely hold
 * one or two real actions. "All actions failed" on such a tick is one transient
 * failure (a bundle that FAILED on-chain, a flaky RPC) and looks identical to a
 * total outage, which is how the 2026-08-03 19:44Z "1/1" page happened. A tick
 * therefore only pages on its own once it is wide enough to be evidence; below
 * that floor the engine waits for a run of consecutive all-failed ticks, which
 * a real outage produces and an isolated transient does not.
 */

/** Real actions a single tick needs before "all of them failed" can page by
 * itself. Four independent actions failing back to back is not plausible
 * transient noise; one to three is the everyday off-peak batch size. */
export const MIN_ALL_FAILED_ACTIONS = 4;

/** Consecutive all-failed ticks that page regardless of how thin they are
 * (3 ticks ~= 15 min at the deployed 5-min cadence). */
export const ALL_FAILED_TICKS = 3;

/** Further all-failed ticks between re-alerts (12 ~= hourly), so an outage
 * that lasts pages once and then hourly instead of every tick. */
export const ALL_FAILED_REALERT_TICKS = 12;

export interface AllFailedState {
  /** Consecutive all-failed ticks so far. */
  streak: number;
  /** Streak length at the last page; 0 while this streak has not paged. */
  alertedAtStreak: number;
}

export function emptyAllFailedState(): AllFailedState {
  return { streak: 0, alertedAtStreak: 0 };
}

/**
 * Fold one tick's outcome into the all-failed state.
 *
 * `attempted` counts the real actions the tick actually ran (batch actions
 * whose actor existed, plus aggregator payments) and `failures` counts how many
 * of those threw. Intentional "seasoning" failures (`actFail`) submit a bundle
 * that FAILS on-chain but return normally, so they land in `attempted` only —
 * the alert has never fired on on-purpose errors and still does not.
 */
export function evaluateAllFailed(
  state: AllFailedState,
  attempted: number,
  failures: number,
): { state: AllFailedState; alert: string | null } {
  if (attempted === 0 || failures < attempted) {
    return { state: emptyAllFailedState(), alert: null };
  }

  const streak = state.streak + 1;
  const broad = attempted >= MIN_ALL_FAILED_ACTIONS;
  const sustained = streak >= ALL_FAILED_TICKS;
  const carry = { streak, alertedAtStreak: state.alertedAtStreak };
  if (!broad && !sustained) return { state: carry, alert: null };

  // Already paged for this streak: hold until the re-alert interval.
  if (
    state.alertedAtStreak > 0 &&
    streak - state.alertedAtStreak < ALL_FAILED_REALERT_TICKS
  ) {
    return { state: carry, alert: null };
  }

  const alert = streak === 1
    ? `every action this tick failed (${failures}/${attempted}) — platform ` +
      `down or config broken?`
    : `every action failed for ${streak} consecutive ticks (latest ` +
      `${failures}/${attempted}) — platform down or config broken?`;
  return { state: { streak, alertedAtStreak: streak }, alert };
}
