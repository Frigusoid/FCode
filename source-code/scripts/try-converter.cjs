// Прогон конвертера на настоящем проекте Pocket Poster.
// Запуск: node scripts/try-converter.cjs "Q:\Downloads\Pocket-Poster-main"
const path = require('path');
const fs = require('fs');
const converter = require('../src/main/modules/converter');

const projectPath = process.argv[2] || 'Q:\\Downloads\\Pocket-Poster-main';
const outputDir = process.argv[3] || 'D:\\FCode\\tmp-real-convert';

if (!fs.existsSync(projectPath)) {
  console.error(`проект не найден: ${projectPath}`);
  process.exit(1);
}

console.log(`проект: ${projectPath}`);
console.log(`вывод:  ${outputDir}\n`);

const started = Date.now();
const result = converter.convert(projectPath, { outputDir, overwrite: true });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`модуль:      ${result.moduleName}`);
console.log(`bundleID:    ${result.bundleId}`);
console.log(`вложенные:   ${result.nestedPackages.join(', ') || 'нет'}`);
console.log(`за ${seconds} с\n`);

console.log('заметки:');
for (const note of result.notes) console.log(`  · ${note}`);

console.log('\nманифест:');
console.log(result.manifest.split('\n').map((l) => `  ${l}`).join('\n'));

console.log('\nструктура результата:');
const walk = (dir, prefix = '') => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).slice(0, 12)) {
    if (entry.isDirectory()) {
      const count = fs.readdirSync(path.join(dir, entry.name)).length;
      console.log(`  ${prefix}${entry.name}/ (${count})`);
      if (prefix.length < 4) walk(path.join(dir, entry.name), `${prefix}  `);
    } else {
      console.log(`  ${prefix}${entry.name}`);
    }
  }
};
walk(outputDir);
