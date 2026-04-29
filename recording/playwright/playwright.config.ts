/**
 * Playwright config for the **video recording rig**.
 *
 * Distinct from `local-dev/playwright/` (the verification test suite):
 *   - `video: "on"` — every spec produces a .webm
 *   - Specs run sequentially; each one expects state from `run.env`
 *     produced by `setup-recording-keys.sh` and back-filled by earlier
 *     sections (CHANNEL_AUTH_ID, PRIVACY_CHANNEL_ID).
 *   - Loads BOTH the Freighter extension (council/provider consoles) AND
 *     the Moonlight browser-wallet extension (Alice/Bob), via per-context
 *     `--load-extension` — see fixtures/contexts.ts.
 *
 * Tunables:
 *   RUN_ID                  recording run namespace; used to locate run.env
 *   RECORDING_RUN_DIR       override path to recording/runs/<RUN_ID>/
 *   FREIGHTER_EXTENSION_PATH  default: ../../playwright/freighter-extension
 *   BROWSER_WALLET_PATH     default: ../../../browser-wallet/dist
 *   VIDEO_WIDTH/HEIGHT      default 1280x720
 *   VIDEO_SLOWMO            ms between actions; default 0 (use pacing helpers)
 */
import { defineConfig } from "@playwright/test";
import path from "path";
import process from "node:process";

const FREIGHTER_EXTENSION_PATH = process.env.FREIGHTER_EXTENSION_PATH ||
  path.join(__dirname, "..", "..", "playwright", "freighter-extension");

const BROWSER_WALLET_PATH = process.env.BROWSER_WALLET_PATH ||
  path.join(__dirname, "..", "..", "..", "browser-wallet", "dist");

export default defineConfig({
  testDir: "./specs",
  timeout: 900_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],

  use: {
    headless: false,
    viewport: {
      width: parseInt(process.env.VIDEO_WIDTH ?? "1280", 10),
      height: parseInt(process.env.VIDEO_HEIGHT ?? "720", 10),
    },
    actionTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "on",
  },

  projects: [
    {
      name: "chromium",
      use: {
        launchOptions: {
          args: [
            `--disable-extensions-except=${FREIGHTER_EXTENSION_PATH},${BROWSER_WALLET_PATH}`,
            `--load-extension=${FREIGHTER_EXTENSION_PATH}`,
            `--load-extension=${BROWSER_WALLET_PATH}`,
            "--no-first-run",
            "--disable-default-apps",
          ],
          ...(process.env.VIDEO_SLOWMO
            ? { slowMo: parseInt(process.env.VIDEO_SLOWMO, 10) }
            : {}),
        },
      },
    },
  ],
});
