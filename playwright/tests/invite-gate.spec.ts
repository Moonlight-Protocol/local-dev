/**
 * Invite-only allowlist gate test.
 *
 * Validates that the client-side allowlist in each app's config.js works:
 *   - Non-allowlisted wallets see the "Invite only" screen
 *   - Allowlisted wallets pass through to the normal app
 *
 * Key derivation uses the same master seed as other tests (helpers/keys.ts).
 * The Docker Compose config (docker-compose.invite-gate.yml) includes the
 * derived admin key in each frontend's allowlist. A random keypair is used
 * for the blocked test — guaranteed not in any allowlist.
 */
import { test, expect, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { getUrls, type ServiceUrls } from "../helpers/urls";
import {
  deriveKeypair,
  masterSeedFromSecret,
  LOCAL_DEV_MASTER_SECRET,
  ROLES,
} from "../helpers/keys";
import {
  createUserContext,
  closeAllContexts,
  type UserContext,
  type UserProfile,
} from "../fixtures/contexts";
import { loginWithFreighter, loginMoonlightPay } from "../fixtures/auth";

const urls: ServiceUrls = getUrls();

// ─── Key setup ─────────────────────────────────────────────────────
//
// Allowed key: derived from master seed (admin role, index 0).
// The Docker Compose allowlist includes this public key.
//
// Blocked key: random — will never appear in any allowlist.

const masterSecret = process.env.MASTER_SECRET || LOCAL_DEV_MASTER_SECRET;
const seed = masterSeedFromSecret(masterSecret);
const allowedKp = deriveKeypair(seed, ROLES.ADMIN, 0);
const blockedKp = Keypair.random();

const allowedProfile: UserProfile = {
  name: "Allowed User",
  publicKey: allowedKp.publicKey(),
  secretKey: allowedKp.secret(),
};

const blockedProfile: UserProfile = {
  name: "Blocked User",
  publicKey: blockedKp.publicKey(),
  secretKey: blockedKp.secret(),
};

// ─── Assertions ────────────────────────────────────────────────────

/**
 * Verify the invite-only screen is shown.
 *
 * All three apps render an h2 containing "invite" and a #waitlist-email
 * input. No app content (nav bar from the page() wrapper) should be visible.
 */
async function expectInviteScreen(page: Page): Promise<void> {
  const heading = page.locator("h2").filter({ hasText: /invite/i });
  await expect(heading).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#waitlist-email")).toBeVisible();
  await expect(page.locator("nav")).not.toBeVisible();
}

/**
 * Verify the app loaded normally — no invite screen.
 *
 * After a successful sign-in with an allowlisted wallet, the app
 * navigates away from #/login. The invite heading must not be present.
 */
async function expectAppLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => !location.hash.includes("login"), {
    timeout: 30_000,
  });
  const heading = page.locator("h2").filter({ hasText: /invite/i });
  await expect(heading).not.toBeVisible();
}

// ─── Test 1: Non-allowlisted wallet is blocked ─────────────────────

test.describe("Non-allowlisted wallet is blocked", () => {
  test.describe.configure({ mode: "serial" });

  let ctx: UserContext;

  test.beforeAll(async ({ browser }) => {
    ctx = await createUserContext(browser, blockedProfile);
  });

  test.afterAll(async () => {
    if (ctx) await closeAllContexts({ blocked: ctx });
  });

  test("provider-console shows invite screen", async () => {
    const page = await ctx.context.newPage();
    await page.goto(urls.providerConsole);
    await loginWithFreighter(ctx.context, page);
    await expectInviteScreen(page);
    await page.close();
  });

  test("council-console shows invite screen", async () => {
    const page = await ctx.context.newPage();
    await page.goto(urls.councilConsole);
    await loginWithFreighter(ctx.context, page);
    await expectInviteScreen(page);
    await page.close();
  });

  test("moonlight-pay shows invite screen", async () => {
    const page = await ctx.context.newPage();
    await page.goto(urls.moonlightPay);
    await loginMoonlightPay(ctx.context, page);
    await expectInviteScreen(page);
    await page.close();
  });
});

// ─── Test 2: Allowlisted wallet gets through ────────────────────────

test.describe("Allowlisted wallet gets through", () => {
  test.describe.configure({ mode: "serial" });

  let ctx: UserContext;

  test.beforeAll(async ({ browser }) => {
    ctx = await createUserContext(browser, allowedProfile);
  });

  test.afterAll(async () => {
    if (ctx) await closeAllContexts({ allowed: ctx });
  });

  test("provider-console loads normally", async () => {
    const page = await ctx.context.newPage();
    await page.goto(urls.providerConsole);
    await loginWithFreighter(ctx.context, page);
    await expectAppLoaded(page);
    await page.close();
  });

  test("council-console loads normally", async () => {
    const page = await ctx.context.newPage();
    await page.goto(urls.councilConsole);
    await loginWithFreighter(ctx.context, page);
    await expectAppLoaded(page);
    await page.close();
  });

  test("moonlight-pay loads normally", async () => {
    const page = await ctx.context.newPage();
    await page.goto(urls.moonlightPay);
    await loginMoonlightPay(ctx.context, page);
    await expectAppLoaded(page);
    await page.close();
  });
});
