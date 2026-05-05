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
 *
 * Always ends with a `beat` pause so the typed value is visible long enough
 * for the eye to register it before the next click fires.
 */
export async function typeSlowly(
  locator: Locator,
  text: string,
  delayMs = 35,
): Promise<void> {
  const page = await locator.page();
  if (process.env.RECORDING_FAST_TYPE === "1") {
    await locator.fill(text);
    await beat(page);
    return;
  }
  await locator.click();
  await locator.fill("");
  await locator.type(text, { delay: delayMs });
  await beat(page);
}

/**
 * Scroll into view + spawn one sustained ring + 2s wait + click.
 *
 * The ring CSS animation in click-highlight.ts holds visible for ~2s
 * before fading, so a single spawn telegraphs the target continuously.
 * The suppress flag stops the global pointerdown listener in
 * click-highlight.ts from spawning a second ring at click time.
 */
export async function clickWithPause(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const page = await locator.page();
  await beat(page);
  try {
    const box = await locator.boundingBox();
    if (box) {
      await page.evaluate(
        ({ x, y }: { x: number; y: number }) => {
          const w = globalThis as unknown as {
            __moonlightSpawnRing?: (x: number, y: number) => void;
          };
          w.__moonlightSpawnRing?.(x, y);
        },
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      );
      await page.waitForTimeout(2000);
    }
  } catch {
    // Detached / cross-origin — fall through to the click.
  }
  await page.evaluate(() => {
    (globalThis as unknown as { __moonlightSuppressNextAutoRing?: boolean })
      .__moonlightSuppressNextAutoRing = true;
  });
  await locator.click();
  await beat(page);
}

/** Move the OS cursor over an element so it's visible in the recording. */
export async function hover(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.hover();
}
