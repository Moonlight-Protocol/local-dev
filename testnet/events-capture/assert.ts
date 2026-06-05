/**
 * Strict-order shape+value assertion between captured WS events and the
 * script's `EXPECTED_EVENTS` declaration.
 *
 * Strategy:
 *  1. Deep-strip every field in `ALWAYS_SKIP_FIELDS` from both expected and
 *     captured (recursive — handles nested envelopes and arrays).
 *  2. Walk both lists in lockstep. Each index produces a Diff entry.
 *  3. The result is structured so report.ts can format it without re-doing
 *     the diff logic.
 *
 * Per-subscriber diffs are independent — one subscriber failing does not
 * mark another as failing. The overall `pass` is the AND of every
 * subscriber's `pass`.
 */
import {
  ALWAYS_SKIP_FIELDS,
  type CapturedEvent,
  type ExpectedEvents,
  type ExpectedNetworkEvent,
  type ExpectedPerPpEvent,
  type SubscriberDiff,
} from "./types.ts";

export interface AssertInput {
  expected: ExpectedEvents;
  capturedBySubscriber: Record<string, CapturedEvent[]>;
}

export interface AssertResult {
  pass: boolean;
  perSubscriber: SubscriberDiff[];
}

export function assertCaptured(input: AssertInput): AssertResult {
  const subscriberDiffs: SubscriberDiff[] = [];

  // Per-PP subscribers (one per declared ppPublicKey).
  for (
    const [ppPublicKey, expectedList] of Object.entries(input.expected.perPp)
  ) {
    const subscriberId = `perPp:${ppPublicKey}`;
    const captured = input.capturedBySubscriber[subscriberId] ?? [];
    subscriberDiffs.push(
      diffSubscriber(subscriberId, expectedList, captured),
    );
  }

  // Network subscriber.
  const networkCaptured = input.capturedBySubscriber["network"] ?? [];
  subscriberDiffs.push(
    diffSubscriber("network", input.expected.network, networkCaptured),
  );

  const pass = subscriberDiffs.every((d) => d.pass);
  return { pass, perSubscriber: subscriberDiffs };
}

function diffSubscriber(
  subscriberId: string,
  expectedRaw: ExpectedPerPpEvent[] | ExpectedNetworkEvent[],
  capturedRaw: CapturedEvent[],
): SubscriberDiff {
  const expected = expectedRaw.map((e) =>
    stripSkipFields(e as unknown as Record<string, unknown>)
  );
  // For network, captured LiveFrame is `{ type: "event", event: NetworkEvent, counters }`.
  // Compare against `event` only — `counters` is dashboard-state-at-emit and
  // isn't a payload we declare in EXPECTED_EVENTS.
  const captured = capturedRaw.map((c) => {
    const msg = c.message;
    if (subscriberId === "network") {
      const evt = (msg.event ?? msg) as Record<string, unknown>;
      return stripSkipFields(evt);
    }
    return stripSkipFields(msg);
  });

  const entries: SubscriberDiff["entries"] = [];
  const maxLen = Math.max(expected.length, captured.length);
  let pass = expected.length === captured.length;
  for (let i = 0; i < maxLen; i++) {
    const exp = i < expected.length ? expected[i] : null;
    const cap = i < captured.length ? captured[i] : null;
    if (exp && cap) {
      const ok = deepEqual(exp, cap);
      if (!ok) pass = false;
      entries.push({
        index: i,
        status: ok ? "match" : "mismatch",
        expected: exp,
        captured: cap,
        diffText: ok ? undefined : describeDiff(exp, cap),
      });
    } else if (exp && !cap) {
      pass = false;
      entries.push({
        index: i,
        status: "expected_missing",
        expected: exp,
        captured: null,
      });
    } else if (!exp && cap) {
      pass = false;
      entries.push({
        index: i,
        status: "captured_extra",
        expected: null,
        captured: cap,
      });
    }
  }
  return {
    subscriberId,
    pass,
    expectedCount: expected.length,
    capturedCount: captured.length,
    entries,
  };
}

/**
 * Deep-strip every key in ALWAYS_SKIP_FIELDS. Recurses into nested objects
 * and arrays. Returns a new object — does not mutate inputs.
 */
function stripSkipFields(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (ALWAYS_SKIP_FIELDS.has(k)) continue;
    out[k] = stripValue(v);
  }
  return out;
}

function stripValue(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map((item) => stripValue(item));
  }
  if (v !== null && typeof v === "object") {
    return stripSkipFields(v as Record<string, unknown>);
  }
  return v;
}

/**
 * Order-sensitive deep equality. Arrays compared index-by-index; objects
 * compared key-set equal AND every value deepEqual.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao).sort();
    const bKeys = Object.keys(bo).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
      if (!deepEqual(ao[aKeys[i]], bo[bKeys[i]])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Human-readable diff text used by report.ts when a mismatch entry needs
 * a one-line summary. Stays small — the full structured entry is what
 * the JSON dump carries.
 */
function describeDiff(
  expected: Record<string, unknown>,
  captured: Record<string, unknown>,
): string {
  if (expected.kind !== captured.kind) {
    return `kind mismatch: expected ${JSON.stringify(expected.kind)} got ${
      JSON.stringify(captured.kind)
    }`;
  }
  // Walk top-level keys and report first divergence.
  const expKeys = new Set(Object.keys(expected));
  const capKeys = new Set(Object.keys(captured));
  for (const k of expKeys) {
    if (!capKeys.has(k)) return `captured missing key "${k}"`;
    if (!deepEqual(expected[k], captured[k])) {
      return `"${k}" mismatch: expected ${JSON.stringify(expected[k])} got ${
        JSON.stringify(captured[k])
      }`;
    }
  }
  for (const k of capKeys) {
    if (!expKeys.has(k)) return `captured extra key "${k}"`;
  }
  return "structural mismatch (see entry expected / captured)";
}
