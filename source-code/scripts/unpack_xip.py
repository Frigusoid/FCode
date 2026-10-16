#!/usr/bin/env python3
"""
Распаковка Xcode.xip без xtool.

Зачем: xtool распаковывает xip своей библиотекой libunxip, и на процессорах
без AVX-512 она падает с «Illegal instruction» (проверено на AMD Ryzen 5 3600X:
распаковка Xcode 16.4 обрывается на 60%). Формат несложный, поэтому разбираем
его сами — xtool потом принимает готовый Xcode.app.

Устройство .xip:

  xar-контейнер
    └── Content          — поток pbzx
          └── cpio       — файлы Xcode.app

Формат pbzx (проверено на реальном Xcode_16.4.xip):

  "pbzx"                4 байта
  flags                 4 байта, BE — версия потока
  blockSize             4 байта, BE — размер распакованного блока (16 МБ)
  далее блоки:
      flags             8 байт, BE — всегда равен размеру блока
      length            8 байт, BE — сколько занимает в файле
      data              length байт

  Блок длиной ровно blockSize идёт БЕЗ сжатия; более короткие блоки сжаты
  LZMA-alone (сигнатура fd 37 7a 58 5a). Это и было главной тонкостью: если
  считать сжатыми все блоки подряд, распаковка обрывается на третьем.

Промежуточный cpio-файл не создаётся: распакованные блоки сразу уходят в cpio
через канал. Иначе нужно вдвое больше места (15 ГБ на поток и столько же на
распакованные файлы), и диск в WSL переполняется.

Использование:
  python3 unpack_xip.py <xip-файл> <куда распаковать>
"""

import lzma
import os
import struct
import subprocess
import sys

MEGABYTE = 1024 * 1024


def extract_content(xip_path, work_dir):
    """Достать из xar-контейнера поток Content."""
    content = os.path.join(work_dir, 'Content')

    if os.path.exists(content) and os.path.getsize(content) > 0:
        print(f'  Content уже извлечён: {os.path.getsize(content) // MEGABYTE} МБ')
        return content

    print('  извлекаю Content из xar-контейнера…')
    # xar ругается на Metadata без поддержки bzip2 — это не мешает.
    subprocess.run(
        ['xar', '-xf', xip_path, 'Content'],
        cwd=work_dir,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    if not os.path.exists(content):
        raise SystemExit('не удалось извлечь Content из xip')

    print(f'  Content: {os.path.getsize(content) // MEGABYTE} МБ')
    return content


def stream_blocks(content_path):
    """
    Разбирать поток pbzx и отдавать распакованные куски.

    Промежуточный файл не создаётся: вызывающий сразу передаёт куски дальше.
    """
    total = os.path.getsize(content_path)

    with open(content_path, 'rb') as source:
        if source.read(4) != b'pbzx':
            raise SystemExit('файл не начинается с pbzx')

        source.read(4)  # версия потока
        block_size = struct.unpack('>I', source.read(4))[0]
        print(f'  размер блока: {block_size // MEGABYTE} МБ')

        written = 0
        blocks = 0

        while source.tell() < total:
            header = source.read(16)
            if len(header) < 16:
                break

            _flags, length = struct.unpack('>QQ', header)

            if length == 0 or length > 64 * MEGABYTE:
                print(f'  блок {blocks + 1}: неправдоподобная длина {length}, прекращаю')
                break

            chunk = source.read(length)
            if len(chunk) < length:
                print(f'  файл кончился на блоке {blocks + 1}')
                break

            if length == block_size and not chunk.startswith(b'\xfd7zX'):
                data = chunk
            else:
                data = lzma.decompress(chunk)

            blocks += 1
            written += len(data)

            if blocks % 25 == 0:
                done = source.tell() / total * 100
                print(f'    блоков: {blocks}, отдано: {written // MEGABYTE} МБ ({done:.0f}%)')

            yield data

        print(f'  всего блоков: {blocks}, распаковано: {written // MEGABYTE} МБ')


def unpack_to_cpio(content_path, destination):
    """Передать распакованный поток прямо в cpio, без промежуточного файла."""
    print('  распаковываю в cpio (потоком)…')
    os.makedirs(destination, exist_ok=True)

    process = subprocess.Popen(
        ['cpio', '-idm', '--quiet', '--no-absolute-filenames'],
        cwd=destination,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )

    try:
        for data in stream_blocks(content_path):
            process.stdin.write(data)
    except BrokenPipeError:
        print('  cpio закрыл канал досрочно')
    finally:
        try:
            process.stdin.close()
        except BrokenPipeError:
            pass

    stderr = process.stderr.read().decode(errors='replace').strip()
    code = process.wait()

    if code != 0:
        print(f'  cpio вернул код {code}')
        if stderr:
            print(f'    {stderr[:300]}')
        return False

    print('  распаковано через cpio')
    return True


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(1)

    xip_path, destination = sys.argv[1], sys.argv[2]
    work_dir = os.path.join(destination, '.xip-work')
    os.makedirs(work_dir, exist_ok=True)

    print(f'xip:        {xip_path}')
    print(f'назначение: {destination}')

    content = extract_content(xip_path, work_dir)

    if not unpack_to_cpio(content, destination):
        raise SystemExit('не удалось распаковать cpio')

    for root, dirs, _ in os.walk(destination):
        if 'Xcode.app' in dirs:
            print(f'\nXcode.app: {os.path.join(root, "Xcode.app")}')
            break
    else:
        print('\nXcode.app не найден')

    print('готово')


if __name__ == '__main__':
    main()
