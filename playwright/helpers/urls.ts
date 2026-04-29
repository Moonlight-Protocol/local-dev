/**
 * URL resolution for local, testnet, and mainnet environments.
 *
 * Default: local (local-dev stack via down.sh + up.sh).
 * Set TARGET=testnet or TARGET=mainnet to switch.
 *
 * Local ports match infra-up.sh defaults.
 */

export type Target = "local" | "testnet" | "mainnet";

export interface ServiceUrls {
  providerConsole: string;
  councilConsole: string;
  moonlightPay: string;
  networkDashboard: string;
  providerApi: string;
  councilApi: string;
  payApi: string;
}

/**
 * Local service URLs. Full-URL env vars take precedence (for Docker),
 * then port-only overrides, then infra-up.sh defaults.
 */
const LOCAL_URLS: ServiceUrls = {
  providerConsole: process.env.PROVIDER_CONSOLE_URL ??
    `http://localhost:${process.env.PROVIDER_CONSOLE_PORT ?? "3020"}`,
  councilConsole: process.env.COUNCIL_CONSOLE_URL ??
    `http://localhost:${process.env.COUNCIL_CONSOLE_PORT ?? "3030"}`,
  moonlightPay: process.env.MOONLIGHT_PAY_URL ??
    `http://localhost:${process.env.MOONLIGHT_PAY_PORT ?? "3050"}`,
  networkDashboard: process.env.NETWORK_DASHBOARD_URL ??
    `http://localhost:${process.env.NETWORK_DASHBOARD_PORT ?? "3040"}`,
  providerApi: process.env.PROVIDER_API_URL ??
    `http://localhost:${process.env.PROVIDER_PORT ?? "3010"}`,
  councilApi: process.env.COUNCIL_API_URL ??
    `http://localhost:${process.env.COUNCIL_PLATFORM_PORT ?? "3015"}`,
  payApi: process.env.PAY_API_URL ??
    `http://localhost:${process.env.PAY_PLATFORM_PORT ?? "3025"}`,
};

const TESTNET_URLS: ServiceUrls = {
  providerConsole: "https://provider-testnet.moonlightprotocol.io",
  councilConsole: "https://council-testnet.moonlightprotocol.io",
  moonlightPay: "https://pay-testnet.moonlightprotocol.io",
  networkDashboard: "https://dashboard-testnet.moonlightprotocol.io",
  providerApi: "https://provider-api-testnet.moonlightprotocol.io",
  councilApi: "https://council-api-testnet.moonlightprotocol.io",
  payApi: "https://pay-api-testnet.moonlightprotocol.io",
};

const MAINNET_URLS: ServiceUrls = {
  providerConsole: "https://provider.moonlightprotocol.io",
  councilConsole: "https://council.moonlightprotocol.io",
  moonlightPay: "https://pay.moonlightprotocol.io",
  networkDashboard: "https://dashboard.moonlightprotocol.io",
  providerApi: "https://provider-api.moonlightprotocol.io",
  councilApi: "https://council-api.moonlightprotocol.io",
  payApi: "https://pay-api.moonlightprotocol.io",
};

const URL_MAP: Record<Target, ServiceUrls> = {
  local: LOCAL_URLS,
  testnet: TESTNET_URLS,
  mainnet: MAINNET_URLS,
};

export function getTarget(): Target {
  const t = process.env.TARGET?.toLowerCase();
  if (t === "testnet") return "testnet";
  if (t === "mainnet") return "mainnet";
  return "local"; // default
}

export function getUrls(target?: Target): ServiceUrls {
  return URL_MAP[target ?? getTarget()];
}

export function getStellarRpcUrl(): string {
  if (process.env.STELLAR_RPC_URL) return process.env.STELLAR_RPC_URL;
  if (getTarget() === "local") {
    const port = process.env.STELLAR_RPC_PORT ?? "8000";
    return `http://localhost:${port}/soroban/rpc`;
  }
  return getTarget() === "mainnet"
    ? "https://mainnet.sorobanrpc.com"
    : "https://soroban-testnet.stellar.org";
}

export function getFriendbotUrl(): string {
  if (process.env.FRIENDBOT_URL) return process.env.FRIENDBOT_URL;
  if (getTarget() === "local") {
    const port = process.env.STELLAR_RPC_PORT ?? "8000";
    return `http://localhost:${port}/friendbot`;
  }
  return "https://friendbot.stellar.org";
}

export function getNetworkPassphrase(): string {
  switch (getTarget()) {
    case "mainnet":
      return "Public Global Stellar Network ; September 2015";
    case "testnet":
      return "Test SDF Network ; September 2015";
    case "local":
      return "Standalone Network ; February 2017";
  }
}

/** Jaeger UI URL (local only — testnet/mainnet use Grafana Tempo). */
export function getJaegerUrl(): string {
  return process.env.JAEGER_QUERY_URL ??
    `http://localhost:${process.env.JAEGER_UI_PORT ?? "16686"}`;
}
