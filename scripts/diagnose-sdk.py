#!/usr/bin/env python3
"""Короткий отчёт о состоянии Swift SDK.

Печатает ровно то, что нужно, чтобы понять, почему SwiftPM не находит SDK.
Запуск в терминале Ubuntu:  python3 diagnose-sdk.py
"""
import glob
import json
import os
import subprocess


def run(command):
    try:
        result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=60)
        text = (result.stdout or '') + (result.stderr or '')
        return ' '.join(text.split())
    except Exception as error:  # noqa: BLE001
        return f'<ошибка: {error}>'


sdk_dir = os.path.expanduser('~/.swiftpm/swift-sdks')
bundles = sorted(glob.glob(sdk_dir + '/*.artifactbundle'))

print('ОТЧЁТ О SWIFT SDK')
print('=' * 50)
print('swift   :', run('swift --version'))
print('xtool   :', run('xtool --version'))
print('sdk list:', run('swift sdk list'))
print('бандлов :', len(bundles))
print('')

if not bundles:
    print('НИ ОДНОГО БАНДЛА. SDK не установлен.')
    raise SystemExit(0)

for bundle in bundles:
    name = os.path.basename(bundle)
    print('БАНДЛ:', name)
    print('-' * 50)

    entries = sorted(os.listdir(bundle))
    print('файлы      :', ', '.join(entries[:12]))

    info_path = os.path.join(bundle, 'info.json')
    if os.path.exists(info_path):
        with open(info_path, encoding='utf-8') as handle:
            info = json.load(handle)
        triples = []
        for artifact in info.get('artifacts', {}).values():
            for variant in artifact.get('variants', []):
                triples.extend(variant.get('supportedTriples', []))
        print('host triples:', ', '.join(triples) or 'нет')
    else:
        print('host triples: НЕТ info.json')

    sdk_path = os.path.join(bundle, 'swift-sdk.json')
    if os.path.exists(sdk_path):
        with open(sdk_path, encoding='utf-8') as handle:
            sdk = json.load(handle)
        targets = sdk.get('targetTriples', {})
        print('цели       :', ', '.join(sorted(targets)) or 'НЕТ')
        entry = targets.get('arm64-apple-ios')
        if entry:
            root = entry.get('sdkRootPath', '')
            full = os.path.join(bundle, root)
            print('arm64-apple-ios →', root)
            print('   существует :', os.path.isdir(full))
    else:
        print('цели       : НЕТ swift-sdk.json')

    platforms = os.path.join(bundle, 'Developer', 'Platforms')
    if os.path.isdir(platforms):
        print('платформы  :', ', '.join(sorted(os.listdir(platforms))))
    else:
        print('платформы  : НЕТ папки Developer/Platforms')

    for platform in ('iPhoneOS', 'iPhoneSimulator', 'MacOSX'):
        path = os.path.join(bundle, 'Developer', 'Platforms', platform + '.platform', 'Developer', 'SDKs')
        if os.path.isdir(path):
            print(f'{platform:<10}:', ', '.join(sorted(os.listdir(path))))
        else:
            print(f'{platform:<10}: нет')

    print('')

print('=' * 50)
print('Скопируйте этот отчёт целиком.')
