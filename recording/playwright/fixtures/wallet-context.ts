/**
 * Persistent browser context for browser-wallet sections.
 *
 * Each Alice/Bob run launches its own Chromium instance with both Freighter
 * and browser-wallet loaded as extensions. Storage is throwaway — a temp
 * userDataDir per run. recordVideo writes the .webm under the run dir.
 */
import { type BrowserContext, chromium } from "@playwright/test";
import path from "path";
import os from "os";
import fs from "fs";
import process from "node:process";
import { addClickHighlight } from "./click-highlight";

const BROWSER_WALLET_PATH = process.env.BROWSER_WALLET_PATH ||
  path.join(os.homedir(), "repos", "browser-wallet", "dist");

export interface WalletContextOptions {
  /** Subdir name under <run>/videos/ for the .webm */
  section: string;
  /** RUN_ID for the recording run dir */
  runId: string;
  /** Profile name — used in the temp dir name */
  profileName: string;
  width?: number;
  height?: number;
}

export interface WalletContextHandle {
  context: BrowserContext;
  userDataDir: string;
}

export async function launchWalletContext(
  opts: WalletContextOptions,
): Promise<WalletContextHandle> {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `rec-${opts.profileName.replace(/\s/g, "-")}-`),
  );

  const videoDir = path.join(
    __dirname,
    "..",
    "..",
    "runs",
    opts.runId,
    "videos",
    opts.section,
  );

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    // viewport: null lets the actual window size drive the page size, so
    // --start-fullscreen produces a fullscreen page.
    viewport: null,
    args: [
      `--disable-extensions-except=${BROWSER_WALLET_PATH}`,
      `--load-extension=${BROWSER_WALLET_PATH}`,
      "--no-first-run",
      "--disable-default-apps",
      // Use a large windowed window pinned to the top-left, NOT macOS
      // fullscreen — `--start-fullscreen` triggers macOS's native fullscreen
      // mode which spawns a NEW Space, yanking the window off whatever
      // desktop you're recording on. `--start-maximized` + explicit
      // window-size keeps it on the current Space.
      "--start-maximized",
      `--window-position=0,0`,
      `--window-size=${opts.width ?? 1728},${opts.height ?? 1080}`,
    ],
    recordVideo: {
      dir: videoDir,
      size: {
        width: opts.width ?? 1280,
        height: opts.height ?? 720,
      },
    },
  });

  // Zoom contents to 80% so the UI fits comfortably inside the fullscreen
  // viewport while screen-recording. Apply on every navigation by hooking
  // into context.newPage and existing pages.
  const applyZoom = async (page: import("@playwright/test").Page) => {
    try {
      await page.addInitScript(() => {
        // deno-lint-ignore no-explicit-any
        (document.documentElement.style as any).zoom = "0.8";
      });
      // Also apply to the current document if it's already loaded.
      await page.evaluate(() => {
        // deno-lint-ignore no-explicit-any
        (document.documentElement.style as any).zoom = "0.8";
      }).catch(() => {});
    } catch {
      // best effort — extension popup pages may reject scripts
    }
  };
  for (const page of context.pages()) await applyZoom(page);
  context.on("page", (page) => {
    void applyZoom(page);
  });

  await addClickHighlight(context);

  return { context, userDataDir };
}

export async function closeWalletContext(
  handle: WalletContextHandle,
): Promise<void> {
  try {
    await handle.context.close();
  } catch {
    // already closed
  }
  try {
    fs.rmSync(handle.userDataDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
