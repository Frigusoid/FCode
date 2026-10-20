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
 * Скрипт PowerShell: обрезать картинку до квадрата и сделать нужные размеры.
 *
 * Про имена: параметр нельзя называть `$Source`, если внутри есть переменная
 * `$source` — PowerShell не различает регистр букв, и в DrawImage уходила
 * строка с путём вместо картинки. Именно поэтому иконки получались пустыми.
 *
 * Обрезка: берём квадрат по центру — как object-fit: cover в предпросмотре.
 * Прозрачные места заливаем белым: iOS не любит иконки с альфа-каналом.
 */
const RESIZE_SCRIPT = `param(
  [string]$ImagePath,
  [string]$OutDir
)

Add-Type -AssemblyName System.Drawing

$sizes = [ordered]@{
  'AppIcon60x60@2x.png'          = 120
  'AppIcon60x60@3x.png'          = 180
  'AppIcon76x76@2x~ipad.png'     = 152
  'AppIcon83.5x83.5@2x~ipad.png' = 167
  'AppIcon1024.png'              = 1024
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$picture = [System.Drawing.Image]::FromFile($ImagePath)

# Квадрат по центру: лишнее по длинной стороне отрезается.
$cropSide = [Math]::Min($picture.Width, $picture.Height)
$cropX = [int](($picture.Width - $cropSide) / 2)
$cropY = [int](($picture.Height - $cropSide) / 2)
$cropRect = New-Object System.Drawing.Rectangle($cropX, $cropY, $cropSide, $cropSide)

Write-Output ("источник " + $picture.Width + "x" + $picture.Height + " -> квадрат " + $cropSide + "x" + $cropSide)

foreach ($name in $sizes.Keys) {
  $target = $sizes[$name]

  $canvas = New-Object System.Drawing.Bitmap($target, $target)
  $paint = [System.Drawing.Graphics]::FromImage($canvas)
  $paint.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $paint.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $paint.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $paint.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

  # Белая подложка вместо прозрачности.
  $paint.Clear([System.Drawing.Color]::White)
  $destRect = New-Object System.Drawing.Rectangle(0, 0, $target, $target)
  $paint.DrawImage($picture, $destRect, $cropRect, [System.Drawing.GraphicsUnit]::Pixel)
  $paint.Dispose()

  $canvas.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)

  # Одноцветный квадрат бесполезен — сообщаем, чтобы не встраивать пустоту.
  $colors = @{}
  $step = [Math]::Max(1, [int]($target / 16))
  for ($x = 0; $x -lt $target; $x += $step) {
    for ($y = 0; $y -lt $target; $y += $step) {
      $colors[$canvas.GetPixel($x, $y).ToArgb()] = 1
    }
  }
  Write-Output ("размер " + $target + ": цветов " + $colors.Count)

  $canvas.Dispose()
}

$picture.Dispose()
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

# Пересобираем архив: старые записи + иконки + новый Info.plist.
# Записи, которые заменяем, выбрасываем: иначе в архиве окажутся две копии
# с одним именем, и какая из них попадёт в приложение — неизвестно.
replaced = {info_name} | {payload + name for name in icon_files}

tmp_ipa = os.path.join(work, 'patched.ipa')
with zipfile.ZipFile(ipa_path) as source, zipfile.ZipFile(tmp_ipa, 'w', zipfile.ZIP_DEFLATED) as target:
    for item in source.infolist():
        if item.filename in replaced:
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
  // Windows PowerShell 5.1 читает .ps1 без BOM как ANSI и ломает кириллицу,
  // поэтому ставим BOM и пишем в UTF-8.
  fs.writeFileSync(scriptPath, `\uFEFF${RESIZE_SCRIPT}`, 'utf8');

  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, sourcePath, outDir],
    { stdio: 'pipe', timeout: 60000, windowsHide: true },
  ).toString();

  const made = SIZES.filter((item) => fs.existsSync(path.join(outDir, item.file)));
  if (!made.length) {
    throw new Error('картинка не обработалась: файлы иконок не создались');
  }

  // Скрипт печатает число цветов в каждом размере. Если везде один цвет,
  // значит нарисовалось пустое поле — такую иконку встраивать нельзя.
  const counts = [...output.matchAll(/цветов\s+(\d+)/g)].map((match) => Number(match[1]));
  if (counts.length && counts.every((count) => count <= 1)) {
    throw new Error('картинка однотонная: получится пустая иконка');
  }

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
