/**
 * Stellar Registry integration. All contract deployments in synthetic-traffic
 * go through the registry CLI (`stellar registry publish` / `deploy`) instead
 * of raw `stellar contract deploy` — the settled registry-adoption pattern,
 * proven local-first against a locally deployed registry contract
 * (see README: setup-registry.sh) before any testnet use.
 *
 * Namespace: empty by default — the local-first pattern deploys a registry we
 * manage (admin = manager = engine key), so names live in that root. On the
 * shared testnet registry set SYNTRAF_REGISTRY_NS=moonlight/ once Gorka's
 * sub-registry lands. (The CLI's `unverified/` publish path currently targets
 * a different subregistry instance than root-based resolution — avoided.)
 */
import type { EngineEnv } from "./env.ts";

const NS = Deno.env.get("SYNTRAF_REGISTRY_NS") ?? "";

export const WASM_NAMES = {
  council: `${NS}moonlight-council`,
  channel: `${NS}moonlight-privacy-channel`,
};

/** Deployed-contract names live in the same namespace as the wasms — names
 * without a prefix would register in the root (verified) registry, which
 * needs the registry manager's signature. */
export function contractName(base: string): string {
  return `${NS}${base}`;
}

async function registryCmd(
  env: EngineEnv,
  sourceSecret: string,
  args: string[],
): Promise<string> {
  // --source-account must precede the `--` constructor-args separator.
  const sep = args.indexOf("--");
  const argv = sep === -1 ? [...args, "--source-account", sourceSecret] : [
    ...args.slice(0, sep),
    "--source-account",
    sourceSecret,
    ...args.slice(sep),
  ];
  const cmd = new Deno.Command("stellar", {
    args: ["registry", ...argv],
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

/** Latest published version of a wasm name, or null if never published. */
export async function currentVersion(
  env: EngineEnv,
  sourceSecret: string,
  wasmName: string,
): Promise<string | null> {
  try {
    const out = await registryCmd(env, sourceSecret, [
      "current-version",
      wasmName,
    ]);
    const match = out.match(/\d+\.\d+\.\d+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/** Publish a wasm once per (name, version); idempotent — re-runs (e.g. after
 * a crashed tick lost the state write) detect the published version and skip. */
export async function publishWasm(
  env: EngineEnv,
  sourceSecret: string,
  wasmName: string,
  wasmPath: string,
  version: string,
): Promise<void> {
  if ((await currentVersion(env, sourceSecret, wasmName)) === version) {
    console.log(`[registry] ${wasmName}@${version} already published`);
    return;
  }
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
  try {
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
  } catch (err) {
    // Name already claimed (crashed tick lost the state write): recover the
    // existing instance instead of failing forever.
    const existing = await fetchContractId(env, sourceSecret, contractName)
      .catch(() => null);
    if (!existing) throw err;
    console.log(
      `[registry] ${contractName} already deployed → ${existing}`,
    );
    return existing;
  }
  return await fetchContractId(env, sourceSecret, contractName);
}

export async function fetchContractId(
  env: EngineEnv,
  sourceSecret: string,
  contractName: string,
): Promise<string> {
  const out = await registryCmd(env, sourceSecret, [
    "fetch-contract-id",
    contractName,
  ]);
  const match = out.match(/C[A-Z2-7]{55}/);
  if (!match) {
    throw new Error(`Could not parse contract id from: ${out}`);
  }
  return match[0];
}
