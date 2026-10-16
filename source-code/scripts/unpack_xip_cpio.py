#!/usr/bin/env python3
"""
Распаковка Xcode.xip: свой разбор потока pbzx + штатный cpio.

Разделение обязанностей:

  * поток pbzx (xar → blockSize → LZMA/raw) разбираем сами, потому что xtool
    на этом падает с «Illegal instruction» на процессорах без AVX-512;
  * разбор cpio отдаём системному cpio: он умеет жёсткие ссылки и прочие
    тонкости формата, на которых самодельный разбор сбивается.

Промежуточный файл не создаётся: распакованные блоки уходят в cpio по каналу.
Иначе нужно вдвое больше места, и диск переполняется.

Использование:
  python3 unpack_xip_cpio.py <xip-файл> <куда распаковать>
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
        print(f'  Content: {os.path.getsize(content) // MEGABYTE} МБ (готов)')
        return content

    print('  извлекаю Content из xar-контейнера…')
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


def blocks(content_path):
    """Отдавать распакованные блоки потока pbzx по мере чтения."""
    total = os.path.getsize(content_path)

    with open(content_path, 'rb') as source:
        if source.read(4) != b'pbzx':
            raise SystemExit('файл не начинается с pbzx')

        source.read(4)
        block_size = struct.unpack('>I', source.read(4))[0]
        print(f'  размер блока: {block_size // MEGABYTE} МБ')

        count = 0
        while source.tell() < total:
            header = source.read(16)
            if len(header) < 16:
                break

            _flags, length = struct.unpack('>QQ', header)
            if length == 0 or length > 64 * MEGABYTE:
                print(f'  блок {count + 1}: длина {length}, прекращаю')
                break

            chunk = source.read(length)
            if len(chunk) < length:
                break

            # Блок во весь размер идёт без сжатия, короткие — LZMA.
            if length == block_size and not chunk.startswith(b'\xfd7zX'):
                data = chunk
            else:
                data = lzma.decompress(chunk)

            count += 1
            if count % 100 == 0:
                print(f'    блоков: {count} ({source.tell() / total * 100:.0f}%)')

            yield data

        print(f'  блоков всего: {count}')


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(1)

    xip_path, destination = sys.argv[1], sys.argv[2]
    work_dir = os.environ.get('FCODE_XIP_WORK', '/tmp/fcode-xip-work')
    os.makedirs(work_dir, exist_ok=True)
    os.makedirs(destination, exist_ok=True)

    print(f'xip:        {xip_path}')
    print(f'назначение: {destination}')

    content = extract_content(xip_path, work_dir)

    print('  распаковываю через cpio…')
    process = subprocess.Popen(
        ['cpio', '-idm', '--quiet', '--no-absolute-filenames'],
        cwd=destination,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )

    try:
        for data in blocks(content):
            try:
                process.stdin.write(data)
            except BrokenPipeError:
                print('  cpio закрыл канал')
                break
    finally:
        try:
            process.stdin.close()
        except BrokenPipeError:
            pass

    stderr = process.stderr.read().decode(errors='replace').strip()
    code = process.wait()

    print(f'  cpio завершился с кодом {code}')
    if stderr:
        print(f'  сообщения cpio: {stderr[:400]}')

    xcode = os.path.join(destination, 'Xcode.app')
    if os.path.isdir(xcode):
        size = subprocess.run(
            ['du', '-sh', xcode], capture_output=True, text=True
        ).stdout.strip()
        print(f'\nXcode.app: {xcode} ({size})')
    else:
        print('\nXcode.app не найден')

    print('готово')


if __name__ == '__main__':
    main()
