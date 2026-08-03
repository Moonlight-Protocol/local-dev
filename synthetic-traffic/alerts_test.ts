import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  ALL_FAILED_REALERT_TICKS,
  type AllFailedState,
  emptyAllFailedState,
  evaluateAllFailed,
} from "./alerts.ts";

/** Feed a sequence of [attempted, failures] ticks; collect what paged. */
function run(ticks: Array<[number, number]>): {
  alerts: string[];
  state: AllFailedState;
} {
  let state = emptyAllFailedState();
  const alerts: string[] = [];
  for (const [attempted, failures] of ticks) {
    const verdict = evaluateAllFailed(state, attempted, failures);
    state = verdict.state;
    if (verdict.alert) alerts.push(verdict.alert);
  }
  return { alerts, state };
}

Deno.test("thin tick with one real failure stays quiet (the 19:44Z page)", () => {
  const { alerts, state } = run([[1, 1]]);
  assertEquals(alerts, []);
  assertEquals(state.streak, 1);
});

Deno.test("isolated thin failure between healthy ticks never pages", () => {
  const { alerts, state } = run([[3, 0], [1, 1], [2, 0], [1, 1], [5, 0]]);
  assertEquals(alerts, []);
  assertEquals(state.streak, 0);
});

Deno.test("broad tick pages immediately", () => {
  const { alerts } = run([[6, 6]]);
  assertEquals(alerts.length, 1);
  assertStringIncludes(alerts[0], "every action this tick failed (6/6)");
});

Deno.test("sustained thin failures page on the third consecutive tick", () => {
  const { alerts } = run([[1, 1], [2, 2], [1, 1]]);
  assertEquals(alerts.length, 1);
  assertStringIncludes(alerts[0], "3 consecutive ticks");
});

Deno.test("a healthy tick resets the streak", () => {
  const { alerts, state } = run([[1, 1], [2, 2], [2, 0], [1, 1], [1, 1]]);
  assertEquals(alerts, []);
  assertEquals(state.streak, 2);
});

Deno.test("a single success in a wide tick is not an outage", () => {
  const { alerts } = run([[9, 8]]);
  assertEquals(alerts, []);
});

Deno.test("an ongoing outage re-pages hourly, not every tick", () => {
  const outage: Array<[number, number]> = Array.from(
    { length: 30 },
    () => [5, 5],
  );
  const { alerts } = run(outage);
  assertEquals(alerts.length, 1 + Math.floor(29 / ALL_FAILED_REALERT_TICKS));
});

Deno.test("empty ticks are not failures", () => {
  const { alerts, state } = run([[0, 0], [0, 0], [0, 0], [0, 0]]);
  assertEquals(alerts, []);
  assertEquals(state.streak, 0);
});

Deno.test("aggregator-only failures cannot make a healthy batch read as 100%", () => {
  // Pre-fix arithmetic compared `failures` (batch + aggregator) against
  // batch.length alone, so 2 aggregator failures next to 2 clean batch
  // actions paged as "2/2". Counting both loops in the denominator makes it
  // 2/4 — a bad half-tick, not an outage.
  const { alerts } = run([[4, 2]]);
  assertEquals(alerts, []);
});
