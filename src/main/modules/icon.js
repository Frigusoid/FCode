'use strict';
/*
 * Иконка приложения для собранного .ipa.
 *
 * xtool не умеет иконки: каталог Assets.xcassets он кладёт в resource-бандл
 * как есть, не компилируя в Assets.car, и в Info.plist не появляется ни
 * CFBundleIcons, ни CFBundleIconFiles. Проверено сборкой: PNG остаётся внутри
 * icontest_icontest.bundle, Assets.car нет, иконка на устройстве не появляется.
 *
 * Поэтому иконку встраиваем сами, уже после сборки:
 *   1. из выбранной картинки делаем нужные размеры (PowerShell, System.Drawing);
 *   2. кладём PNG в корень Payload/<App>.app;
 *   3. дописываем в Info.plist CFBundleIcons с именами этих файлов.
 *
 * Такой способ (иконки отдельными файлами, без Assets.car) iOS понимает до сих
 * пор: именно так собирались приложения до каталогов ресурсов.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const wslExec = require('./wsl-exec');

/** Размеры, которые реально использует iOS на iPhone и iPad. */
const SIZES = [
  { file: 'AppIcon60x60@2x.png', size: 120 },
  { file: 'AppIcon60x60@3x.png', size: 180 },
  { file: 'AppIcon76x76@2x~ipad.png', size: 152 },
  { file: 'AppIcon83.5x83.5@2x~ipad.png', size: 167 },
  { file: 'AppIcon1024.png', size: 1024 },
];

/** Имена без расширения — их перечисляем в Info.plist. */
const ICON_NAMES = ['AppIcon60x60', 'AppIcon76x76', 'AppIcon83.5x83.5', 'AppIcon1024'];

/**
 * Скрипт PowerShell: уменьшить картинку до нужных размеров.
 *
 * Параметры передаём позиционно, сам текст — только ASCII, иначе Windows
 * PowerShell читает файл в системной кодировке и ломает кириллицу.
 */
const RESIZE_SCRIPT = `param(
  [string]$Source,
  [string]$OutDir
)

Add-Type -AssemblyName System.Drawing

$sizes = @{
  'AppIcon60x60@2x.png'      = 120
  'AppIcon60x60@3x.png'      = 180
  'AppIcon76x76@2x~ipad.png' = 152
  'AppIcon83.5x83.5@2x~ipad.png' = 167
  'AppIcon1024.png'          = 1024
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$source = [System.Drawing.Image]::FromFile($Source)

foreach ($name in $sizes.Keys) {
  $side = $sizes[$name]
  $bitmap = New-Object System.Drawing.Bitmap($side, $side)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.DrawImage($source, 0, 0, $side, $side)
  $graphics.Dispose()
  $bitmap.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

$source.Dispose()
Write-Output ("made " + $sizes.Count)
`;

/**
 * Скрипт внутри Linux: положить иконки в .app и дописать Info.plist.
 *
 * plistlib и zipfile есть в стандартной поставке python3, поэтому ничего
 * доустанавливать не нужно.
 */
const PATCH_SCRIPT = `
set -e

python3 - "$IPA" "$ICONS" <<'PY'
import os
import plistlib
import shutil
import sys
import tempfile
import zipfile

ipa_path, icons_dir = sys.argv[1], sys.argv[2]

with zipfile.ZipFile(ipa_path) as archive:
    names = archive.namelist()

# Ищем единственное приложение внутри Payload.
apps = sorted({name.split('/')[1] for name in names if name.startswith('Payload/') and name.count('/') >= 2})
if not apps:
    print('NO_APP_IN_PAYLOAD')
    sys.exit(3)
app = apps[0]
payload = 'Payload/' + app + '/'
print('app=' + app)

info_name = payload + 'Info.plist'

work = tempfile.mkdtemp(prefix='fcode-icon-')
icon_files = sorted(os.listdir(icons_dir))

# Готовим новый Info.plist.
with zipfile.ZipFile(ipa_path) as archive:
    info = plistlib.loads(archive.read(info_name))

icons = [
    'AppIcon60x60', 'AppIcon76x76', 'AppIcon83.5x83.5', 'AppIcon1024',
]

primary = {'CFBundleIconFiles': icons, 'CFBundleIconName': 'AppIcon'}
info['CFBundleIcons'] = {'CFBundlePrimaryIcon': primary}
info['CFBundleIcons~ipad'] = {'CFBundlePrimaryIcon': primary}
# Плоский список нужен старым версиям iOS.
info['CFBundleIconFiles'] = icons

new_info_path = os.path.join(work, 'Info.plist')
with open(new_info_path, 'wb') as handle:
    plistlib.dump(info, handle, fmt=plistlib.FMT_BINARY)

# Пересобираем архив: все старые записи + иконки + новый Info.plist.
tmp_ipa = os.path.join(work, 'patched.ipa')
with zipfile.ZipFile(ipa_path) as source, zipfile.ZipFile(tmp_ipa, 'w', zipfile.ZIP_DEFLATED) as target:
    for item in source.infolist():
        if item.filename == info_name:
            continue
        target.writestr(item, source.read(item.filename))

    for name in icon_files:
        target.write(os.path.join(icons_dir, name), payload + name)

    target.write(new_info_path, info_name)

shutil.move(tmp_ipa, ipa_path)
shutil.rmtree(work, ignore_errors=True)
print('ok')
PY
`;

/** Сделать PNG нужных размеров на Windows. */
function makeIcons(sourcePath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const scriptPath = path.join(outDir, '..', 'resize-icons.ps1');
  fs.writeFileSync(scriptPath, RESIZE_SCRIPT, 'ascii');

  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, sourcePath, outDir],
    { stdio: 'pipe', timeout: 60000, windowsHide: true },
  );

  const made = SIZES.filter((item) => fs.existsSync(path.join(outDir, item.file)));
  return made.map((item) => item.file);
}

/** Путь Windows -> путь внутри Linux. */
function toWslPath(windowsPath) {
  const resolved = path.resolve(windowsPath);
  const match = /^([A-Za-z]):\\(.*)$/.exec(resolved);
  if (!match) return resolved.replace(/\\/g, '/');
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

/**
 * Встроить иконку в готовый .ipa.
 *
 * @param {{ipaPath: string, iconPath: string, distro?: string, onOutput?: Function}} options
 * @returns {Promise<{ok: boolean, icons: string[], error?: string}>}
 */
async function applyToIpa(options) {
  const { ipaPath, iconPath } = options;
  const onOutput = options.onOutput || (() => {});

  if (!ipaPath || !fs.existsSync(ipaPath)) {
    return { ok: false, icons: [], error: 'нет собранного .ipa' };
  }
  if (!iconPath || !fs.existsSync(iconPath)) {
    return { ok: false, icons: [], error: 'файл иконки не найден' };
  }

  const workDir = path.join(os.tmpdir(), 'fcode-icon-out');
  fs.rmSync(workDir, { recursive: true, force: true });

  let made = [];
  try {
    made = makeIcons(iconPath, workDir);
  } catch (error) {
    return { ok: false, icons: [], error: `не удалось уменьшить картинку: ${error.message}` };
  }

  if (!made.length) {
    return { ok: false, icons: [], error: 'иконки не создались' };
  }

  onOutput(`иконка: подготовлено файлов ${made.length}\n`);

  const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
  const script = `set -e
IPA=${quote(toWslPath(ipaPath))}
ICONS=${quote(toWslPath(workDir))}
${PATCH_SCRIPT}`;

  const result = await wslExec.run({
    // Дистрибутив по умолчанию: без него wsl.exe получает «-d undefined»
    // и отвечает WSL_E_DISTRO_NOT_FOUND.
    distro: options.distro || 'Ubuntu',
    user: null,
    script,
    onOutput: (text) => onOutput(text),
  });

  for (const line of String(result.output || '').split(/\r?\n/)) {
    if (line.trim()) onOutput(`  ${line.trim()}\n`);
  }

  if (!result.ok || /NO_APP_IN_PAYLOAD/.test(result.output || '')) {
    return { ok: false, icons: made, error: 'не удалось встроить иконку в .ipa' };
  }

  return { ok: true, icons: made };
}

module.exports = { applyToIpa, makeIcons, SIZES, ICON_NAMES };
