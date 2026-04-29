import { type ContractId, NetworkConfig } from "@colibri/core";
import type { StellarNetworkId } from "@moonlight/moonlight-sdk";

export interface Config {
  networkPassphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  friendbotUrl: string;
  providerUrl: string;
  channelContractId: ContractId;
  channelAuthId: ContractId;
  channelAssetContractId: ContractId;
  networkConfig: NetworkConfig;
  networkId: StellarNetworkId;
  providerSecretKey?: string;
}

function loadEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const content = Deno.readTextFileSync(path);
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  } catch {
    // File not found
  }
  return env;
}

export function loadConfig(): Config {
  // Load from /config/contracts.env (Docker shared volume)
  const env = loadEnvFile("/config/contracts.env");

  const networkPassphrase = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ??
    "Standalone Network ; February 2017";
  const rpcUrl = Deno.env.get("STELLAR_RPC_URL") ??
    "http://localhost:8000/soroban/rpc";
  const horizonUrl = rpcUrl.replace("/soroban/rpc", "");
  const friendbotUrl = Deno.env.get("FRIENDBOT_URL") ??
    "http://localhost:8000/friendbot";
  const providerUrl = Deno.env.get("PROVIDER_URL") ??
    env["PROVIDER_URL"] ?? "http://localhost:3000";

  const channelContractId = (
    Deno.env.get("E2E_CHANNEL_CONTRACT_ID") ?? env["E2E_CHANNEL_CONTRACT_ID"]
  ) as ContractId;
  const channelAuthId = (
    Deno.env.get("E2E_CHANNEL_AUTH_ID") ?? env["E2E_CHANNEL_AUTH_ID"]
  ) as ContractId;
  const channelAssetContractId = (
    Deno.env.get("E2E_CHANNEL_ASSET_CONTRACT_ID") ??
      env["E2E_CHANNEL_ASSET_CONTRACT_ID"]
  ) as ContractId;

  if (!channelContractId || !channelAuthId || !channelAssetContractId) {
    throw new Error(
      "Missing contract IDs. Ensure /config/contracts.env exists (written by test setup).",
    );
  }

  const networkConfig = NetworkConfig.CustomNet({
    networkPassphrase,
    rpcUrl,
    horizonUrl,
    friendbotUrl,
    allowHttp: true,
  });

  const providerSecretKey = Deno.env.get("E2E_PROVIDER_SK") ??
    env["E2E_PROVIDER_SK"];

  return {
    networkPassphrase,
    rpcUrl,
    horizonUrl,
    friendbotUrl,
    providerUrl,
    channelContractId,
    channelAuthId,
    channelAssetContractId,
    networkConfig,
    networkId: networkPassphrase as StellarNetworkId,
    providerSecretKey,
  };
}
