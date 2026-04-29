"""Generate the Pulse Protocol architecture diagram as an Excalidraw scene.

Layout philosophy:
- Three horizontal bands: off-chain agent runtime → Pulse + ERC-8004 → Uniswap v4.
- All cross-band arrows are right-angle (elbowed). No diagonals.
- Each box carries an official logo where one exists; logos live in
  `ai/logos/*.png` and get embedded as Excalidraw image files (data URLs).

Drops the scene at ai/diagrams/pulse-architecture.excalidraw and a render
helper next to it. Re-run after edits.
"""

from __future__ import annotations

import base64
import json
import random
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGO_DIR = ROOT / "ai" / "logos"
OUT = ROOT / "ai" / "diagrams" / "pulse-architecture.excalidraw"


# ─── element factories ──────────────────────────────────────────────────────
def rid(prefix: str = "el") -> str:
    return f"{prefix}-{random.randint(10**9, 10**12)}"


def common(*, locked: bool = False) -> dict:
    return {
        "isDeleted": False,
        "fillStyle": "solid",
        "strokeWidth": 2,
        "strokeStyle": "solid",
        "roughness": 1,
        "opacity": 100,
        "angle": 0,
        "version": 1,
        "versionNonce": random.randint(10**6, 10**9),
        "seed": random.randint(1, 10**9),
        "groupIds": [],
        "frameId": None,
        "boundElements": [],
        "updated": int(time.time() * 1000),
        "link": None,
        "locked": locked,
    }


def rect(x, y, w, h, *, color="#1971c2", bg="transparent", roundness=True):
    e = common()
    e["id"] = rid("rect")
    e["type"] = "rectangle"
    e["x"] = x
    e["y"] = y
    e["width"] = w
    e["height"] = h
    e["strokeColor"] = color
    e["backgroundColor"] = bg
    e["roundness"] = {"type": 3} if roundness else None
    return e


def text(x, y, content, *, size=18, color="#1e1e1e", align="center", w=None, h=None,
         family=2, container=None):
    e = common()
    e["id"] = rid("txt")
    e["type"] = "text"
    e["x"] = x
    e["y"] = y
    line_count = max(1, content.count("\n") + 1)
    longest_line = max((len(line) for line in content.split("\n")), default=1)
    e["width"] = w if w is not None else max(40, int(size * 0.55 * longest_line))
    e["height"] = h if h is not None else int(size * 1.25 * line_count)
    e["strokeColor"] = color
    e["backgroundColor"] = "transparent"
    e["text"] = content
    e["fontSize"] = size
    e["fontFamily"] = family
    e["textAlign"] = align
    e["verticalAlign"] = "middle"
    e["baseline"] = int(size * 0.9)
    e["lineHeight"] = 1.25
    e["roundness"] = None
    e["containerId"] = container
    e["originalText"] = content
    e["autoResize"] = True
    return e


def labeled_box(x, y, w, h, label, *, color="#1971c2", bg="#ffffff", title_size=14):
    r = rect(x, y, w, h, color=color, bg=bg)
    t = text(x, y, label, size=title_size, container=r["id"], w=w, h=h, align="center")
    r["boundElements"] = [{"type": "text", "id": t["id"]}]
    return r, t


def image_element(file_id: str, x: float, y: float, w: float, h: float, *, locked: bool = True) -> dict:
    e = common(locked=locked)
    e["id"] = rid("img")
    e["type"] = "image"
    e["x"] = x
    e["y"] = y
    e["width"] = w
    e["height"] = h
    e["strokeColor"] = "transparent"
    e["backgroundColor"] = "transparent"
    e["fileId"] = file_id
    e["status"] = "saved"
    e["scale"] = [1, 1]
    e["crop"] = None
    return e


def _anchor(box, side):
    cx = box["x"] + box["width"] / 2
    cy = box["y"] + box["height"] / 2
    if side == "right":
        return (box["x"] + box["width"], cy)
    if side == "left":
        return (box["x"], cy)
    if side == "top":
        return (cx, box["y"])
    if side == "bottom":
        return (cx, box["y"] + box["height"])
    return (cx, cy)


def arrow(src, dst, *, label=None, color="#1e1e1e", dashed=False,
          src_side="auto", dst_side="auto", elbow=True, waypoints=None,
          width=2):
    """Right-angle (elbowed) arrow between two boxes by default. Set
    elbow=False to draw a straight diagonal. waypoints=[(x,y), ...] adds
    explicit absolute-coord intermediate vertices to force a route.
    width=3 is reserved for main-flow wires (commit/reveal/swap/slash)."""
    if src_side == "auto" or dst_side == "auto":
        sx_c = src["x"] + src["width"] / 2
        sy_c = src["y"] + src["height"] / 2
        dx_c = dst["x"] + dst["width"] / 2
        dy_c = dst["y"] + dst["height"] / 2
        dx = dx_c - sx_c
        dy = dy_c - sy_c
        if abs(dx) >= abs(dy):
            auto_src = "right" if dx > 0 else "left"
            auto_dst = "left" if dx > 0 else "right"
        else:
            auto_src = "bottom" if dy > 0 else "top"
            auto_dst = "top" if dy > 0 else "bottom"
        if src_side == "auto":
            src_side = auto_src
        if dst_side == "auto":
            dst_side = auto_dst

    sx, sy = _anchor(src, src_side)
    ex, ey = _anchor(dst, dst_side)

    e = common()
    e["id"] = rid("arr")
    e["type"] = "arrow"
    e["strokeWidth"] = width
    e["x"] = sx
    e["y"] = sy
    if waypoints:
        pts = [[0, 0]]
        for wx, wy in waypoints:
            pts.append([wx - sx, wy - sy])
        pts.append([ex - sx, ey - sy])
    else:
        pts = [[0, 0], [ex - sx, ey - sy]]
    e["points"] = pts
    e["lastCommittedPoint"] = pts[-1]
    e["width"] = abs(pts[-1][0] - pts[0][0])
    e["height"] = abs(pts[-1][1] - pts[0][1])
    e["strokeColor"] = color
    e["backgroundColor"] = "transparent"
    e["strokeStyle"] = "dashed" if dashed else "solid"
    e["startArrowhead"] = None
    e["endArrowhead"] = "arrow"
    e["startBinding"] = {"elementId": src["id"], "focus": 0, "gap": 6}
    e["endBinding"] = {"elementId": dst["id"], "focus": 0, "gap": 6}
    e["roundness"] = None if elbow else {"type": 2}
    e["elbowed"] = elbow

    pieces = [e]
    src.setdefault("boundElements", []).append({"id": e["id"], "type": "arrow"})
    dst.setdefault("boundElements", []).append({"id": e["id"], "type": "arrow"})

    if label:
        lt = text(0, 0, label, size=15, color=color)
        lt["containerId"] = e["id"]
        e["boundElements"] = e.get("boundElements", []) + [{"type": "text", "id": lt["id"]}]
        pieces.append(lt)
    return pieces


# ─── logo loader ────────────────────────────────────────────────────────────
def load_logo(name: str) -> tuple[str, dict] | None:
    """Read ai/logos/<name>.png, return (file_id, file_record)."""
    p = LOGO_DIR / f"{name}.png"
    if not p.exists():
        return None
    raw = p.read_bytes()
    file_id = f"file-{name}"
    record = {
        "id": file_id,
        "mimeType": "image/png",
        "dataURL": "data:image/png;base64," + base64.b64encode(raw).decode("ascii"),
        "created": int(time.time() * 1000),
        "lastRetrieved": int(time.time() * 1000),
    }
    return file_id, record


# ─── canvas constants ───────────────────────────────────────────────────────
CANVAS_W = 1900
LOGO = 28
LOGO_PAD = 10
BAND_GAP = 80

OFF_CHAIN_TOP = 140
OFF_BOX_H = 170
ON_CHAIN_TOP = OFF_CHAIN_TOP + OFF_BOX_H + BAND_GAP * 2  # 470
ON_CHAIN_HEIGHT = 380
WATCHER_TOP = ON_CHAIN_TOP + ON_CHAIN_HEIGHT + BAND_GAP - 20  # 910

# Five columns in the off-chain band.  Wider gaps so arrow labels (loads /
# instructs / prompt / reasoning / quote req) have room to render at 15pt
# without clipping into the boxes.
OFF_COL_W = 290
OFF_COL_GAP = 60
OFF_LEFT = 60
off_xs = [OFF_LEFT + i * (OFF_COL_W + OFF_COL_GAP) for i in range(5)]

# Three columns in the on-chain band.
ON_COL_W = 360
ON_COL_GAP = 110
ON_LEFT = OFF_LEFT + 60
on_xs = [ON_LEFT + i * (ON_COL_W + ON_COL_GAP) for i in range(3)]


# ─── scene ──────────────────────────────────────────────────────────────────
elements: list[dict] = []
files: dict[str, dict] = {}


def add_logo(name: str, x: float, y: float, size: float = LOGO):
    """Place a logo image. Adds the file record on first use."""
    res = load_logo(name)
    if res is None:
        return None
    file_id, record = res
    if file_id not in files:
        files[file_id] = record
    img = image_element(file_id, x, y, size, size)
    elements.append(img)
    return img


def add_box(col_xs, col_idx, y, h, label, *, logo=None, color, bg, title_size=14):
    """Lay down a box at column index in either off- or on-chain band."""
    x = col_xs[col_idx]
    r, t = labeled_box(x, y, OFF_COL_W if col_xs is off_xs else ON_COL_W, h, label,
                       color=color, bg=bg, title_size=title_size)
    elements.append(r)
    elements.append(t)
    if logo:
        add_logo(logo, x + LOGO_PAD, y + LOGO_PAD)
    return r


# Title
elements.append(text(60, 24, "Pulse Protocol — End-to-End",
                     size=34, color="#0b7285", align="left", w=950))
elements.append(text(60, 70,
                     "Sealed agent commitments  ·  ERC-8004 reputation  ·  Uniswap v4 hook gating",
                     size=16, color="#495057", align="left", w=950))

# ── OFF-CHAIN band ────────────────────────────────────────────────────────
elements.append(text(60, OFF_CHAIN_TOP - 32, "Off-chain  (agent runtime + reasoning + market data)",
                     size=20, color="#1864ab", align="left", w=900))

hermes_box = add_box(off_xs, 0, OFF_CHAIN_TOP, OFF_BOX_H,
                     "\n\nHermes container\nNous Research / Claude Max OAuth\nloads pulse-skills, drives Agent",
                     logo="nous", color="#5f3dc4", bg="#e5dbff", title_size=15)

skills_box = add_box(off_xs, 1, OFF_CHAIN_TOP, OFF_BOX_H,
                     "\n\npulse-skills bundle\nSKILL.md × 5\ncommit · reveal · status\ngated-swap · sealed-inference",
                     logo="anthropic", color="#1864ab", bg="#d0ebff", title_size=15)

agent_box = add_box(off_xs, 2, OFF_CHAIN_TOP, OFF_BOX_H,
                    "\n\nAgent  (EOA)\n0x30cB...397c\nERC-8004 token id 5263",
                    color="#5c940d", bg="#e6fcf5", title_size=16)

zg_box = add_box(off_xs, 3, OFF_CHAIN_TOP, OFF_BOX_H,
                 "\n\n0G Compute\nTEE-attested qwen-2.5-7b\nprovider 0xa48f...",
                 logo="0g", color="#862e9c", bg="#f3d9fa", title_size=15)

trade_box = add_box(off_xs, 4, OFF_CHAIN_TOP, OFF_BOX_H,
                    "\n\nUniswap Trading API\n/v1/quote (BEST_PRICE)\nDUTCH_V2 routing",
                    logo="uniswap", color="#c92a2a", bg="#ffe3e3", title_size=15)

# ── ON-CHAIN band ────────────────────────────────────────────────────────
elements.append(text(60, ON_CHAIN_TOP - 50, "Eth Sepolia  (chainId 84532)",
                     size=20, color="#0b7285", align="left", w=600))
add_logo("base", 410, ON_CHAIN_TOP - 56, 32)

# Left column: ERC-8004 registries (stacked)
identity_box, _id_t = labeled_box(on_xs[0], ON_CHAIN_TOP, ON_COL_W, 140,
                                  "\n\nERC-8004 IdentityRegistry\n0x8004A8...BD9e",
                                  color="#0b7285", bg="#e3fafc", title_size=15)
elements.append(identity_box)
elements.append(_id_t)
add_logo("ethereum", on_xs[0] + LOGO_PAD, ON_CHAIN_TOP + LOGO_PAD)

reputation_box, _r_t = labeled_box(on_xs[0], ON_CHAIN_TOP + 175, ON_COL_W, 160,
                                   "\n\nERC-8004 ReputationRegistry\n0x8004B6...8713\ngiveFeedback +100 / -1000 / -500",
                                   color="#0b7285", bg="#e3fafc", title_size=15)
elements.append(reputation_box)
elements.append(_r_t)
add_logo("ethereum", on_xs[0] + LOGO_PAD, ON_CHAIN_TOP + 175 + LOGO_PAD)

# Center column: Pulse contract
pulse_box, _p_t = labeled_box(on_xs[1], ON_CHAIN_TOP + 75, ON_COL_W, 200,
                              "\n\n\nPulse.sol\n0xbe1b...BF34\n\ncommit  ·  reveal  ·  markExpired",
                              color="#0b7285", bg="#99e9f2", title_size=20)
elements.append(pulse_box)
elements.append(_p_t)

# Right column: Uniswap v4 stack
hook_box, _h_t = labeled_box(on_xs[2], ON_CHAIN_TOP, ON_COL_W, 130,
                             "\n\nPulseGatedHook\n0x137002...8080\nbeforeSwap — atomic reveal",
                             color="#5f3dc4", bg="#bac8ff", title_size=15)
elements.append(hook_box)
elements.append(_h_t)
add_logo("uniswap", on_xs[2] + LOGO_PAD, ON_CHAIN_TOP + LOGO_PAD)

pm_box, _pm_t = labeled_box(on_xs[2], ON_CHAIN_TOP + 150, ON_COL_W, 110,
                            "\n\nUniswap v4 PoolManager\n0x05E73354...3408",
                            color="#5f3dc4", bg="#bac8ff", title_size=15)
elements.append(pm_box)
elements.append(_pm_t)
add_logo("uniswap", on_xs[2] + LOGO_PAD, ON_CHAIN_TOP + 150 + LOGO_PAD)

pool_box, _pool_t = labeled_box(on_xs[2], ON_CHAIN_TOP + 280, ON_COL_W, 110,
                                "\n\nPool: pUSD ↔ pWETH\nfee 0.3%  ·  tickSpacing 60",
                                color="#5f3dc4", bg="#bac8ff", title_size=15)
elements.append(pool_box)
elements.append(_pool_t)
add_logo("uniswap", on_xs[2] + LOGO_PAD, ON_CHAIN_TOP + 280 + LOGO_PAD)

# ── Watcher (off-chain, but bottom of canvas) ─────────────────────────────
watcher_box, _w_t = labeled_box(on_xs[1], WATCHER_TOP, ON_COL_W, 130,
                                "\n\nWatcher  (off-chain service)\nscripts/watch-and-slash.ts\ndirect Pulse.reveal — lock Violated",
                                color="#c92a2a", bg="#ffd8a8", title_size=15)
elements.append(watcher_box)
elements.append(_w_t)


# ── arrows ─────────────────────────────────────────────────────────────────
def add_arrow(src, dst, **kw):
    elements.extend(arrow(src, dst, **kw))

# Off-chain horizontal flows
add_arrow(hermes_box, skills_box, label="loads", color="#5f3dc4")
add_arrow(skills_box, agent_box, label="instructs", color="#1864ab")
add_arrow(agent_box, zg_box, label="prompt", color="#862e9c")
add_arrow(zg_box, agent_box, label="reasoning", color="#862e9c", dashed=True,
          src_side="bottom", dst_side="bottom")
# Trading API ↔ Agent need to route around 0G (which sits between them).
# Send the request along the top via explicit waypoints that stay on canvas;
# keep the response along the bottom (mirrors the 0G request/response shape).
trade_top_y = OFF_CHAIN_TOP - 30  # well below the title block
add_arrow(agent_box, trade_box, label="quote req", color="#c92a2a",
          src_side="top", dst_side="top",
          waypoints=[(agent_box["x"] + agent_box["width"] / 2, trade_top_y),
                     (trade_box["x"] + trade_box["width"] / 2, trade_top_y)])
trade_bottom_y = OFF_CHAIN_TOP + OFF_BOX_H + 30
add_arrow(trade_box, agent_box, label="quote", color="#c92a2a", dashed=True,
          src_side="bottom", dst_side="bottom",
          waypoints=[(trade_box["x"] + trade_box["width"] / 2, trade_bottom_y),
                     (agent_box["x"] + agent_box["width"] / 2, trade_bottom_y)])

# Cross-band: Agent → Pulse
add_arrow(agent_box, pulse_box, label="commit / reveal", color="#0b7285",
          src_side="bottom", dst_side="top", width=3)

# Pulse ↔ ERC-8004 (left)
add_arrow(pulse_box, identity_box, label="isAuthorizedOrOwner", color="#0b7285",
          src_side="left", dst_side="right")
add_arrow(pulse_box, reputation_box, label="giveFeedback", color="#c92a2a",
          src_side="left", dst_side="right", width=3)

# Pulse ↔ Hook (right)
add_arrow(hook_box, pulse_box, label="getCommitment + reveal", color="#5f3dc4",
          dashed=True, src_side="left", dst_side="right")

# v4 swap path: route Agent → PoolManager via an L-elbow so the line stays
# in the right gutter (between Pulse and the v4 stack) instead of cutting
# diagonally across the diagram.
agent_bottom_x = agent_box["x"] + agent_box["width"] / 2
agent_bottom_y = agent_box["y"] + agent_box["height"]
pm_top_x = pm_box["x"] + pm_box["width"] / 2
pm_top_y = pm_box["y"]
elbow_x = pm_top_x  # turn at the PoolManager column
elbow_y = ON_CHAIN_TOP - 30  # halfway down the gutter

add_arrow(agent_box, pm_box, label="swap(hookData)", color="#5f3dc4",
          src_side="bottom", dst_side="top",
          waypoints=[(agent_bottom_x, elbow_y), (elbow_x, elbow_y)],
          width=3)
add_arrow(pm_box, hook_box, label="beforeSwap", color="#5f3dc4",
          src_side="top", dst_side="bottom")
add_arrow(pm_box, pool_box, label="execute", color="#5f3dc4",
          src_side="bottom", dst_side="top")

# Watcher loop
# Route "failed swap" along a clean L-elbow: down from Pool's bottom, then
# horizontally over to the watcher's right side. Avoids the diagonal that
# was crossing the Pulse box.
pool_bottom_x = pool_box["x"] + pool_box["width"] / 2
pool_bottom_y = pool_box["y"] + pool_box["height"]
watcher_right_x = watcher_box["x"] + watcher_box["width"]
watcher_right_y = watcher_box["y"] + watcher_box["height"] / 2
elbow_y = WATCHER_TOP - 30  # gutter between v4 stack and watcher
add_arrow(pool_box, watcher_box, label="failed swap", color="#c92a2a", dashed=True,
          src_side="bottom", dst_side="right",
          waypoints=[(pool_bottom_x, elbow_y), (watcher_right_x + 60, elbow_y),
                     (watcher_right_x + 60, watcher_right_y)])
add_arrow(watcher_box, pulse_box, label="reveal — lock Violated", color="#c92a2a",
          src_side="top", dst_side="bottom", width=3)

# Footer
elements.append(text(60, WATCHER_TOP + 140,
                     "Threat model: hook revert on intent mismatch rolls Violated state back. "
                     "The off-chain watcher closes the gap by calling Pulse.reveal directly with the bad params.",
                     size=13, color="#495057", align="left", w=1400, h=40))


# ─── pack scene ────────────────────────────────────────────────────────────
scene = {
    "type": "excalidraw",
    "version": 2,
    "source": "https://excalidraw.com",
    "elements": [e for e in elements if e is not None],
    "appState": {
        "viewBackgroundColor": "#ffffff",
        "currentItemFontFamily": 2,
        "gridSize": None,
    },
    "files": files,
}

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(scene, indent=2))
n_logos = sum(1 for e in scene["elements"] if e["type"] == "image")
print(f"✓ {OUT}  ({len(scene['elements'])} elements, {n_logos} logos, "
      f"{len(scene['files'])} files, {OUT.stat().st_size} bytes)")
