#!/usr/bin/env python3
"""Generates the PNG icons (white "U" monogram on black) with the stdlib only."""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def coverage(x, y, scale):
    """Antialiased coverage of a "U" built from two stems and a half-ring, in a unit square."""
    u, v = (x + 0.5) / scale, (y + 0.5) / scale
    half, w, top, cy, r = 0.5, 0.075, 0.27, 0.57, 0.19  # stroke half-width = w
    d = min(
        seg_dist(u, v, half - r, top, half - r, cy),
        seg_dist(u, v, half + r, top, half + r, cy),
    )
    if v >= cy:
        d = min(d, abs(math.hypot(u - half, v - cy) - r))
    edge = (w - d) * scale
    return max(0.0, min(1.0, edge + 0.5))


def write_png(path, size, inner):
    """inner: fraction of the canvas the glyph occupies (1 = full, <1 = maskable safe zone)."""
    off = (1 - inner) / 2 * size
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            px, py = (x - off) / inner, (y - off) / inner
            c = coverage(px, py, size) if 0 <= px < size and 0 <= py < size else 0
            row += bytes([round(255 * c)] * 3)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


OUT.mkdir(exist_ok=True)
write_png(OUT / "icon-192.png", 192, 1)
write_png(OUT / "icon-512.png", 512, 1)
write_png(OUT / "apple-touch-icon.png", 180, 1)
write_png(OUT / "icon-maskable-512.png", 512, 0.62)
