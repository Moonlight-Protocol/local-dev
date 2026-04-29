/**
 * Pacing helpers for video recording.
 *
 * Verification tests want speed; demo videos want deliberate motion the
 * eye can follow. These helpers add intentional pauses, mouse moves, and
 * scroll-into-view actions so the resulting .webm is watchable.
 */
import type { Locator, Page } from "@playwright/test";
import process from "node:process";

const BEAT = parseInt(process.env.RECORDING_BEAT_MS ?? "600", 10);

/** Brief pause — punctuates a step transition. */
export const beat = (page: Page, multiplier = 1) =>
  page.waitForTimeout(BEAT * multiplier);

/** Long pause — gives a result room to land before the next step. */
export const hold = (page: Page) => page.waitForTimeout(BEAT * 3);

/**
 * Pause after a UI success indicator. Use this once a success signal is
 * already visible on the page so the viewer has time to register it before
 * the next step kicks off. Fixed 2000ms by request — independent of BEAT.
 */
export const holdAfterSuccess = (page: Page) => page.waitForTimeout(2000);

/**
 * Type into a field one character at a time so the viewer can read it.
 * Falls back to fill() if RECORDING_FAST_TYPE is set.
 */
export async function typeSlowly(
  locator: Locator,
  text: string,
  delayMs = 35,
): Promise<void> {
  if (process.env.RECORDING_FAST_TYPE === "1") {
    await locator.fill(text);
    return;
  }
  await locator.click();
  await locator.fill("");
  await locator.type(text, { delay: delayMs });
}

/**
 * Scroll into view + brief pause + click. Use this instead of bare .click()
 * for any visually important button so the viewer's eye reaches it first.
 */
export async function clickWithPause(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const page = await locator.page();
  await beat(page);
  await locator.click();
  await beat(page);
}

/** Move the OS cursor over an element so it's visible in the recording. */
export async function hover(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.hover();
}
