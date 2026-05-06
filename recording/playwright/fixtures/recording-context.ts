/**
 * Recording-only browser launch overrides.
 *
 * The shared `playwright/fixtures/contexts.ts` ships CI-safe defaults so the
 * invite-gate / full-flow runners (Docker xvfb at 1280x960) can launch
 * Chromium without GPU init failures. Recording specs that run on a host with
 * a real display pass these overrides through `createUserContext`'s `options`
 * parameter to get a maximized window and 80% page zoom for screen capture.
 */
import type { CreateUserContextOptions } from "../../../playwright/fixtures/contexts";

export const RECORDING_CONTEXT_OPTIONS: CreateUserContextOptions = {
  // Windowed (not macOS fullscreen): `--start-fullscreen` triggers macOS
  // native fullscreen which spawns a new Space, pulling Chromium off the
  // current recording desktop. `--start-maximized` + explicit window-size
  // gives a near-full-screen window that stays on the current Space.
  extraArgs: [
    "--start-maximized",
    "--window-position=0,0",
    "--window-size=1728,1080",
  ],
  // viewport: null lets the OS window size drive the page size.
  viewport: null,
  applyZoom: true,
};
