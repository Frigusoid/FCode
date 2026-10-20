// Проверяет нарезку иконок: обрезку до квадрата, прозрачность, содержимое.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const icon = require('../src/main/modules/icon');

const PY = 'C:\\Users\\Frigus\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const FIXTURES = 'D:\\FCode-work\\icon-test';

function inspect(file) {
  const script = `
import json, sys
from PIL import Image
img = Image.open(sys.argv[1])
rgba = img.convert('RGBA')
alpha = rgba.getchannel('A')
rgb = rgba.convert('RGB')
print(json.dumps({
  'size': img.size,
  'mode': img.mode,
  'alpha_min': alpha.getextrema()[0],
  'bbox': alpha.getbbox(),
  'colors': len(rgb.getcolors(maxcolors=1000000) or []),
  'corner': rgb.getpixel((1, 1)),
  'center': rgb.getpixel((img.size[0] // 2, img.size[1] // 2)),
}))
`;
  const out = execFileSync(PY, ['-c', script, file], { encoding: 'utf8', timeout: 60000 });
  return JSON.parse(out.trim());
}

function main() {
  execFileSync(PY, [path.join(__dirname, 'make-icon-fixtures.py')], { stdio: 'inherit', timeout: 60000 });

  let failures = 0;

  for (const name of ['wide.png', 'alpha.png', 'tall.png']) {
    const source = path.join(FIXTURES, name);
    const outDir = path.join(os.tmpdir(), 'fcode-icon-check', name.replace('.png', ''));
    fs.rmSync(outDir, { recursive: true, force: true });

    const made = icon.makeIcons(source, outDir);
    console.log(`\n=== ${name} → ${made.length} файлов ===`);

    for (const file of made) {
      const info = inspect(path.join(outDir, file));
      const square = info.size[0] === info.size[1];
      const visible = info.alpha_min > 0 && info.bbox !== null && info.colors > 1;

      const label = [
        `${info.size[0]}x${info.size[1]}`,
        square ? 'квадрат' : 'НЕ КВАДРАТ',
        info.alpha_min === 0 ? 'с прозрачностью' : 'непрозрачная',
        `цветов ${info.colors}`,
        `центр (${info.center.join(',')})`,
      ].join(', ');

      console.log(`  ${file.padEnd(30)} ${label}`);

      if (!square) { console.log('    проблема: не квадрат'); failures += 1; }
      if (!visible) { console.log('    проблема: пустая картинка'); failures += 1; }
    }
  }

  console.log('');
  console.log(failures === 0 ? 'НАРЕЗКА В ПОРЯДКЕ' : `ПРОБЛЕМ: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
