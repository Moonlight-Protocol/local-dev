import { NetworkConfig, type ContractId } from "@colibri/core";
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
    // File not found — that's fine, we'll use env vars
  }
  return env;
}

export function loadConfig(): Config {
  // In Docker: env vars are set by docker-compose, contract IDs come from /config/contracts.env
  // Locally: everything comes from the provider-platform .env file
  const contractsEnv = loadEnvFile("/config/contracts.env");

  const providerPlatformPath = Deno.env.get("PROVIDER_PLATFORM_PATH") ??
    `${Deno.env.get("HOME")}/repos/provider-platform`;
  const providerEnv = loadEnvFile(`${providerPlatformPath}/.env`);

  const env = { ...providerEnv, ...contractsEnv };

  const networkPassphrase = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ??
    "Standalone Network ; February 2017";
  const rpcUrl = Deno.env.get("STELLAR_RPC_URL") ??
    "http://localhost:8000/soroban/rpc";
  const horizonUrl = rpcUrl.replace("/soroban/rpc", "");
  const friendbotUrl = Deno.env.get("FRIENDBOT_URL") ??
    "http://localhost:8000/friendbot";
  const providerUrl = Deno.env.get("PROVIDER_URL") ??
    `http://localhost:${env["PORT"] ?? "3000"}`;

  const channelContractId = (env["CHANNEL_CONTRACT_ID"] ??
    Deno.env.get("CHANNEL_CONTRACT_ID")) as ContractId;
  const channelAuthId = (env["CHANNEL_AUTH_CONTRACT_ID"] ??
    env["CHANNEL_AUTH_ID"] ??
    Deno.env.get("CHANNEL_AUTH_CONTRACT_ID")) as ContractId;
  const channelAssetContractId = (env["TOKEN_CONTRACT_ID"] ??
    env["CHANNEL_ASSET_CONTRACT_ID"] ??
    Deno.env.get("TOKEN_CONTRACT_ID")) as ContractId;

  if (!channelContractId || !channelAuthId || !channelAssetContractId) {
    throw new Error(
      "Missing contract IDs. Set env vars or provide .env files.",
    );
  }

  const networkConfig = NetworkConfig.CustomNet({
    networkPassphrase,
    rpcUrl,
    horizonUrl,
    friendbotUrl,
    allowHttp: true,
  });

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
  };
}
