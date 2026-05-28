# UI Flow Sketches

Lofi Excalidraw wireframes of the primary user flows across the 5 Moonlight UI apps:

- `provider-console/` — Privacy Provider operator dashboard
- `council-console/` — Council governance tool
- `network-dashboard/` — Public protocol health view
- `moonlight-pay/` — POS / merchant payments
- `browser-wallet/` — Reference wallet (Chrome / Firefox extension)

Each `.excalidraw` file is one user-facing flow. Screens within a flow are drawn as labeled wireframes (navbar / title / sidebar where applicable / main content with labeled placeholder elements / footer when present), connected by arrows labeled with the trigger that drives each transition.

`all-sketches-combined.excalidraw` is a single canvas containing all 26 flows arranged as 5 app rows × up to 6 flows per row. Useful for reviewing everything together; not authoritative for any individual flow.

## Status

**First-cut.** Generated 2026-05-28 from a read of each frontend's current source (routes, views, navigation components). Intended as a starting point for design review — refine as the actual apps evolve, or rewrite from scratch where the read missed the intent. The accompanying user-flow understanding is more durable than the literal box positions.

## Purpose

- Design review — see the whole journey, not one page at a time
- Stakeholder communication — share what an app does without writing prose
- Partner demos + marketing-video planning — visual reference for what's worth showing
- Onboarding context for new devs — faster than reading view code

## Viewing + editing

Each `.excalidraw` file opens directly in:

- [excalidraw.com](https://excalidraw.com) — drag-drop the file onto the page
- [Excalidraw desktop app](https://github.com/excalidraw/excalidraw-desktop) — Open File...

Edits inside Excalidraw save back to the same `.excalidraw` format. Commit alongside the source changes that prompted the rework.

## Regenerating the combined view

The combined canvas is a mechanical merge of the per-flow files — re-run after editing any of them:

```bash
python3 sketches/scripts/regen-combined.py
```

(See the script for layout knobs: app row order, gap between flows, header sizes.)

## Conventions

- One `.excalidraw` per user flow.
- Filename = kebab-case slug describing the flow (e.g. `register-new-provider.excalidraw`).
- App subdirectory matches the repo slug exactly (`provider-console`, not `provider`).
- No mobile-shape sketches; desktop layout only.
- Lofi means labeled boxes are enough — don't chase pixel-perfect color or fonts.
- Re-derive the combined view rather than editing it directly.
