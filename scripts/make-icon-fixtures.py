"""Создаёт тестовые картинки для проверки нарезки иконок."""
import sys

from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else r'D:\FCode-work\icon-test'

import os
os.makedirs(OUT, exist_ok=True)

# 1. Непрозрачная картинка 300x200: центр должен обрезаться до квадрата.
wide = Image.new('RGB', (300, 200), (30, 120, 200))
draw = ImageDraw.Draw(wide)
draw.rectangle((100, 50, 200, 150), fill=(250, 200, 40))
wide.save(os.path.join(OUT, 'wide.png'))

# 2. Картинка с прозрачностью 512x512: должно остаться видимое содержимое.
alpha = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(alpha)
draw.ellipse((96, 96, 416, 416), fill=(140, 60, 220, 255))
alpha.save(os.path.join(OUT, 'alpha.png'))

# 3. Высокая картинка: тоже обрезается по центру.
tall = Image.new('RGB', (200, 400), (200, 40, 90))
ImageDraw.Draw(tall).rectangle((50, 150, 150, 250), fill=(255, 255, 255))
tall.save(os.path.join(OUT, 'tall.png'))

print('создано:', OUT)
