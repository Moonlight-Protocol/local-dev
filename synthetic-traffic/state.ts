/**
 * Persistent engine state — the record of what the reconciler has already
 * made real. Keys are NOT stored here (everything re-derives from
 * SYNTRAF_MASTER_SECRET); losing this file costs progress bookkeeping, not
 * identities.
 */

export interface CouncilState {
  key: string;
  /** channel-auth contract id (the council). */
  authId: string;
  /** privacy-channel per enabled asset, keyed by asset code (XLM, USDC). */
  channels: Record<string, string>;
  /** SAC contract id per asset code. */
  assets: Record<string, string>;
  formedAtDay: number;
}

export interface ProviderState {
  key: string;
  councilKey: string;
  country: string;
  publicKey: string;
  membershipActive: boolean;
  joinedAtDay: number;
}

export interface EntityState {
  /** provider key + roster index identify the entity; keys re-derive. */
  providerKey: string;
  index: number;
  name: string;
  connected: boolean;
  registered: boolean;
  /** Rough channel balance estimate per asset, engine-side (chain is truth). */
  balances: Record<string, number>;
  deposits: number;
  sends: number;
  withdraws: number;
}

export interface AggregatorState {
  key: string;
  /** pay-account per country (single-jurisdiction pay accounts). */
  accounts: Record<string, { created: boolean }>;
  enteredAtDay: number;
}

export interface EngineState {
  /** Genesis wall-clock ms — virtual day 0. */
  genesisMs: number;
  /** Passphrase this state belongs to; mismatch = refuse to reuse. */
  networkPassphrase: string;
  /** Ledger watermark for testnet-reset detection. */
  lastLedgerSeq: number;
  /** Registry wasm names, published once per (name, version). */
  publishedWasms: Record<string, string>;
  councils: Record<string, CouncilState>;
  providers: Record<string, ProviderState>;
  /** Keyed `${providerKey}#${index}`. */
  entities: Record<string, EntityState>;
  aggregators: Record<string, AggregatorState>;
  /** Last virtual day the traffic planner processed. */
  trafficCursorDay: number;
  /** Operational counters for the heartbeat line. */
  totals: {
    bundles: number;
    deposits: number;
    sends: number;
    withdraws: number;
  };
}

export function emptyState(
  genesisMs: number,
  networkPassphrase: string,
): EngineState {
  return {
    genesisMs,
    networkPassphrase,
    lastLedgerSeq: 0,
    publishedWasms: {},
    councils: {},
    providers: {},
    entities: {},
    aggregators: {},
    trafficCursorDay: 0,
    totals: { bundles: 0, deposits: 0, sends: 0, withdraws: 0 },
  };
}

export function loadState(path: string): EngineState | null {
  try {
    return JSON.parse(Deno.readTextFileSync(path)) as EngineState;
  } catch {
    return null;
  }
}

export function saveState(path: string, state: EngineState): void {
  const tmp = `${path}.tmp`;
  Deno.writeTextFileSync(tmp, JSON.stringify(state, null, 2));
  Deno.renameSync(tmp, path);
}

export function entityKey(providerKey: string, index: number): string {
  return `${providerKey}#${index}`;
}
