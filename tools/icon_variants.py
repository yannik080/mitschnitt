#!/usr/bin/env python3
"""
Erzeugt Icon-Entwürfe zum Vergleichen und legt ein Kontaktbogen-Bild ab.

    python3 tools/icon_variants.py            # Entwürfe + Vergleichsbild
    python3 tools/icon_variants.py <name>     # einen Entwurf übernehmen
"""

import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "extension" / "icons"
SHEET = ROOT / "tests" / "screenshots" / "icon-entwuerfe.png"

INK = (11, 11, 13)
CYAN = (62, 216, 216)
WHITE = (245, 245, 248)
SMPTE = [(191, 191, 191), (191, 191, 0), (0, 191, 191), (0, 191, 0),
         (191, 0, 191), (191, 0, 0), (0, 0, 191)]


def rounded(u, v, inset, radius):
    lo, hi = inset, 1.0 - inset
    if not (lo <= u <= hi and lo <= v <= hi):
        return False
    cx = min(max(u, lo + radius), hi - radius)
    cy = min(max(v, lo + radius), hi - radius)
    return (u - cx) ** 2 + (v - cy) ** 2 <= radius ** 2


def in_polygon(x, y, points):
    """Strahlenverfahren — exakte Kanten statt gestapelter Kreise."""
    inside = False
    count = len(points)
    j = count - 1
    for i in range(count):
        xi, yi = points[i]
        xj, yj = points[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


# Dieselbe Glyphe wie im Button auf der Seite: 24er-Raster, um den
# Mittelpunkt vergrößert, damit sie das Quadrat gut füllt.
_ARROW_RAW = [(11, 3), (13, 3), (13, 11.75), (16.29, 8.46), (17.71, 9.87),
              (12, 15.58), (6.29, 9.87), (7.71, 8.46), (11, 11.75)]
_BASE_RAW = [(5, 17.9), (19, 17.9), (19, 20), (5, 20)]


def _scaled(points, factor=1.2, cx=12.0, cy=11.5):
    return [(cx + (x - cx) * factor, cy + (y - cy) * factor) for x, y in points]


ARROW = _scaled(_ARROW_RAW)
BASE = _scaled(_BASE_RAW)
BASE_LEFT = min(x for x, _ in BASE)
BASE_RIGHT = max(x for x, _ in BASE)


def bar_color(position, left=0.0, right=1.0):
    span = (right - left) / len(SMPTE)
    index = min(len(SMPTE) - 1, max(0, int((position - left) / span)))
    return SMPTE[index]


# ----------------------------------------------------------------- Entwürfe ---

def variant_balken(u, v):
    """Nur der Farbbalken — das Testbild als Marke."""
    if not rounded(u, v, 0.0, 0.235):
        return None
    return bar_color(u)


def variant_pfeil(u, v):
    """Ruhig: dunkles Quadrat, ein kräftiger Pfeil."""
    if not rounded(u, v, 0.0, 0.235):
        return None
    x, y = u * 24, v * 24
    if in_polygon(x, y, ARROW) or in_polygon(x, y, BASE):
        return CYAN
    return INK


def variant_basislinie(u, v):
    """Der Pfeil steht auf dem Farbbalken — ein Element, zwei Aussagen."""
    if not rounded(u, v, 0.0, 0.235):
        return None
    x, y = u * 24, v * 24
    if in_polygon(x, y, BASE):
        return bar_color(x, BASE_LEFT, BASE_RIGHT)
    if in_polygon(x, y, ARROW):
        return WHITE
    return INK


VARIANTS = {
    "balken": variant_balken,
    "pfeil": variant_pfeil,
    "basislinie": variant_basislinie,
}


# -------------------------------------------------------------------- PNG ---

def render(sampler, size, supersample=6):
    n = size * supersample
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = a = 0
            for sy in range(supersample):
                for sx in range(supersample):
                    u = (x * supersample + sx + 0.5) / n
                    v = (y * supersample + sy + 0.5) / n
                    color = sampler(u, v)
                    if color is not None:
                        r += color[0]; g += color[1]; b += color[2]; a += 255
            total = supersample * supersample
            if a == 0:
                row += bytes((0, 0, 0, 0))
            else:
                covered = a // 255
                row += bytes((r // covered, g // covered, b // covered, a // total))
        rows.append(bytes(row))
    return rows


def write_png(path, width, height, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, payload):
        data = tag + payload
        return (struct.pack(">I", len(payload)) + data
                + struct.pack(">I", zlib.crc32(data) & 0xFFFFFFFF))

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x89PNG\r\n\x1a\n"
                     + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 9))
                     + chunk(b"IEND", b""))


def contact_sheet():
    """Jeder Entwurf groß und in Symbolleistengröße nebeneinander."""
    big, small, pad, gap = 176, 16, 26, 34
    zoom = 4                                   # 16 px vierfach gezeigt
    cell = big
    width = pad * 2 + len(VARIANTS) * cell + (len(VARIANTS) - 1) * gap
    height = pad * 2 + big + 24 + small * zoom

    canvas = [[(24, 24, 27, 255)] * width for _ in range(height)]

    for index, (name, sampler) in enumerate(VARIANTS.items()):
        left = pad + index * (cell + gap)
        for y, row in enumerate(render(sampler, big, 4)):
            for x in range(big):
                px = row[x * 4:x * 4 + 4]
                if px[3]:
                    canvas[pad + y][left + x] = tuple(px)

        tiny = render(sampler, small, 8)
        top = pad + big + 24
        for y in range(small):
            for x in range(small):
                px = tiny[y][x * 4:x * 4 + 4]
                if not px[3]:
                    continue
                for dy in range(zoom):
                    for dx in range(zoom):
                        canvas[top + y * zoom + dy][left + x * zoom + dx] = tuple(px)

    rows = [bytes(b for pixel in row for b in pixel) for row in canvas]
    write_png(SHEET, width, height, rows)
    print(f"Vergleichsbild: {SHEET}")


def install(name):
    sampler = VARIANTS[name]
    for size in (16, 32, 48, 128):
        rows = render(sampler, size, 8 if size <= 32 else 4)
        path = OUT / f"icon{size}.png"
        write_png(path, size, size, rows)
        print(f"{path.name}: {path.stat().st_size} Bytes")
    print("Entwurf \u201e%s\u201c \u00fcbernommen." % name)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        if sys.argv[1] not in VARIANTS:
            raise SystemExit(f"Unbekannt. Verfügbar: {', '.join(VARIANTS)}")
        install(sys.argv[1])
    else:
        contact_sheet()
