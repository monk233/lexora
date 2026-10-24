"""Generates the Lexora app/tray icons.

Design: an abstract geometric mark (selection corner brackets around a diamond
lens) on a rounded indigo/violet tile. No text or letterforms, so it stays
readable at 16 px in the tray and taskbar.

Run with Pillow available:
    python scripts/make_icons.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "src-tauri" / "icons"
ASSET_DIR = ROOT / "assets"
TOP = (99, 102, 241)  # indigo-500
BOTTOM = (91, 33, 182)  # violet-800
WHITE = (255, 255, 255, 255)


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    image = Image.new("RGBA", (size, size))
    pixels = image.load()
    for y in range(size):
        t = y / max(1, size - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(size):
            pixels[x, y] = (*color, 255)
    return image


def draw_icon(size: int) -> Image.Image:
    scale = 4
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))

    # Rounded tile with a diagonal indigo -> violet gradient.
    gradient = vertical_gradient(canvas, TOP, BOTTOM)
    radius = int(canvas * 0.23)
    mask = Image.new("L", (canvas, canvas), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, canvas - 1, canvas - 1), radius=radius, fill=255)
    image.paste(gradient, (0, 0), mask)
    draw = ImageDraw.Draw(image)

    # Mark geometry (relative to the tile).
    inset = canvas * 0.21
    arm = canvas * 0.20
    thickness = canvas * 0.075
    half = max(1, round(thickness / 2))
    left = inset
    top = inset
    right = canvas - 1 - inset
    bottom = canvas - 1 - inset

    def rounded_bar(x0: float, y0: float, x1: float, y1: float) -> None:
        draw.rounded_rectangle(
            (round(x0), round(y0), round(x1), round(y1)),
            radius=half,
            fill=WHITE,
        )

    # Four selection corners.
    rounded_bar(left, top, left + arm, top + thickness)
    rounded_bar(left, top, left + thickness, top + arm)
    rounded_bar(right - arm, top, right, top + thickness)
    rounded_bar(right - thickness, top, right, top + arm)
    rounded_bar(left, bottom - thickness, left + arm, bottom)
    rounded_bar(left, bottom - arm, left + thickness, bottom)
    rounded_bar(right - arm, bottom - thickness, right, bottom)
    rounded_bar(right - thickness, bottom - arm, right, bottom)

    # Small sizes get a filled centre so the mark stays crisp at 16-24 px.
    if size <= 24:
        center = canvas / 2
        dot_half = canvas * 0.105
        draw.polygon(
            [
                (center, center - dot_half),
                (center + dot_half, center),
                (center, center + dot_half),
                (center - dot_half, center),
            ],
            fill=WHITE,
        )
        return image.resize((size, size), Image.LANCZOS)

    # Centre diamond lens.
    center = canvas / 2
    diamond_half = canvas * 0.155
    stroke = max(2, round(canvas * 0.062))
    points = [
        (center, center - diamond_half),
        (center + diamond_half, center),
        (center, center + diamond_half),
        (center - diamond_half, center),
        (center, center - diamond_half),
    ]
    draw.line(points, fill=WHITE, width=stroke, joint="curve")
    # Round the diamond tips so small sizes stay clean.
    dot = max(1, stroke // 2)
    for point in points[:4]:
        draw.ellipse(
            (point[0] - dot, point[1] - dot, point[0] + dot, point[1] + dot),
            fill=WHITE,
        )

    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    images = {size: draw_icon(size) for size in sizes}
    images[256].save(ICON_DIR / "icon.ico", sizes=[(size, size) for size in sizes])
    images[32].save(ICON_DIR / "32x32.png")
    images[128].save(ICON_DIR / "128x128.png")
    images[256].save(ICON_DIR / "icon.png")
    images[32].save(ASSET_DIR / "tray.png")
    images[256].save(ASSET_DIR / "icon.png")
    images[256].save(ASSET_DIR / "icon.ico", sizes=[(size, size) for size in sizes])
    images[256].save(ROOT / "docs" / "images" / "logo.png")
    for preview_size in (512,):
        draw_icon(preview_size).save(ROOT / "docs" / "images" / "logo-preview.png")
    print("icons written to", ICON_DIR)


if __name__ == "__main__":
    main()
