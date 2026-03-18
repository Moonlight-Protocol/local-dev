import { NetworkConfig } from "@colibri/core";
import type { StellarNetworkId } from "@moonlight/moonlight-sdk";

const WASM_DIR = new URL("../e2e/wasms", import.meta.url).pathname;

export interface LifecycleConfig {
  networkPassphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  friendbotUrl: string;
  allowHttp: boolean;
  channelAuthWasmPath: string;
  privacyChannelWasmPath: string;
  providerPlatformPath: string;
  providerUrl?: string;
  networkConfig: NetworkConfig;
  networkId: StellarNetworkId;
}

export function loadConfig(): LifecycleConfig {
  const network = Deno.env.get("NETWORK") ?? "local";

  const channelAuthWasmPath = Deno.env.get("CHANNEL_AUTH_WASM") ??
    `${WASM_DIR}/channel_auth_contract.wasm`;
  const privacyChannelWasmPath = Deno.env.get("PRIVACY_CHANNEL_WASM") ??
    `${WASM_DIR}/privacy_channel.wasm`;
  const providerPlatformPath = Deno.env.get("PROVIDER_PLATFORM_PATH") ??
    `${Deno.env.get("HOME")}/repos/provider-platform`;
  const providerUrl = Deno.env.get("PROVIDER_URL");

  if (network === "testnet") {
    const networkPassphrase = "Test SDF Network ; September 2015";
    const rpcUrl = Deno.env.get("STELLAR_RPC_URL") ??
      "https://soroban-testnet.stellar.org";
    const horizonUrl = Deno.env.get("HORIZON_URL") ??
      "https://horizon-testnet.stellar.org";
    const friendbotUrl = Deno.env.get("FRIENDBOT_URL") ??
      "https://friendbot.stellar.org";

    return {
      networkPassphrase,
      rpcUrl,
      horizonUrl,
      friendbotUrl,
      allowHttp: false,
      channelAuthWasmPath,
      privacyChannelWasmPath,
      providerPlatformPath,
      providerUrl,
      networkConfig: NetworkConfig.TestNet({ allowHttp: false }),
      networkId: networkPassphrase as StellarNetworkId,
    };
  }

  // Local
  const networkPassphrase = Deno.env.get("STELLAR_NETWORK_PASSPHRASE") ??
    "Standalone Network ; February 2017";
  const rpcUrl = Deno.env.get("STELLAR_RPC_URL") ??
    "http://localhost:8000/soroban/rpc";
  const horizonUrl = rpcUrl.replace("/soroban/rpc", "");
  const friendbotUrl = Deno.env.get("FRIENDBOT_URL") ??
    "http://localhost:8000/friendbot";

  return {
    networkPassphrase,
    rpcUrl,
    horizonUrl,
    friendbotUrl,
    allowHttp: true,
    channelAuthWasmPath,
    privacyChannelWasmPath,
    providerPlatformPath,
    providerUrl,
    networkConfig: NetworkConfig.CustomNet({
      networkPassphrase,
      rpcUrl,
      horizonUrl,
      friendbotUrl,
      allowHttp: true,
    }),
    networkId: networkPassphrase as StellarNetworkId,
  };
}
