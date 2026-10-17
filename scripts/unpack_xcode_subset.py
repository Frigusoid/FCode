#!/usr/bin/env python3
"""
Распаковка Xcode.xip без xtool — только те файлы, которые нужны для SDK.

Зачем такой отбор. xtool распаковывает xip своей библиотекой libunxip, и на
процессорах без AVX-512 она падает с «Illegal instruction» (проверено на
AMD Ryzen 5 3600X). Разбираем формат сами.

Полный Xcode — это ~15 ГБ и сотни тысяч мелких файлов. Записывать их на диск
Windows через 9p-монтирование очень медленно. Но xtool для сборки SDK берёт
лишь часть — список задан в его исходниках (SDKBuilder.SDKEntry.wanted):

  Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/
      swift, swift_static, clang
  Contents/Developer/Platforms/{iPhoneOS,MacOSX,iPhoneSimulator}.platform/
      Info.plist
      Developer/SDKs
      Developer/Library/Frameworks
      Developer/Library/PrivateFrameworks
      Developer/usr/lib
  Contents/Info.plist, Contents/version.plist

Эти пути и распаковываем. Формат cpio разбираем сами: он простой, а внешний
cpio не умеет пропускать ненужное без чтения всего потока.

Использование:
  python3 unpack_xcode_subset.py <xip-файл> <куда распаковать>
"""

import lzma
import os
import struct
import subprocess
import sys

MEGABYTE = 1024 * 1024

# Префиксы путей, которые нужны xtool для сборки SDK.
# Внутри архива пути начинаются с «./Xcode.app/»: проверено на реальном файле.
APP = './Xcode.app/'

WANTED_PREFIXES = (
    f'{APP}Contents/Info.plist',
    f'{APP}Contents/version.plist',
    f'{APP}Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/',
    f'{APP}Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift_static/',
    f'{APP}Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/clang/',
    f'{APP}Contents/Developer/Platforms/iPhoneOS.platform/Info.plist',
    f'{APP}Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/',
    f'{APP}Contents/Developer/Platforms/iPhoneOS.platform/Developer/Library/Frameworks/',
    f'{APP}Contents/Developer/Platforms/iPhoneOS.platform/Developer/Library/PrivateFrameworks/',
    f'{APP}Contents/Developer/Platforms/iPhoneOS.platform/Developer/usr/lib/',
    f'{APP}Contents/Developer/Platforms/MacOSX.platform/Info.plist',
    f'{APP}Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/',
    f'{APP}Contents/Developer/Platforms/MacOSX.platform/Developer/Library/Frameworks/',
    f'{APP}Contents/Developer/Platforms/MacOSX.platform/Developer/Library/PrivateFrameworks/',
    f'{APP}Contents/Developer/Platforms/MacOSX.platform/Developer/usr/lib/',
    f'{APP}Contents/Developer/Platforms/iPhoneSimulator.platform/Info.plist',
    f'{APP}Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/SDKs/',
    f'{APP}Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/Library/Frameworks/',
    f'{APP}Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/Library/PrivateFrameworks/',
    f'{APP}Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/usr/lib/',
)


def wanted(name):
    """Нужен ли файл с таким путём внутри архива."""
    # Каталоги нужны все: без них не создать структуру.
    if name.endswith('/'):
        return True

    normalized = name if name.startswith('./') else f'./{name}'
    return any(
        normalized == prefix or normalized.startswith(prefix) or prefix.startswith(normalized)
        for prefix in WANTED_PREFIXES
    )


def extract_content(xip_path, work_dir):
    """Достать из xar-контейнера поток Content."""
    content = os.path.join(work_dir, 'Content')

    if os.path.exists(content) and os.path.getsize(content) > 0:
        print(f'  Content: {os.path.getsize(content) // MEGABYTE} МБ (уже извлечён)')
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


def stream_blocks(content_path):
    """Отдавать распакованные блоки потока pbzx по мере чтения."""
    total = os.path.getsize(content_path)

    with open(content_path, 'rb') as source:
        if source.read(4) != b'pbzx':
            raise SystemExit('файл не начинается с pbzx')

        source.read(4)
        block_size = struct.unpack('>I', source.read(4))[0]
        print(f'  размер блока: {block_size // MEGABYTE} МБ')

        blocks = 0
        while source.tell() < total:
            header = source.read(16)
            if len(header) < 16:
                break

            _flags, length = struct.unpack('>QQ', header)
            if length == 0 or length > 64 * MEGABYTE:
                break

            chunk = source.read(length)
            if len(chunk) < length:
                break

            # Блок во весь размер идёт без сжатия, короткие — LZMA.
            if length == block_size and not chunk.startswith(b'\xfd7zX'):
                data = chunk
            else:
                data = lzma.decompress(chunk)

            blocks += 1
            if blocks % 100 == 0:
                print(f'    блоков: {blocks} ({source.tell() / total * 100:.0f}%)')

            yield data


class CpioReader:
    """
    Разбор потока cpio.

    Xcode использует формат 070707 (odc): после магии идут поля фиксированной
    ширины в восьмеричном виде:

      dev 6, ino 6, mode 6, uid 6, gid 6, nlink 6, rdev 6,
      mtime 11, namesize 6, filesize 11

    Итого заголовок 76 байт, затем имя длиной namesize (включая нулевой байт)
    и данные. Выравнивания нет — в отличие от формата 070701.
    """

    MAGIC = b'070707'
    HEADER_SIZE = 76

    def __init__(self):
        self.buffer = b''
        self.offset = 0

    def feed(self, data):
        self.buffer += data

    def _need(self, count):
        return len(self.buffer) - self.offset >= count

    def _read(self, count):
        chunk = self.buffer[self.offset:self.offset + count]
        self.offset += count
        return chunk

    def _compact(self):
        # Буфер растёт по мере чтения — убираем прочитанное, чтобы не копить 15 ГБ.
        if self.offset > 8 * MEGABYTE:
            self.buffer = self.buffer[self.offset:]
            self.offset = 0

    def entries(self):
        """Отдавать (имя, режим, данные) по мере разбора."""
        entries_read = 0

        while True:
            if not self._need(self.HEADER_SIZE):
                return

            header = self.buffer[self.offset:self.offset + self.HEADER_SIZE]

            # Если магия не совпала — ищем ближайший заголовок вперёд.
            # Так разбор продолжается вместо падения на одной кривой записи.
            if header[:6] != self.MAGIC:
                drift = self.buffer.find(self.MAGIC, self.offset + 1)
                if drift == -1:
                    return
                print(f'    запись {entries_read + 1}: сдвиг на {drift - self.offset} байт, '
                      f'выравниваюсь')
                self.offset = drift
                continue

            def field(start, width):
                raw = header[start:start + width].decode('ascii', errors='replace').strip()
                # Значение может оказаться не восьмеричным, если запись
                # разобрана не с начала. Тогда считаем поле нулевым, а
                # выравнивание сделает проверка магии ниже.
                try:
                    return int(raw, 8)
                except ValueError:
                    return -1

            mode = field(12, 6)
            name_size = field(59, 6)
            file_size = field(65, 11)

            # Имя обязано быть осмысленным: иначе мы не на границе записи.
            total = self.HEADER_SIZE + name_size
            if (
                mode < 0
                or name_size <= 0
                or name_size > 4096
                or file_size < 0
                or file_size > 8 * 1024 * MEGABYTE
            ):
                drift = self.buffer.find(self.MAGIC, self.offset + 1)
                if drift == -1:
                    return
                print(f'    запись {entries_read + 1}: неправдоподобный заголовок '
                      f'(имя {name_size}, размер {file_size}), выравниваюсь')
                self.offset = drift
                continue

            if not self._need(total + file_size):
                return

            name = self._read(name_size)[:-1].decode('utf-8', errors='replace')

            if name == 'TRAILER!!!':
                return

            data = self._read(file_size)
            entries_read += 1
            self._compact()

            yield name, mode, data


def write_entry(destination, name, mode, data):
    """Записать файл или каталог из архива."""
    relative = name.lstrip('./')
    if not relative or relative.startswith('/'):
        return False

    # Изредка имя приходит со сдвигом и содержит кусок заголовка cpio.
    # Такие записи пропускаем: путь всё равно неверный.
    if '070707' in relative or '\x00' in relative:
        return False

    target = os.path.join(destination, relative)
    kind = mode & 0o170000

    if kind == 0o040000:  # каталог
        os.makedirs(target, exist_ok=True)
        return True

    if kind == 0o120000:  # символическая ссылка
        os.makedirs(os.path.dirname(target), exist_ok=True)
        link_target = data.decode('utf-8', errors='replace')
        if os.path.islink(target):
            os.remove(target)
        try:
            os.symlink(link_target, target)
        except OSError:
            pass  # на 9p ссылки могут не поддерживаться — пропускаем
        return True

    if kind == 0o100000:  # обычный файл
        os.makedirs(os.path.dirname(target), exist_ok=True)
        try:
            with open(target, 'wb') as handle:
                handle.write(data)
        except IsADirectoryError:
            return False
        return True

    return False


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(1)

    xip_path, destination = sys.argv[1], sys.argv[2]
    work_dir = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'fcode-xip-work')
    os.makedirs(work_dir, exist_ok=True)

    print(f'xip:        {xip_path}')
    print(f'назначение: {destination}')
    print('  беру только файлы, нужные xtool для сборки SDK')

    content = extract_content(xip_path, work_dir)

    reader = CpioReader()
    written = 0
    skipped = 0
    total_bytes = 0

    for block in stream_blocks(content):
        reader.feed(block)

        for name, mode, data in reader.entries():
            if wanted(name):
                if write_entry(destination, name, mode, data):
                    written += 1
                    total_bytes += len(data)
                    if written % 500 == 0:
                        print(f'    файлов: {written}, записано: {total_bytes // MEGABYTE} МБ')
            else:
                skipped += 1

    print(f'\n  записано файлов: {written} ({total_bytes // MEGABYTE} МБ)')
    print(f'  пропущено: {skipped}')

    xcode_app = os.path.join(destination, 'Xcode.app')
    if os.path.isdir(xcode_app):
        print(f'\nXcode.app: {xcode_app}')
    else:
        print('\nXcode.app не найден — проверьте пути')

    print('готово')


if __name__ == '__main__':
    main()
