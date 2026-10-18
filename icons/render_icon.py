#!/usr/bin/env python3
"""Draw the Cloud Backup icon: a cloud with a lock, for encrypted snapshots.

Run from this directory to refresh the PNGs.
"""

import math
import struct
import zlib
from pathlib import Path

TEAL = (15, 118, 110, 255)
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)

LOCK_BODY = (54, 54, 84, 84)
LOCK_CENTER = (69, 56)
LOCK_R = 13
LOCK_THICK = 6.5
HALO = 5


def in_round_rect(x, y, left, top, right, bottom, radius):
    if x < left or y < top or x >= right or y >= bottom:
        return False
    if radius <= 0:
        return True
    if x < left + radius and y < top + radius:
        return (x - (left + radius)) ** 2 + (y - (top + radius)) ** 2 <= radius ** 2
    if x >= right - radius and y < top + radius:
        return (x - (right - radius)) ** 2 + (y - (top + radius)) ** 2 <= radius ** 2
    if x < left + radius and y >= bottom - radius:
        return (x - (left + radius)) ** 2 + (y - (bottom - radius)) ** 2 <= radius ** 2
    if x >= right - radius and y >= bottom - radius:
        return (x - (right - radius)) ** 2 + (y - (bottom - radius)) ** 2 <= radius ** 2
    return True


def in_circle(u, v, cx, cy, radius):
    return (u - cx) ** 2 + (v - cy) ** 2 <= radius ** 2


def in_cloud(u, v):
    bumps = ((30, 46, 15), (47, 36, 19), (64, 46, 13))
    for cx, cy, radius in bumps:
        if in_circle(u, v, cx, cy, radius):
            return True
    return in_round_rect(u, v, 18, 44, 70, 64, 12)


def in_shackle(u, v, cx, cy, radius, thick):
    if v > cy + thick * 0.35:
        return False
    distance = math.hypot(u - cx, v - cy)
    return radius - thick <= distance <= radius


def in_lock(u, v):
    left, top, right, bottom = LOCK_BODY
    if in_round_rect(u, v, left, top, right, bottom, 4):
        return True
    return in_shackle(u, v, LOCK_CENTER[0], LOCK_CENTER[1], LOCK_R, LOCK_THICK)


def in_lock_halo(u, v):
    left, top, right, bottom = LOCK_BODY
    if in_round_rect(u, v, left - HALO, top - HALO, right + HALO, bottom + HALO, 4 + HALO):
        return True
    return in_shackle(
        u,
        v,
        LOCK_CENTER[0],
        LOCK_CENTER[1],
        LOCK_R + HALO,
        LOCK_THICK + HALO * 2,
    )


def in_keyhole(u, v):
    cx = (LOCK_BODY[0] + LOCK_BODY[2]) / 2
    cy = LOCK_BODY[1] + 10
    if in_circle(u, v, cx, cy, 3.6):
        return True
    return in_round_rect(u, v, cx - 2.4, cy + 1, cx + 2.4, cy + 10, 1.6)


def color_at(x, y, size):
    u = (x / size) * 96
    v = (y / size) * 96
    if not in_round_rect(u, v, 0, 0, 96, 96, 22):
        return CLEAR
    if in_lock(u, v):
        if in_keyhole(u, v):
            return TEAL
        return WHITE
    if in_lock_halo(u, v):
        return TEAL
    if in_cloud(u, v):
        return WHITE
    return TEAL


def write_png(path, size):
    samples = 4
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(samples):
                for sx in range(samples):
                    px = x + (sx + 0.5) / samples
                    py = y + (sy + 0.5) / samples
                    color = color_at(px, py, size)
                    for i in range(4):
                        acc[i] += color[i]
            count = samples * samples
            row.extend(round(channel / count) for channel in acc)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    Path(path).write_bytes(png)


def main():
    here = Path(__file__).resolve().parent
    for size, name in (
        (32, "icon-32.png"),
        (48, "icon-48.png"),
        (96, "icon-96.png"),
    ):
        write_png(here / name, size)


if __name__ == "__main__":
    main()
