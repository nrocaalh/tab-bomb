#!/usr/bin/env python3
"""Genera las tarjetas de título/cierre del vídeo demo (800x600)."""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "dist", "demo"))
FONTS = "/usr/share/fonts/truetype/dejavu"
BG = (20, 18, 26)

os.makedirs(OUT, exist_ok=True)


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)


def center(draw, text, f, y, fill, w=800):
    box = draw.textbbox((0, 0), text, font=f)
    draw.text(((w - (box[2] - box[0])) / 2 - box[0], y), text, font=f, fill=fill)


def card_title():
    img = Image.new("RGB", (800, 600), BG)
    d = ImageDraw.Draw(img)
    # halo rojo suave
    for r in range(260, 0, -6):
        a = int(26 * (1 - r / 260) ** 1.5)
        d.ellipse([400 - r, 300 - r, 400 + r, 300 + r], fill=(BG[0] + a * 2, BG[1], BG[2] + a))

    icon = Image.open(os.path.join(HERE, "..", "src", "icons", "icon128.png")).convert("RGBA")
    icon = icon.resize((150, 150), Image.LANCZOS)
    img.paste(icon, (400 - 75, 118), icon)

    center(d, "Tab Bomb", font("DejaVuSans-Bold.ttf", 62), 300, (243, 241, 247))
    center(d, "pestañas que se cierran solas", font("DejaVuSans.ttf", 26), 382, (154, 147, 168))

    d.rounded_rectangle([280, 446, 520, 490], radius=22, fill=(225, 29, 72))
    center(d, "DEMOSTRACIÓN REAL", font("DejaVuSans-Bold.ttf", 18), 457, (255, 255, 255))

    center(d, "Chrome  ·  Brave  ·  Firefox", font("DejaVuSans.ttf", 18), 528, (110, 103, 125))
    img.save(os.path.join(OUT, "card_title.png"))


def card_end():
    img = Image.new("RGB", (800, 600), BG)
    d = ImageDraw.Draw(img)
    center(d, "Listo para instalar", font("DejaVuSans-Bold.ttf", 46), 200, (243, 241, 247))

    lines = [
        ("Brave / Chrome", "brave://extensions  →  Cargar descomprimida"),
        ("Firefox", "about:debugging  →  Cargar complemento temporal"),
    ]
    y = 292
    for a, b in lines:
        center(d, a, font("DejaVuSans-Bold.ttf", 20), y, (225, 29, 72))
        center(d, b, font("DejaVuSansMono.ttf", 17), y + 30, (200, 195, 210))
        y += 92

    center(d, "tab-bomb-chrome.zip  ·  tab-bomb-firefox.zip", font("DejaVuSans.ttf", 17), 516, (110, 103, 125))
    img.save(os.path.join(OUT, "card_end.png"))


FAVICONS = {
    "github.test": ("G", (36, 41, 47), (255, 255, 255)),
    "notion.test": ("N", (245, 244, 240), (20, 18, 26)),
    "mdn.test": ("M", (26, 92, 255), (255, 255, 255)),
    "wiki.test": ("W", (99, 102, 106), (255, 255, 255)),
}


def favicons():
    out = os.path.join(OUT, "fav")
    os.makedirs(out, exist_ok=True)
    for host, (letter, bg, fg) in FAVICONS.items():
        img = Image.new("RGB", (64, 64), bg)
        d = ImageDraw.Draw(img)
        f = font("DejaVuSans-Bold.ttf", 42)
        box = d.textbbox((0, 0), letter, font=f)
        d.text(((64 - (box[2] - box[0])) / 2 - box[0], (64 - (box[3] - box[1])) / 2 - box[1] - 2), letter, font=f, fill=fg)
        img.save(os.path.join(out, host + ".png"))
    return out


if __name__ == "__main__":
    card_title()
    card_end()
    print("tarjetas en", OUT, "· favicons en", favicons())

