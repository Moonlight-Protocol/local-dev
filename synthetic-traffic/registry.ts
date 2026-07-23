/**
 * Stellar Registry integration. All contract deployments in synthetic-traffic
 * go through the registry CLI (`stellar registry publish` / `deploy`) instead
 * of raw `stellar contract deploy` — the settled registry-adoption pattern,
 * proven local-first against a locally deployed registry contract
 * (see README: setup-registry.sh) before any testnet use.
 *
 * Namespace: defaults to `unverified/` (publishable without manager approval —
 * right for local proving and initial testnet runs); once Gorka's `moonlight/`
 * sub-registry lands, set SYNTRAF_REGISTRY_NS=moonlight/ and the same code
 * publishes there.
 */
import type { EngineEnv } from "./env.ts";

const NS = Deno.env.get("SYNTRAF_REGISTRY_NS") ?? "unverified/";

export const WASM_NAMES = {
  council: `${NS}moonlight-council`,
  channel: `${NS}moonlight-privacy-channel`,
};

async function registryCmd(
  env: EngineEnv,
  sourceSecret: string,
  args: string[],
): Promise<string> {
  const cmd = new Deno.Command("stellar", {
    args: ["registry", ...args],
    env: {
      STELLAR_REGISTRY_CONTRACT_ID: env.registryContractId,
      STELLAR_NETWORK_PASSPHRASE: env.networkPassphrase,
      STELLAR_RPC_URL: env.rpcUrl,
      STELLAR_ACCOUNT: sourceSecret,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  const stdout = new TextDecoder().decode(out.stdout).trim();
  const stderr = new TextDecoder().decode(out.stderr).trim();
  if (!out.success) {
    throw new Error(
      `stellar registry ${args[0]} failed (${out.code}): ${stderr || stdout}`,
    );
  }
  return stdout;
}

/** Publish a wasm once per (name, version); idempotent via engine state. */
export async function publishWasm(
  env: EngineEnv,
  sourceSecret: string,
  wasmName: string,
  wasmPath: string,
  version: string,
): Promise<void> {
  await registryCmd(env, sourceSecret, [
    "publish",
    "--wasm",
    wasmPath,
    "--wasm-name",
    wasmName,
    "--binver",
    version,
  ]);
}

/**
 * Deploy a published wasm as a named instance; constructor args (already
 * CLI-shaped, e.g. ["--admin", "G..."]) go after `--`.
 */
export async function deployNamed(
  env: EngineEnv,
  sourceSecret: string,
  contractName: string,
  wasmName: string,
  version: string,
  ctorArgs: string[],
): Promise<string> {
  await registryCmd(env, sourceSecret, [
    "deploy",
    "--contract-name",
    contractName,
    "--wasm-name",
    wasmName,
    "--version",
    version,
    "--",
    ...ctorArgs,
  ]);
  return await fetchContractId(env, sourceSecret, contractName);
}

export async function fetchContractId(
  env: EngineEnv,
  sourceSecret: string,
  contractName: string,
): Promise<string> {
  const out = await registryCmd(env, sourceSecret, [
    "fetch-contract-id",
    "--contract-name",
    contractName,
  ]);
  const match = out.match(/C[A-Z2-7]{55}/);
  if (!match) {
    throw new Error(`Could not parse contract id from: ${out}`);
  }
  return match[0];
}
