import { defineConfig } from "@playwright/test";
import path from "path";

const extensionPath = process.env.FREIGHTER_EXTENSION_PATH ||
  path.join(__dirname, "freighter-extension");

export default defineConfig({
  testDir: "./tests",
  timeout: 600_000, // 10 min — full flow is long
  expect: { timeout: 30_000 },
  fullyParallel: false, // sequential — steps depend on each other
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],

  use: {
    headless: false, // extensions require headed mode
    viewport: { width: 1280, height: 800 },
    actionTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: {
        // Chromium with extension support
        launchOptions: {
          args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            "--no-first-run",
            "--disable-default-apps",
          ],
        },
      },
    },
  ],
});
