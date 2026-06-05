/**
 * Shared types for the events-capture framework.
 *
 * EXPECTED_EVENTS — the constant each testnet flow script inlines at the top.
 * It declares, in strict order, what should arrive on each subscriber's WS
 * stream during the script's run + the post-script tail window.
 *
 * `kind` (and `scope.ppPublicKey` + `scope.ppLabel` on per-PP events) are
 * always strict-compared. Every other field listed under `payload` is
 * strict-compared against the captured payload AFTER the always-skip list
 * has been deep-stripped from both sides (see assert.ts).
 */

/** Per-PP envelope shape — see provider-platform `event.types.ts:ProviderEvent`. */
export interface ExpectedPerPpEvent {
  kind: string;
  scope: {
    ppPublicKey: string;
    ppLabel: string;
  };
  payload: Record<string, unknown>;
}

/** Network LiveFrame.event shape — see network-dashboard-platform `types.ts:NetworkEvent`. */
export interface ExpectedNetworkEvent {
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * Inlined at the top of each testnet flow script. `perPp` is keyed by the
 * PP's public key (the script knows this — for testnet/main.ts and
 * lifecycle/testnet-verify.ts the value is the MASTER_SECRET-derived
 * `ROLES.PP, 0` keypair's publicKey()).
 */
export interface ExpectedEvents {
  perPp: Record<string, ExpectedPerPpEvent[]>;
  network: ExpectedNetworkEvent[];
}

/** A raw envelope captured off either WS. */
export interface CapturedEvent {
  /** "perPp:<ppPublicKey>" or "network". Keys the subscriber identity. */
  subscriberId: string;
  /** Parsed JSON message body, as received over the wire. */
  message: Record<string, unknown>;
  /** Capture timestamp ms (wall-clock at receive). */
  receivedAtMs: number;
}

/** Mismatch description for one subscriber. */
export interface SubscriberDiff {
  subscriberId: string;
  pass: boolean;
  expectedCount: number;
  capturedCount: number;
  /** Index-aligned diffs. Each entry is one expected vs captured slot. */
  entries: Array<{
    index: number;
    /** Status: "match" | "expected_missing" | "captured_extra" | "mismatch". */
    status: "match" | "expected_missing" | "captured_extra" | "mismatch";
    /** Expected (stripped) — null when status is captured_extra. */
    expected: Record<string, unknown> | null;
    /** Captured (stripped) — null when status is expected_missing. */
    captured: Record<string, unknown> | null;
    /** Human-readable diff text for mismatch entries. */
    diffText?: string;
  }>;
}

export interface RunReport {
  scriptName: string;
  runId: string;
  startedAtIso: string;
  finishedAtIso: string;
  tailMs: number;
  pass: boolean;
  perSubscriber: SubscriberDiff[];
}

/**
 * Fields stripped from both expected and captured envelopes before
 * strict-equal comparison. See PM-acked skip list in
 * /tmp/add-events-capture-framework-1/phase-0-catalogue.md §"Phase 0 step 7".
 */
export const ALWAYS_SKIP_FIELDS: ReadonlySet<string> = new Set([
  "ts",
  "id",
  "occurredAt",
  "ledger",
  "bundleId",
  "bundleIds",
  "txHash",
  "txId",
  "councilId",
  "channelContractId",
  "assetContractId",
  // Phase 0 catalogue halt-question A: councilName carries a runtime
  // timestamp in both flow scripts (testnet/main.ts:261 and
  // lifecycle/testnet-verify.ts:298), so PM acked SKIP for these scripts.
  "councilName",
  // Per-script: payload.reason is a freeform error.message at the producer
  // sites (executor.process.ts:467, verifier.process.ts:327) — PM acked SKIP.
  "reason",
]);
