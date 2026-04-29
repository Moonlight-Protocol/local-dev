import {
  Keypair,
  rpc,
  TransactionBuilder,
  xdr,
} from "npm:@stellar/stellar-sdk@14.2.0";

const FEE = "10000000"; // 1 XLM — generous for Soroban operations

export function createServer(
  rpcUrl: string,
  allowHttp = true,
): rpc.Server {
  return new rpc.Server(rpcUrl, { allowHttp });
}

/**
 * Build, simulate, assemble, sign, submit, and poll a Soroban transaction.
 * Returns the successful transaction response.
 */
export async function submitTx(
  server: rpc.Server,
  signer: Keypair,
  networkPassphrase: string,
  operation: xdr.Operation,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const account = await server.getAccount(signer.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: FEE,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${JSON.stringify(sim.error)}`);
  }

  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(
      `Transaction send error: ${JSON.stringify(sent.errorResult)}`,
    );
  }

  return poll(server, sent.hash);
}

async function poll(
  server: rpc.Server,
  hash: string,
  timeoutMs = 60_000,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const resp = await server.getTransaction(hash);
    if (resp.status === "SUCCESS") {
      return resp as rpc.Api.GetSuccessfulTransactionResponse;
    }
    if (resp.status === "FAILED") {
      throw new Error(`Transaction failed: ${hash}`);
    }
    // NOT_FOUND — keep polling
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(`Transaction ${hash} timed out after ${timeoutMs}ms`);
}

/**
 * Get the current ledger sequence from the RPC.
 */
export async function getLatestLedger(rpcUrl: string): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
  });
  const data = await res.json();
  return data.result.sequence;
}
