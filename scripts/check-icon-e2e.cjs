// Встраивает иконку в копию .ipa и проверяет, что она не пустая.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const icon = require('../src/main/modules/icon');

const PY = 'C:\\Users\\Frigus\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const SOURCE_IPA = process.argv[2] || 'Q:\\Downloads\\bbb\\HelloWorld\\build\\HelloWorld.ipa';
const ICON = process.argv[3] || 'D:\\FCode-work\\icon-test\\alpha.png';

(async () => {
  const work = path.join(os.tmpdir(), 'fcode-icon-e2e');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const ipa = path.join(work, 'test.ipa');
  fs.copyFileSync(SOURCE_IPA, ipa);
  console.log('копия .ipa:', ipa, `(${(fs.statSync(ipa).size / 1024).toFixed(0)} КБ)`);
  console.log('иконка    :', ICON);

  const result = await icon.applyToIpa({
    ipaPath: ipa,
    iconPath: ICON,
    onOutput: (text) => process.stdout.write(text),
  });

  console.log('\nрезультат:', JSON.stringify({ ok: result.ok, icons: result.icons.length, error: result.error }));

  const script = `
import io, json, sys, zipfile
from PIL import Image

ipa = sys.argv[1]
with zipfile.ZipFile(ipa) as archive:
    names = [n for n in archive.namelist() if '/AppIcon' in n and n.lower().endswith('.png')]
    report = []
    for name in sorted(names):
        image = Image.open(io.BytesIO(archive.read(name))).convert('RGB')
        report.append({
            'file': name.split('/')[-1],
            'size': image.size,
            'colors': len(image.getcolors(maxcolors=1000000) or []),
            'center': image.getpixel((image.size[0] // 2, image.size[1] // 2)),
        })
    print(json.dumps(report, ensure_ascii=False))
`;

  const output = execFileSync(PY, ['-c', script, ipa], { encoding: 'utf8', timeout: 60000 });
  const report = JSON.parse(output.trim());

  console.log('\n=== иконки внутри .ipa ===');
  let blank = 0;
  for (const item of report) {
    const ok = item.colors > 1;
    if (!ok) blank += 1;
    console.log(`  ${item.file.padEnd(30)} ${item.size[0]}x${item.size[1]}, цветов ${String(item.colors).padStart(6)}, центр ${JSON.stringify(item.center)}${ok ? '' : '  ПУСТАЯ'}`);
  }

  const good = report.length >= 4 && blank === 0;
  console.log(`\n${good ? 'ИКОНКИ ВСТРОЕНЫ ПРАВИЛЬНО' : 'ЕСТЬ ПУСТЫЕ ИКОНКИ'}`);
  process.exit(good ? 0 : 1);
})().catch((error) => {
  console.error('ошибка:', error.message);
  process.exit(1);
});
