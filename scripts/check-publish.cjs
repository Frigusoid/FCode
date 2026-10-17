// Проверка, что папка для GitHub самодостаточна: все локальные require
// указывают на существующие файлы, а вход Electron на месте.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
process.chdir(root);

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const problems = [];

if (!fs.existsSync(pkg.main)) problems.push(`нет входного файла: ${pkg.main}`);

const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;

    const text = fs.readFileSync(full, 'utf8');
    for (const match of text.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      const target = path.resolve(path.dirname(full), match[1]);
      const candidates = [target, `${target}.js`, `${target}.json`, path.join(target, 'index.js')];
      if (!candidates.some((candidate) => fs.existsSync(candidate))) {
        problems.push(`${path.relative(root, full)} -> ${match[1]}`);
      }
    }
  }
};

for (const dir of ['src', 'test', 'scripts']) {
  if (fs.existsSync(dir)) walk(dir);
}

// Те же имена, что перечислены в npm test.
const testDir = path.join(root, 'test');
const tests = fs.existsSync(testDir)
  ? fs.readdirSync(testDir).filter((name) => name.endsWith('.test.js'))
  : [];

console.log(`вход приложения: ${pkg.main} — ${fs.existsSync(pkg.main) ? 'есть' : 'НЕТ'}`);
console.log(`тестовых файлов: ${tests.length}`);
console.log(`битых require: ${problems.length}`);

for (const item of problems.slice(0, 15)) console.log(`  ${item}`);

// Данные, без которых сборка не соберётся.
const assets = [
  'src/renderer/index.html',
  'src/renderer/styles.css',
  'src/renderer/loading.gif',
  'src/renderer/favicon.png',
  'build/icon.ico',
  'build/icon.png',
];
const missingAssets = assets.filter((item) => !fs.existsSync(item));
if (missingAssets.length) {
  problems.push(...missingAssets.map((item) => `нет ресурса: ${item}`));
}

console.log(problems.length ? `\nПРОБЛЕМЫ: ${problems.length}` : '\nПАПКА ГОТОВА К ПУБЛИКАЦИИ');
process.exit(problems.length ? 1 : 0);
