/**
 * Multi-user browser context factory.
 *
 * Chrome extensions (Freighter) require persistent contexts, not regular
 * browser contexts. Each "user" gets their own chromium.launchPersistentContext
 * with a unique user data directory.
 *
 * Each context has:
 *   - Its own Freighter extension state (different imported account)
 *   - Isolated cookies, localStorage, sessionStorage
 *   - Its own set of pages
 */
import { type BrowserContext, chromium } from "@playwright/test";
import path from "path";
import os from "os";
import fs from "fs";
import {
  addLocalNetwork,
  openFreighterPopup,
  setupFreighterAccount,
  switchToTestnet,
} from "./freighter";
import { getFriendbotUrl, getTarget, getUrls } from "../helpers/urls";

export interface UserProfile {
  /** Human-readable name for this user context */
  name: string;
  /** Stellar public key (G...) for Friendbot funding */
  publicKey: string;
  /** Stellar secret key to import into Freighter */
  secretKey: string;
}

export interface UserContext {
  name: string;
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
}

const FREIGHTER_PASSWORD = process.env.FREIGHTER_PASSWORD ??
  "What-a-useless-req";
const EXTENSION_PATH = process.env.FREIGHTER_EXTENSION_PATH ||
  path.join(__dirname, "..", "freighter-extension");

/**
 * Create a persistent browser context for a test user.
 *
 * Each call launches a separate Chromium process with the Freighter extension
 * loaded into a unique user data directory. The function:
 *   1. Creates a temp user data dir
 *   2. Launches a persistent context with Freighter loaded
 *   3. Finds the extension ID
 *   4. Opens the Freighter popup and unlocks it
 *   5. Imports the user's secret key
 *   6. Switches to the correct network
 */
export async function createUserContext(
  _browser: unknown, // kept for API compat — ignored, each context is its own browser
  profile: UserProfile,
): Promise<UserContext> {
  // Each user gets a unique temp directory for Chrome profile data
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `pw-freighter-${profile.name.replace(/\s/g, "-")}-`),
  );

  // In Docker, pages load from non-localhost HTTP origins (e.g.
  // http://council-console:3030) where crypto.subtle is unavailable
  // (requires a secure context). Mark them as secure so WebCrypto works.
  const urls = getUrls();
  const insecureOrigins = [
    urls.councilConsole,
    urls.providerConsole,
    urls.moonlightPay,
  ]
    .filter((u) => !u.includes("localhost"))
    .map((u) => new URL(u).origin);

  const args = [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    "--no-first-run",
    "--disable-default-apps",
  ];
  if (insecureOrigins.length > 0) {
    args.push(
      `--unsafely-treat-insecure-origin-as-secure=${insecureOrigins.join(",")}`,
    );
  }

  // Video recording options (set via VIDEO_RECORD=1 env var)
  const recordVideo = process.env.VIDEO_RECORD === "1"
    ? {
      dir: path.join(
        __dirname,
        "..",
        "test-results",
        "videos",
        profile.name.replace(/\s/g, "-"),
      ),
      size: {
        width: parseInt(process.env.VIDEO_WIDTH ?? "1280", 10),
        height: parseInt(process.env.VIDEO_HEIGHT ?? "720", 10),
      },
    }
    : undefined;

  // Launch a persistent context with the extension
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args,
    recordVideo,
    ...(process.env.VIDEO_SLOWMO
      ? { slowMo: parseInt(process.env.VIDEO_SLOWMO, 10) }
      : {}),
  });

  // Give the extension time to initialize
  const pages = context.pages();
  const blankPage = pages[0] ?? (await context.newPage());
  await blankPage.goto("about:blank");
  await blankPage.waitForTimeout(3000);

  // Find the extension ID from service worker or background pages
  let extensionId: string | null = null;

  // Check service workers (MV3 extensions)
  const serviceWorkers = context.serviceWorkers();
  for (const sw of serviceWorkers) {
    const match = sw.url().match(/chrome-extension:\/\/([a-z]+)/);
    if (match) {
      extensionId = match[1];
      break;
    }
  }

  // Fallback: check background pages (MV2) or extension pages
  if (!extensionId) {
    const bgPages = context.backgroundPages();
    for (const bp of bgPages) {
      const match = bp.url().match(/chrome-extension:\/\/([a-z]+)/);
      if (match) {
        extensionId = match[1];
        break;
      }
    }
  }

  // Fallback: wait for a service worker to appear
  if (!extensionId) {
    try {
      const sw = await context.waitForEvent("serviceworker", {
        timeout: 10_000,
      });
      const match = sw.url().match(/chrome-extension:\/\/([a-z]+)/);
      if (match) extensionId = match[1];
    } catch {
      // no service worker appeared
    }
  }

  if (!extensionId) {
    throw new Error(
      `Freighter extension not found in persistent context. ` +
        `Ensure FREIGHTER_EXTENSION_PATH (${EXTENSION_PATH}) points to a valid unpacked extension.`,
    );
  }

  // Open the Freighter popup and run full onboarding (import key + set password)
  const freighterPage = await openFreighterPopup(context, extensionId);
  await setupFreighterAccount(
    freighterPage,
    profile.secretKey,
    FREIGHTER_PASSWORD,
  );

  // Switch network based on target
  const target = getTarget();
  if (target === "local") {
    await addLocalNetwork(freighterPage);
  } else if (target === "testnet") {
    await switchToTestnet(freighterPage);
  }

  // Fund the account via Friendbot (local/testnet only)
  if (target !== "mainnet") {
    const friendbotUrl = getFriendbotUrl();
    try {
      const res = await fetch(`${friendbotUrl}?addr=${profile.publicKey}`);
      if (!res.ok && res.status !== 400) {
        console.warn(
          `Friendbot funding failed for ${profile.name}: ${res.status}`,
        );
      }
    } catch (err) {
      console.warn(`Friendbot unreachable for ${profile.name}: ${err}`);
    }
  }

  // Close the Freighter setup tab
  await freighterPage.close();

  return { name: profile.name, context, extensionId, userDataDir };
}

/**
 * Close all user contexts and clean up temp directories.
 */
export async function closeAllContexts(
  contexts: Record<string, UserContext>,
): Promise<void> {
  for (const uc of Object.values(contexts)) {
    if (!uc) continue;
    try {
      await uc.context.close();
    } catch {
      // context may already be closed
    }
    // Clean up temp user data dir
    try {
      fs.rmSync(uc.userDataDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}
