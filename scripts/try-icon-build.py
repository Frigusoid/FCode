"""Эксперимент: соберёт ли xtool иконку из Assets.xcassets.

Создаёт простую PNG 1024x1024 и каталог AppIcon.appiconset, кладёт их в
тестовый проект и печатает, что оказалось в собранном .app.
"""
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw

ROOT = '/tmp/icontest'


def sh(command):
    return subprocess.run(['bash', '-lc', command], capture_output=True, text=True)


def main():
    sh(f'rm -rf {ROOT}')
    os.makedirs(f'{ROOT}/Sources/icontest', exist_ok=True)

    # Проект
    with open(f'{ROOT}/Package.swift', 'w', encoding='utf-8') as handle:
        handle.write(
            '// swift-tools-version: 6.0\n'
            'import PackageDescription\n\n'
            'let package = Package(\n'
            '    name: "icontest",\n'
            '    platforms: [.iOS(.v17)],\n'
            '    products: [.library(name: "icontest", targets: ["icontest"])],\n'
            '    targets: [\n'
            '        .target(\n'
            '            name: "icontest",\n'
            '            resources: [.process("Assets.xcassets")]\n'
            '        )\n'
            '    ]\n'
            ')\n'
        )

    with open(f'{ROOT}/xtool.yml', 'w', encoding='utf-8') as handle:
        handle.write('version: 1\nbundleID: com.example.icontest\n')

    with open(f'{ROOT}/Sources/icontest/App.swift', 'w', encoding='utf-8') as handle:
        handle.write(
            'import SwiftUI\n\n'
            '@main\n'
            'struct IconTestApp: App {\n'
            '    var body: some Scene { WindowGroup { Text("icon") } }\n'
            '}\n'
        )

    # Каталог ресурсов с иконкой
    iconset = f'{ROOT}/Sources/icontest/Assets.xcassets/AppIcon.appiconset'
    os.makedirs(iconset, exist_ok=True)

    image = Image.new('RGBA', (1024, 1024), (108, 58, 214, 255))
    draw = ImageDraw.Draw(image)
    draw.ellipse((212, 212, 812, 812), fill=(255, 255, 255, 255))
    image.save(f'{iconset}/icon-1024.png')

    with open(f'{iconset}/Contents.json', 'w', encoding='utf-8') as handle:
        json.dump(
            {
                'images': [
                    {'filename': 'icon-1024.png', 'idiom': 'universal', 'platform': 'ios', 'size': '1024x1024'}
                ],
                'info': {'author': 'xcode', 'version': 1},
            },
            handle,
            indent=2,
        )

    with open(f'{ROOT}/Sources/icontest/Assets.xcassets/Contents.json', 'w', encoding='utf-8') as handle:
        json.dump({'info': {'author': 'xcode', 'version': 1}}, handle)

    print('проект создан')
    build = sh(f'cd {ROOT} && xtool dev build 2>&1 | tail -12')
    print(build.stdout.strip())

    app = f'{ROOT}/xtool/icontest.app'
    if not os.path.isdir(app):
        print('СБОРКА НЕ ДАЛА .app')
        return 1

    print('')
    print('=== содержимое .app ===')
    for name in sorted(os.listdir(app)):
        print(' ', name)

    print('')
    print('=== Assets.car ===')
    print('  есть' if os.path.exists(f'{app}/Assets.car') else '  НЕТ')

    print('=== PNG внутри бандла ===')
    found = []
    for base, _dirs, files in os.walk(app):
        for name in files:
            if name.lower().endswith('.png') or '.car' in name:
                found.append(os.path.relpath(os.path.join(base, name), app))
    print('  ', '\n   '.join(found) if found else 'нет')

    print('')
    print('=== Info.plist: иконки ===')
    plist = sh(f'plutil -p {app}/Info.plist 2>/dev/null || python3 -c "import plistlib;d=plistlib.load(open(\'{app}/Info.plist\',\'rb\'));print({k:v for k,v in d.items() if \'Icon\' in k or \'icon\' in k})"')
    print(plist.stdout.strip()[:600])
    return 0


if __name__ == '__main__':
    sys.exit(main())
