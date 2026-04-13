import { rpc, scValToNative, xdr } from "npm:@stellar/stellar-sdk@14.2.0";

export interface ContractEvent {
  type: string;
  topics: string[];
  value: unknown;
}

/**
 * Extract contract events from a successful Soroban transaction response.
 *
 * Tries multiple extraction paths:
 * 1. diagnosticEventsXdr (requires ENABLE_SOROBAN_DIAGNOSTIC_EVENTS on the node)
 * 2. resultMetaXdr → diagnosticEvents
 * 3. resultMetaXdr → events
 *
 * Returns an empty array if contract events aren't available (node config).
 */
export function extractEvents(
  txResponse: rpc.Api.GetSuccessfulTransactionResponse,
): ContractEvent[] {
  const events: ContractEvent[] = [];

  // Path 1: diagnosticEventsXdr (already-parsed XDR objects from SDK)
  // deno-lint-ignore no-explicit-any
  const diagXdr = (txResponse as any).diagnosticEventsXdr;
  if (Array.isArray(diagXdr)) {
    for (const d of diagXdr) {
      try {
        const event = d.event();
        if (event.type().value === 1) {
          // type 1 = contract
          events.push(parseContractEvent(event));
        }
      } catch {
        // Not a DiagnosticEvent or wrong format
      }
    }
    if (events.length > 0) return events;
  }

  // Path 2: resultMetaXdr → diagnosticEvents / events
  // Use 'any' to handle varying TransactionMeta versions across protocols
  try {
    const meta = txResponse.resultMetaXdr;
    // deno-lint-ignore no-explicit-any
    const metaValue = meta.value() as any;

    // Try diagnosticEvents (Protocol 25+ TransactionMetaV4)
    if (typeof metaValue.diagnosticEvents === "function") {
      for (const d of metaValue.diagnosticEvents()) {
        try {
          const event = d.event();
          if (event.type().value === 1) {
            events.push(parseContractEvent(event));
          }
        } catch { /* skip */ }
      }
      if (events.length > 0) return events;
    }

    // Try events (TransactionEvent wrapper)
    if (typeof metaValue.events === "function") {
      for (const te of metaValue.events()) {
        try {
          const event = te.event();
          if (event.type().value === 1) {
            events.push(parseContractEvent(event));
          }
        } catch { /* skip */ }
      }
    }

    // Try sorobanMeta → events (Protocol 21-23 style)
    if (typeof metaValue.sorobanMeta === "function") {
      const sorobanMeta = metaValue.sorobanMeta();
      if (sorobanMeta && typeof sorobanMeta.events === "function") {
        for (const event of sorobanMeta.events()) {
          if (event.type().value === 1) {
            events.push(parseContractEvent(event));
          }
        }
      }
    }
  } catch {
    // Meta parsing failed
  }

  // Filter out fee events (emitted by the native SAC for fee deduction/refund)
  return events.filter((e) => e.topics[0] !== "fee");
}

function parseContractEvent(event: xdr.ContractEvent): ContractEvent {
  const topics = event.body().v0().topics().map((t: xdr.ScVal) => {
    try {
      return String(scValToNative(t));
    } catch {
      return t.toXDR("base64");
    }
  });

  const data = event.body().v0().data();
  let value: unknown;
  try {
    value = scValToNative(data);
  } catch {
    value = data.toXDR("base64");
  }

  return { type: "contract", topics, value };
}

/**
 * Verify that an event with the given name exists.
 * If events are available, asserts the event exists.
 * If no events are available (node config), logs a warning instead of failing.
 */
export function verifyEvent(
  events: ContractEvent[],
  eventName: string,
  txSuccess: boolean,
): { found: boolean; event?: ContractEvent } {
  const found = events.find((e) => e.topics[0] === eventName);

  if (found) {
    return { found: true, event: found };
  }

  if (events.length === 0 && txSuccess) {
    // No events captured — likely node doesn't have diagnostic events enabled
    console.log(
      `  (event verification skipped — node may not capture contract events)`,
    );
    return { found: false };
  }

  // Events ARE present but the expected one is missing — that's a real error
  const names = events.map((e) => e.topics[0]);
  throw new Error(
    `Event "${eventName}" not found. Got: [${names.join(", ")}]`,
  );
}
