"""
Подготовка иконок приложения из исходного PNG.

Делает:
  build/icon.png    — 1024×1024, основа для упаковщика
  build/icon.ico    — мультиразмерный ICO для Windows (16…256)
  src/renderer/favicon.png — 128×128 для окна приложения

Запуск:
  python scripts/make-icons.py FCodeIcon.png
"""

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "FCodeIcon.png"

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def square(image: Image.Image) -> Image.Image:
    """Привести к квадрату, сохранив пропорции, с прозрачными полями."""
    image = image.convert("RGBA")
    side = max(image.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2), image)
    return canvas


def main() -> int:
    if not SOURCE.exists():
        print(f"Не найден исходник: {SOURCE}")
        return 1

    original = Image.open(SOURCE)
    print(f"Исходник: {SOURCE.name} — {original.width}×{original.height}, режим {original.mode}")

    base = square(original)

    build = ROOT / "build"
    build.mkdir(exist_ok=True)

    icon_png = build / "icon.png"
    base.resize((1024, 1024), Image.LANCZOS).save(icon_png, "PNG", optimize=True)
    print(f"Записан {icon_png.relative_to(ROOT)} — 1024×1024")

    icon_ico = build / "icon.ico"
    base.save(icon_ico, "ICO", sizes=ICO_SIZES)
    print(f"Записан {icon_ico.relative_to(ROOT)} — размеры {', '.join(str(s[0]) for s in ICO_SIZES)}")

    favicon = ROOT / "src" / "renderer" / "favicon.png"
    base.resize((128, 128), Image.LANCZOS).save(favicon, "PNG", optimize=True)
    print(f"Записан {favicon.relative_to(ROOT)} — 128×128")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
