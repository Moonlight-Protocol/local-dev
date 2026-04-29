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
}

export function loadConfig(): Config {
  const networkPassphrase = "Test SDF Network ; September 2015";
  const rpcUrl = Deno.env.get("STELLAR_RPC_URL") ??
    "https://soroban-testnet.stellar.org";
  const horizonUrl = Deno.env.get("HORIZON_URL") ??
    "https://horizon-testnet.stellar.org";
  const friendbotUrl = Deno.env.get("FRIENDBOT_URL") ??
    "https://friendbot.stellar.org";
  const providerUrl = Deno.env.get("PROVIDER_URL") ??
    "https://provider-api-testnet.moonlightprotocol.io";

  const channelContractId = (Deno.env.get("CHANNEL_CONTRACT_ID") ??
    "CDMZSHMT2AIL2UG7XBOHZKXM6FY3MUP75HAXUUSAHLGRQ2VWPGYKPM5T") as ContractId;
  const channelAuthId = (Deno.env.get("CHANNEL_AUTH_ID") ??
    "CAF7DFHTPSYIW5543WBXJODZCDI5WF5SSHBXGMPKFOYPFRDVWFDNBGX7") as ContractId;
  const channelAssetContractId = (Deno.env.get("CHANNEL_ASSET_CONTRACT_ID") ??
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC") as ContractId;

  const networkConfig = NetworkConfig.TestNet({ allowHttp: false });

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
