'use strict';
/*
 * Проверки нарезки иконок.
 *
 * Главный урок: DrawImage с переменной, имя которой совпадает с параметром
 * (PowerShell не различает регистр), получал строку вместо картинки, и
 * иконки молча выходили пустыми. Поэтому проверяем не только размеры, но и
 * то, что на картинке есть содержимое.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const icon = require('../src/main/modules/icon');

/** Прочитать PNG как RGBA через PowerShell (без внешних зависимостей). */
function inspect(file) {
  const script = `
Add-Type -AssemblyName System.Drawing
$bitmap = [System.Drawing.Bitmap]::FromFile('${file.replace(/'/g, "''")}')
$colors = @{}
$step = [Math]::Max(1, [int]($bitmap.Width / 12))
for ($x = 0; $x -lt $bitmap.Width; $x += $step) {
  for ($y = 0; $y -lt $bitmap.Height; $y += $step) {
    $colors[$bitmap.GetPixel($x, $y).ToArgb()] = 1
  }
}
$sample = $bitmap.GetPixel([int]($bitmap.Width / 2), [int]($bitmap.Height / 2))
Write-Output ("size:" + $bitmap.Width + "x" + $bitmap.Height)
Write-Output ("colors:" + $colors.Count)
Write-Output ("alpha:" + $sample.A)
$bitmap.Dispose()
`;
  const { execFileSync } = require('node:child_process');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    timeout: 60000,
  });

  const result = {};
  for (const line of output.split(/\r?\n/)) {
    const [key, value] = line.split(':');
    if (key && value) result[key.trim()] = value.trim();
  }
  return {
    width: Number(result.size.split('x')[0]),
    height: Number(result.size.split('x')[1]),
    colors: Number(result.colors),
    alpha: Number(result.alpha),
  };
}

/** Создать картинку нужного размера и раскраски. */
function makeSource(file, width, height) {
  const script = `
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap(${width}, ${height})
$paint = [System.Drawing.Graphics]::FromImage($bitmap)
$paint.Clear([System.Drawing.Color]::FromArgb(255, 30, 120, 200))
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 250, 200, 40))
$paint.FillRectangle($brush, 0, 0, [int](${width} / 3), ${height})
$paint.Dispose()
$bitmap.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
`;
  const { execFileSync } = require('node:child_process');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 60000 });
}

test('иконки создаются в нужных размерах', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-icon-test-'));
  const source = path.join(dir, 'source.png');
  makeSource(source, 400, 300);

  const outDir = path.join(dir, 'out');
  const made = icon.makeIcons(source, outDir);

  assert.strictEqual(made.length, icon.SIZES.length);
  for (const item of icon.SIZES) {
    const info = inspect(path.join(outDir, item.file));
    assert.strictEqual(info.width, item.size, `${item.file}: ширина`);
    assert.strictEqual(info.height, item.size, `${item.file}: высота`);
  }
});

test('картинка не пустая: цвета не сведены к одному', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-icon-test-'));
  const source = path.join(dir, 'source.png');
  makeSource(source, 300, 300);

  const made = icon.makeIcons(source, path.join(dir, 'out'));
  const info = inspect(path.join(dir, 'out', made[made.length - 1]));

  assert.ok(info.colors > 1, `на иконке всего ${info.colors} цвет(а)`);
});

test('прозрачных иконок не остаётся', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-icon-test-'));
  const source = path.join(dir, 'source.png');

  const script = `
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap(200, 200)
$paint = [System.Drawing.Graphics]::FromImage($bitmap)
$paint.Clear([System.Drawing.Color]::Transparent)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 140, 60, 220))
$paint.FillEllipse($brush, 40, 40, 120, 120)
$paint.Dispose()
$bitmap.Save('${source.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
`;
  require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 60000 });

  const made = icon.makeIcons(source, path.join(dir, 'out'));
  const file = path.join(dir, 'out', made[made.length - 1]);
  const info = inspect(file);

  assert.strictEqual(info.alpha, 255, 'иконка должна быть непрозрачной');
  assert.ok(info.colors > 1, 'иконка не должна быть пустой');
});
