#!/usr/bin/env python3
"""Проверить и починить бандл Swift SDK на месте.

SwiftPM ищет SDK по двум условиям:
  * triple хоста в info.json (например x86_64-pc-linux-gnu);
  * triple цели arm64-apple-ios в swift-sdk.json.

`swift sdk list` показывает только имя бандла (darwin), поэтому по нему
нельзя судить, всё ли в порядке.

Запуск: python3 fix-sdk.py
"""
import glob
import json
import os
import sys

bundle = os.path.expanduser('~/.swiftpm/swift-sdks/darwin.artifactbundle')

if not os.path.isdir(bundle):
    print('Бандл не найден:', bundle)
    print('Сначала установите SDK: xtool sdk install /путь/к/Xcode.xip')
    sys.exit(1)

changes = []
problems = []

# --- 1. info.json: triple хоста ---
import subprocess

version = subprocess.run(['swift', '--version'], capture_output=True, text=True).stdout
host = ''
for line in version.splitlines():
    if 'Target:' in line:
        host = line.split('Target:')[1].strip()
        break

print('triple системы :', host or 'не определён')

info_path = os.path.join(bundle, 'info.json')
if os.path.exists(info_path):
    with open(info_path, encoding='utf-8') as handle:
        info = json.load(handle)

    touched = False
    for artifact in info.get('artifacts', {}).values():
        for variant in artifact.get('variants', []):
            triples = variant.setdefault('supportedTriples', [])
            if host and host not in triples:
                triples.append(host)
                touched = True
                changes.append('info.json ← ' + host)

    if touched:
        with open(info_path, 'w', encoding='utf-8') as handle:
            json.dump(info, handle, indent=4)
            handle.write('\n')
else:
    problems.append('нет info.json')

# --- 2. swift-sdk.json: triple цели ---
sdk_path = os.path.join(bundle, 'swift-sdk.json')
if not os.path.exists(sdk_path):
    print('Нет swift-sdk.json — бандл собран неправильно.')
    sys.exit(2)

with open(sdk_path, encoding='utf-8') as handle:
    sdk = json.load(handle)

targets = sdk.setdefault('targetTriples', {})
print('цели в бандле :', ', '.join(sorted(targets)) or 'нет')

want = 'arm64-apple-ios'
if want not in targets:
    roots = sorted(glob.glob(os.path.join(
        bundle, 'Developer/Platforms/iPhoneOS.platform/Developer/SDKs/*.sdk')))

    if roots:
        usr = 'Developer/Platforms/iPhoneOS.platform/Developer/usr'
        sim = targets.get('arm64-apple-ios-simulator', {})
        targets[want] = {
            'sdkRootPath': os.path.relpath(roots[0], bundle),
            'swiftStaticResourcesPath': sim.get(
                'swiftStaticResourcesPath',
                'Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift_static'),
            'includeSearchPaths': [usr + '/lib'],
            'librarySearchPaths': [usr + '/lib'],
            'swiftResourcesPath': sim.get(
                'swiftResourcesPath',
                'Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift'),
            'toolsetPaths': ['toolset.json'],
        }
        changes.append('swift-sdk.json ← ' + want)
        print('найден SDK  :', os.path.relpath(roots[0], bundle))
    else:
        problems.append('в бандле нет iPhoneOS.platform')

    with open(sdk_path, 'w', encoding='utf-8') as handle:
        json.dump(sdk, handle)
        handle.write('\n')

# --- итог ---
print('')
if changes:
    print('Исправлено:')
    for item in changes:
        print('  ', item)
else:
    print('Всё уже на месте, менять нечего.')

if problems:
    print('')
    print('Не удалось исправить:')
    for item in problems:
        print('  ', item)
    print('')
    print('Бандл собран неполно. Переустановите SDK:')
    print('  xtool sdk install /путь/к/Xcode.xip')
    sys.exit(3)

print('')
print('Готово. Запускайте сборку.')
