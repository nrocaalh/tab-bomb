#!/usr/bin/env python3
"""Genera los iconos PNG de Tab Bomb (16/32/48/128): bomba negra con mecha encendida."""
import math
from PIL import Image, ImageDraw

S = 8  # supersampling
SIZES = [16, 32, 48, 128]
BASE = 128


def star(draw, cx, cy, outer, inner, points, fill):
    pts = []
    for i in range(points * 2):
        r = outer if i % 2 == 0 else inner
        a = -math.pi / 2 + i * math.pi / points
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    draw.polygon(pts, fill=fill)


def make(size):
    W = size * S
    k = W / BASE
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def sc(v):
        return v * k

    cx, cy, r = 58, 82, 44

    # --- mecha (detrás del cuerpo) ---
    pts = []
    for i in range(26):
        t = i / 25
        px = cx + 30 + t * 30
        py = cy - 34 - t * 44 + math.sin(t * math.pi * 0.9) * 5
        pts.append((px, py))
    d.line([(sc(x), sc(y)) for x, y in pts], fill=(28, 25, 23, 255), width=max(3, int(sc(11))), joint="curve")

    # --- cuerpo ---
    d.ellipse([sc(cx - r), sc(cy - r), sc(cx + r), sc(cy + r)], fill=(229, 30, 70, 255))
    d.ellipse([sc(cx - r + 5), sc(cy - r + 5), sc(cx + r - 5), sc(cy + r - 5)], fill=(23, 21, 26, 255))
    # brillo
    hr = r * 0.42
    hx, hy = cx - r * 0.34, cy - r * 0.36
    d.ellipse([sc(hx - hr), sc(hy - hr), sc(hx + hr), sc(hy + hr)], fill=(58, 54, 66, 255))
    sr = r * 0.16
    d.ellipse([sc(cx - r * 0.46 - sr), sc(cy - r * 0.46 - sr),
               sc(cx - r * 0.46 + sr), sc(cy - r * 0.46 + sr)], fill=(226, 232, 240, 220))

    # --- boquilla ---
    d.rectangle([sc(80), sc(40), sc(100), sc(56)], fill=(40, 37, 46, 255), outline=(229, 30, 70, 255), width=max(1, int(sc(3))))

    # --- chispa ---
    star(d, 106, 27, sc(19), sc(8), 6, (251, 146, 60, 255))
    d.ellipse([sc(106 - 7), sc(27 - 7), sc(106 + 7), sc(27 + 7)], fill=(254, 240, 138, 255))

    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "icons")
    os.makedirs(out, exist_ok=True)
    for s in SIZES:
        img = make(s)
        path = os.path.normpath(os.path.join(out, f"icon{s}.png"))
        img.save(path, "PNG", optimize=True)
        print("wrote", path, img.size)
