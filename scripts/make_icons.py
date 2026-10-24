"""Generates the LingoPick app/tray icons.

Run with Pillow available:
    python scripts/make_icons.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "src-tauri" / "icons"
ASSET_DIR = ROOT / "assets"
ACCENT = (79, 70, 229)
ACCENT_DARK = (67, 56, 202)
WHITE = (255, 255, 255)


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "C:/Windows/Fonts/msyhbd.ttc",
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/segoeuib.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                continue
    return ImageFont.load_default()


def draw_icon(size: int) -> Image.Image:
    scale = 4
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    radius = int(canvas * 0.23)
    draw.rounded_rectangle((0, 0, canvas - 1, canvas - 1), radius=radius, fill=ACCENT)
    # Subtle darker band on the lower third for a bit of depth.
    draw.rounded_rectangle(
        (0, int(canvas * 0.62), canvas - 1, canvas - 1),
        radius=radius,
        fill=ACCENT_DARK,
    )
    draw.rectangle((0, int(canvas * 0.62), canvas - 1, int(canvas * 0.85)), fill=ACCENT_DARK)
    draw.rounded_rectangle(
        (0, 0, canvas - 1, int(canvas * 0.68)), radius=radius, fill=ACCENT
    )
    font = load_font(int(canvas * 0.56))
    text = "译"
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    draw.text(
        ((canvas - (right - left)) / 2 - left, (canvas - (bottom - top)) / 2 - top),
        text,
        font=font,
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
    print("icons written to", ICON_DIR)


if __name__ == "__main__":
    main()
