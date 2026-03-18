const WASM_DIR = new URL("../e2e/wasms", import.meta.url).pathname;

export interface LifecycleConfig {
  channelAuthWasmPath: string;
  privacyChannelWasmPath: string;
  providerPlatformPath: string;
}

export function loadConfig(): LifecycleConfig {
  return {
    channelAuthWasmPath: Deno.env.get("CHANNEL_AUTH_WASM") ??
      `${WASM_DIR}/channel_auth_contract.wasm`,
    privacyChannelWasmPath: Deno.env.get("PRIVACY_CHANNEL_WASM") ??
      `${WASM_DIR}/privacy_channel.wasm`,
    providerPlatformPath: Deno.env.get("PROVIDER_PLATFORM_PATH") ??
      `${Deno.env.get("HOME")}/repos/provider-platform`,
  };
}
