// Проверка иконки: нарезка размеров и встраивание в .ipa.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const icon = require('../src/main/modules/icon');

const SOURCE = 'D:\\FCode-work\\icontest\\Sources\\icontest\\Assets.xcassets\\AppIcon.appiconset\\icon-1024.png';

function sh(script) {
  return execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'frigus', '--', 'bash', '-lc', script], {
    encoding: 'utf8',
    env: { ...process.env, WSL_UTF8: '1' },
    timeout: 180000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

(async () => {
  if (!fs.existsSync(SOURCE)) {
    console.log('нет исходной картинки:', SOURCE);
    process.exit(1);
  }

  // 1. Нарезка размеров
  const outDir = path.join(os.tmpdir(), 'fcode-icon-test');
  fs.rmSync(outDir, { recursive: true, force: true });
  const made = icon.makeIcons(SOURCE, outDir);
  console.log('нарезано файлов:', made.length);
  for (const name of made) {
    const size = fs.statSync(path.join(outDir, name)).size;
    console.log(`  ${name.padEnd(32)} ${size} байт`);
  }

  // 2. Собираем проект и встраиваем иконку
  const project = 'D:\\FCode-work\\icontest';
  console.log('\nсобираю проект...');
  const build = sh(`cd /tmp/icontest 2>/dev/null && xtool dev build --ipa 2>&1 | tail -3 || echo "нет /tmp/icontest"`);
  console.log(build.trim());

  // Ищем .ipa
  const ipa = sh(`find /tmp/icontest -name '*.ipa' -printf '%T@ %p\\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-`).trim();
  console.log('ipa:', ipa || 'не найден');
  if (!ipa) {
    console.log('\nНужно собрать проект заранее — пропускаю проверку встраивания.');
    process.exit(0);
  }

  // Копируем в Windows-путь и проверяем через FCode
  const winIpa = 'D:\\FCode-work\\icontest\\icontest.ipa';
  sh(`cp ${ipa} /mnt/d/FCode-work/icontest/icontest.ipa`);

  const result = await icon.applyToIpa({
    ipaPath: winIpa,
    iconPath: SOURCE,
    onOutput: (text) => process.stdout.write(text),
  });

  console.log('\nрезультат встраивания:', JSON.stringify({ ok: result.ok, icons: result.icons.length, error: result.error }));

  // 3. Проверяем содержимое архива независимо: python zipfile + plistlib
  const check = sh(`python3 - <<'PY'
import plistlib, zipfile
z = zipfile.ZipFile('/mnt/d/FCode-work/icontest/icontest.ipa')
names = z.namelist()
pngs = sorted(n for n in names if n.lower().endswith('.png'))
info = [n for n in names if n.endswith('Info.plist')]
print('PNG в архиве:', len(pngs))
for p in pngs[:8]:
    print('  ', p)
if info:
    d = plistlib.loads(z.read(info[0]))
    icons = d.get('CFBundleIcons') or {}
    primary = icons.get('CFBundlePrimaryIcon') or {}
    print('CFBundleIcons:', bool(icons))
    print('CFBundleIconFiles:', primary.get('CFBundleIconFiles'))
    print('CFBundleIconName:', primary.get('CFBundleIconName'))
else:
    print('Info.plist не найден')
PY`);
  console.log(check);
})().catch((error) => {
  console.error('ошибка:', error.message);
  process.exit(1);
});
