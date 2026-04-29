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

const FREIGHTER_EXTENSION_PATH = process.env.FREIGHTER_EXTENSION_PATH ||
  path.join(__dirname, "..", "..", "..", "playwright", "freighter-extension");

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
    viewport: {
      width: opts.width ?? 1280,
      height: opts.height ?? 800,
    },
    args: [
      `--disable-extensions-except=${FREIGHTER_EXTENSION_PATH},${BROWSER_WALLET_PATH}`,
      `--load-extension=${FREIGHTER_EXTENSION_PATH}`,
      `--load-extension=${BROWSER_WALLET_PATH}`,
      "--no-first-run",
      "--disable-default-apps",
    ],
    recordVideo: {
      dir: videoDir,
      size: {
        width: opts.width ?? 1280,
        height: opts.height ?? 720,
      },
    },
  });

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
