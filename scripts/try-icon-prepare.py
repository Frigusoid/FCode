"""Готовит тестовый проект с иконкой на диске Windows.

Сборку запускает отдельный шаг в WSL: см. scripts/try-icon-build.ps1
"""
import json
import os
import sys

from PIL import Image, ImageDraw

ROOT = r'D:\FCode-work\icontest'


def main():
    if os.path.isdir(ROOT):
        import shutil
        shutil.rmtree(ROOT)

    os.makedirs(os.path.join(ROOT, 'Sources', 'icontest'), exist_ok=True)

    with open(os.path.join(ROOT, 'Package.swift'), 'w', encoding='utf-8') as handle:
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

    with open(os.path.join(ROOT, 'xtool.yml'), 'w', encoding='utf-8') as handle:
        handle.write('version: 1\nbundleID: com.example.icontest\n')

    with open(os.path.join(ROOT, 'Sources', 'icontest', 'App.swift'), 'w', encoding='utf-8') as handle:
        handle.write(
            'import SwiftUI\n\n'
            '@main\n'
            'struct IconTestApp: App {\n'
            '    var body: some Scene { WindowGroup { Text("icon") } }\n'
            '}\n'
        )

    iconset = os.path.join(ROOT, 'Sources', 'icontest', 'Assets.xcassets', 'AppIcon.appiconset')
    os.makedirs(iconset, exist_ok=True)

    image = Image.new('RGBA', (1024, 1024), (108, 58, 214, 255))
    draw = ImageDraw.Draw(image)
    draw.ellipse((212, 212, 812, 812), fill=(255, 255, 255, 255))
    image.save(os.path.join(iconset, 'icon-1024.png'))

    with open(os.path.join(iconset, 'Contents.json'), 'w', encoding='utf-8') as handle:
        json.dump(
            {
                'images': [
                    {
                        'filename': 'icon-1024.png',
                        'idiom': 'universal',
                        'platform': 'ios',
                        'size': '1024x1024',
                    }
                ],
                'info': {'author': 'xcode', 'version': 1},
            },
            handle,
            indent=2,
        )

    with open(os.path.join(ROOT, 'Sources', 'icontest', 'Assets.xcassets', 'Contents.json'), 'w', encoding='utf-8') as handle:
        json.dump({'info': {'author': 'xcode', 'version': 1}}, handle)

    print('проект готов:', ROOT)
    return 0


if __name__ == '__main__':
    sys.exit(main())
