/**
 * Visual click indicator for recordings.
 *
 * Injects a global capture-phase pointerdown listener on every frame that
 * paints a short-lived expanding ring at the click coordinate, so the viewer
 * can see exactly where the cursor landed.
 */
import type { BrowserContext } from "@playwright/test";

const INIT_SCRIPT = `
(() => {
  if (window.__moonlightClickHighlight) return;
  window.__moonlightClickHighlight = true;

  const STYLE_ID = "moonlight-click-highlight-style";
  function injectStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = \`
      @keyframes moonlight-click-pulse {
        0%   { transform: translate(-50%, -50%) scale(0.4); opacity: 0.85; }
        70%  { transform: translate(-50%, -50%) scale(1.2); opacity: 0.55; }
        100% { transform: translate(-50%, -50%) scale(1.6); opacity: 0; }
      }
      .moonlight-click-ring {
        position: fixed;
        top: 0; left: 0;
        width: 56px; height: 56px;
        border-radius: 50%;
        border: 3px solid #f97316;
        background: rgba(249, 115, 22, 0.18);
        box-shadow: 0 0 16px rgba(249, 115, 22, 0.7);
        pointer-events: none;
        z-index: 2147483647;
        animation: moonlight-click-pulse 700ms ease-out forwards;
      }
    \`;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function spawnRing(x, y) {
    try {
      injectStyle(document);
      const ring = document.createElement("div");
      ring.className = "moonlight-click-ring";
      ring.style.left = x + "px";
      ring.style.top = y + "px";
      document.body.appendChild(ring);
      setTimeout(() => ring.remove(), 750);
    } catch (_) { /* shadow DOM, removed body, etc. */ }
  }

  window.__moonlightSpawnRing = spawnRing;

  // Auto-spawn a ring on every click, in capture phase so we never miss one
  // (handlers that stopPropagation can't suppress us). Covers bare .click()
  // calls that don't go through clickWithPause.
  // clickWithPause sets __moonlightSuppressNextAutoRing right before its
  // own click so we don't double-ring (manual ring + auto ring on click).
  document.addEventListener("pointerdown", (e) => {
    if (window.__moonlightSuppressNextAutoRing) {
      window.__moonlightSuppressNextAutoRing = false;
      return;
    }
    spawnRing(e.clientX, e.clientY);
  }, true);
})();
`;

export async function addClickHighlight(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: INIT_SCRIPT });
}
