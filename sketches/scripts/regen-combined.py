#!/usr/bin/env python3
"""Merge every per-flow .excalidraw under sketches/ into all-sketches-combined.excalidraw.

Layout: one row per app (in APPS order), flows arranged left-to-right within the row.
Re-run after editing any per-flow file.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # sketches/
APPS = ["provider-console", "council-console", "network-dashboard", "moonlight-pay", "browser-wallet"]
COL_GAP = 200
ROW_GAP = 400
APP_HEADER_HEIGHT = 80
FLOW_HEADER_HEIGHT = 60

def bbox(elements):
    xs = [e["x"] for e in elements if "x" in e]
    ys = [e["y"] for e in elements if "y" in e]
    ws = [e["x"]+e.get("width",0) for e in elements if "x" in e]
    hs = [e["y"]+e.get("height",0) for e in elements if "y" in e]
    return min(xs), min(ys), max(ws), max(hs)

def translate(elements, dx, dy):
    out = []
    for e in elements:
        ec = dict(e)
        if "x" in ec: ec["x"] = e["x"] + dx
        if "y" in ec: ec["y"] = e["y"] + dy
        out.append(ec)
    return out

def make_text(text, x, y, size, idx):
    return {
        "type": "text", "id": f"hdr-{idx}",
        "x": x, "y": y, "width": 1200, "height": size + 8,
        "angle": 0, "strokeColor": "#1e1e1e", "backgroundColor": "transparent",
        "fillStyle": "solid", "strokeWidth": 1, "strokeStyle": "solid",
        "roughness": 1, "opacity": 100, "groupIds": [], "frameId": None,
        "roundness": None, "seed": 1+idx, "version": 1, "versionNonce": 1+idx,
        "isDeleted": False, "boundElements": None, "updated": 1,
        "link": None, "locked": False, "text": text,
        "fontSize": size, "fontFamily": 5, "textAlign": "left",
        "verticalAlign": "top", "containerId": None, "originalText": text,
        "autoResize": True, "lineHeight": 1.25,
    }

combined_elements = []
hdr_idx = 0
cursor_y = 0
for app in APPS:
    combined_elements.append(make_text(f"━━━ {app} ━━━", 0, cursor_y, 36, hdr_idx)); hdr_idx += 1
    cursor_y += APP_HEADER_HEIGHT

    cursor_x = 0
    row_max_h = 0
    for f in sorted((ROOT / app).glob("*.excalidraw")):
        data = json.loads(f.read_text())
        elems = data.get("elements", [])
        if not elems: continue
        x0,y0,x1,y1 = bbox(elems)
        dx = -x0 + cursor_x
        dy = -y0 + cursor_y + FLOW_HEADER_HEIGHT
        translated = translate(elems, dx, dy)
        combined_elements.append(make_text(f.stem, cursor_x, cursor_y, 24, hdr_idx)); hdr_idx += 1
        combined_elements.extend(translated)
        cursor_x += (x1 - x0) + COL_GAP
        row_max_h = max(row_max_h, y1 - y0 + FLOW_HEADER_HEIGHT)
    cursor_y += row_max_h + ROW_GAP

out = {
    "type": "excalidraw", "version": 2,
    "source": "sketches/scripts/regen-combined.py",
    "elements": combined_elements,
    "appState": {"viewBackgroundColor": "#ffffff", "gridSize": 20},
    "files": {},
}
out_path = ROOT / "all-sketches-combined.excalidraw"
out_path.write_text(json.dumps(out, indent=2))
print(f"wrote {out_path} ({len(combined_elements)} elements)")
