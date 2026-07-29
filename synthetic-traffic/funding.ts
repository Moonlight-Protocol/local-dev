/**
 * Funding: friendbot self-funding + the 48-hour runway dead-man check.
 *
 * Every tick estimates the fleet's needs for the next 48h against current
 * balances. Normal operation is silent; the Discord webhook fires only when
 * runway drops below the threshold (or on reset/bootstrap events) — a
 * dead-man signal on the existing webhook, per the settled design.
 */
import type { EngineEnv } from "./env.ts";

/** XLM a working account should hold to cover ~48h of fees + deposits. */
export const RUNWAY_TARGET_XLM = 200;
const RUNWAY_ALERT_XLM = 50;

export async function friendbotFund(
  env: EngineEnv,
  publicKey: string,
): Promise<void> {
  const res = await fetch(`${env.friendbotUrl}?addr=${publicKey}`);
  // 400 = already funded; anything else is a real failure.
  if (!res.ok && res.status !== 400) {
    throw new Error(
      `friendbot failed for ${publicKey}: ${res.status} ${await res.text()}`,
    );
  }
  await res.body?.cancel();
}

export async function xlmBalance(
  env: EngineEnv,
  publicKey: string,
): Promise<number | null> {
  const res = await fetch(`${env.horizonUrl}/accounts/${publicKey}`);
  if (res.status === 404) {
    await res.body?.cancel();
    return null; // unfunded / reset ledger
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`horizon ${res.status} for ${publicKey}`);
  }
  const body = await res.json();
  const native =
    (body.balances as Array<{ asset_type: string; balance: string }>)
      .find((b) => b.asset_type === "native");
  return native ? Number(native.balance) : 0;
}

/**
 * Ensure a working account exists and has runway; friendbot tops it up when
 * low (testnet friendbot re-funds any address 10k XLM once — for long-lived
 * accounts the engine rotates fee sponsorship onto fresh derived accounts if
 * friendbot declines; that path returns false so the caller can alert).
 */
export async function ensureRunway(
  env: EngineEnv,
  publicKey: string,
): Promise<{ balance: number; ok: boolean }> {
  let balance = await xlmBalance(env, publicKey);
  if (balance === null) {
    await friendbotFund(env, publicKey);
    balance = (await xlmBalance(env, publicKey)) ?? 0;
  }
  if (balance < RUNWAY_ALERT_XLM) {
    try {
      await friendbotFund(env, publicKey);
      balance = (await xlmBalance(env, publicKey)) ?? balance;
    } catch {
      // friendbot said no — caller alerts
    }
  }
  return { balance, ok: balance >= RUNWAY_ALERT_XLM };
}

/** Post to the Discord webhook; silent no-op when unset (local proving). */
export async function discordAlert(
  env: EngineEnv,
  message: string,
): Promise<void> {
  console.error(`[alert] ${message}`);
  if (!env.discordWebhookUrl) return;
  try {
    await fetch(env.discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `[synthetic-traffic] ${message}` }),
    });
  } catch (err) {
    console.error(`[alert] Discord webhook failed: ${(err as Error).message}`);
  }
}
