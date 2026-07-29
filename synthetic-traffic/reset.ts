/**
 * Testnet-reset detection. The SDF testnet is wiped quarterly; the local
 * quickstart resets on every recreate. Signal: the ledger sequence regresses
 * far below our recorded watermark. Response (settled design): alert, archive
 * the old state, and re-bootstrap from a fresh genesis — the network history
 * simply starts over.
 */
import type { EngineEnv } from "./env.ts";
import type { EngineState } from "./state.ts";

const REGRESSION_MARGIN = 5_000;

export async function latestLedgerSeq(env: EngineEnv): Promise<number> {
  const res = await fetch(env.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getLatestLedger",
    }),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`getLatestLedger failed: ${res.status}`);
  }
  const body = await res.json();
  const seq = body?.result?.sequence;
  if (typeof seq !== "number") {
    throw new Error(
      `getLatestLedger returned no sequence: ${JSON.stringify(body)}`,
    );
  }
  return seq;
}

/** True when the chain we knew is gone and the engine must re-bootstrap. */
export async function detectReset(
  env: EngineEnv,
  state: EngineState,
): Promise<boolean> {
  const seq = await latestLedgerSeq(env);
  if (
    state.lastLedgerSeq > 0 && seq < state.lastLedgerSeq - REGRESSION_MARGIN
  ) {
    return true;
  }
  state.lastLedgerSeq = seq;
  return false;
}

export function archiveState(stateFile: string): string {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const archived = `${stateFile}.${stamp}.reset`;
  try {
    Deno.renameSync(stateFile, archived);
  } catch { /* nothing to archive */ }
  return archived;
}
