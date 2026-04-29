/**
 * Guard against pointing local-dev scripts at mainnet APIs.
 *
 * These scripts run a real authenticated POST flow against `COUNCIL_URL` /
 * `PROVIDER_URL`. If those env vars happen to point at a mainnet endpoint
 * (local mistake, CI misconfig, paste error), the run inserts production
 * rows like `Testnet E2E {ISO}` / `Testnet Verify {ISO}` into the live DB.
 *
 * This happened on 2026-04-28 (council-platform + provider-platform mainnet).
 * The fix: refuse to run unless the URLs match a known testnet pattern, or
 * the caller passes `--allow-mainnet` explicitly.
 */

const TESTNET_HOST_PATTERNS: RegExp[] = [
  /^localhost(:\d+)?$/i,
  /^127\.0\.0\.1(:\d+)?$/,
  /^0\.0\.0\.0(:\d+)?$/,
  /^[^.]+\.local(:\d+)?$/i,
  /(^|\.)testnet\./i,
  /-testnet(\.|$)/i,
  /testnet-/i,
];

function looksLikeTestnet(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  return TESTNET_HOST_PATTERNS.some((re) => re.test(host));
}

export interface AssertNotMainnetOptions {
  scriptName: string;
  urls: Record<string, string>;
  args?: string[];
}

export function assertNotMainnet(opts: AssertNotMainnetOptions): void {
  const args = opts.args ?? Deno.args;
  const allow = args.includes("--allow-mainnet");

  const suspicious = Object.entries(opts.urls).filter(
    ([, url]) => !looksLikeTestnet(url),
  );

  if (suspicious.length === 0) return;

  if (allow) {
    console.warn(
      `\n[${opts.scriptName}] WARNING: --allow-mainnet set; running against non-testnet URLs:`,
    );
    for (const [name, url] of suspicious) {
      console.warn(`  ${name} = ${url}`);
    }
    console.warn("");
    return;
  }

  const lines = suspicious.map(([name, url]) => `  ${name} = ${url}`).join(
    "\n",
  );
  throw new Error(
    `[${opts.scriptName}] refusing to run: one or more URLs do not match a testnet pattern.\n` +
      `${lines}\n\n` +
      `These scripts make authenticated writes against the council/provider APIs.\n` +
      `If pointed at mainnet, they will insert real rows there.\n\n` +
      `If you really mean to run against this target, pass --allow-mainnet.`,
  );
}
