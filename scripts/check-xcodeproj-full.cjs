// Проверяет сгенерированный .xcodeproj у сконвертированного проекта.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.argv[2] || 'D:\\FCode-work\\pp-converted';
const projectFile = path.join(ROOT, 'Pocket_Poster.xcodeproj', 'project.pbxproj');

if (!fs.existsSync(projectFile)) {
  console.error('нет project.pbxproj:', projectFile);
  process.exit(1);
}

const text = fs.readFileSync(projectFile, 'utf8');

const checks = {
  'packageReferences': /packageReferences = \(/.test(text),
  'внешний пакет Dynamic': /repositoryURL = "[^"]*Dynamic/.test(text),
  'продукт Dynamic': /productName = Dynamic;/.test(text),
  'группа Vendor': /path = Vendor\/CachedAsyncImage;/.test(text),
  'Info.plist подключён': /INFOPLIST_FILE = Info\.plist;/.test(text),
  'синхронизированные группы': /fileSystemSynchronizedGroups/.test(text),
  'тип цель = приложение': /com\.apple\.product-type\.application/.test(text),
};

for (const [label, ok] of Object.entries(checks)) {
  console.log(`  ${label.padEnd(28)} ${ok ? 'есть' : 'НЕТ'}`);
}

const opens = (text.match(/\{/g) || []).length;
const closes = (text.match(/\}/g) || []).length;
const quotes = (text.match(/"/g) || []).length;

console.log('');
console.log(`  скобки { } : ${opens} / ${closes} ${opens === closes ? 'ок' : 'НЕ СХОДЯТСЯ'}`);
console.log(`  кавычки    : ${quotes} ${quotes % 2 === 0 ? 'ок' : 'НЕПАРНЫЕ'}`);

// Каждый идентификатор в ссылке должен быть объявлен.
const declared = new Set([...text.matchAll(/^\t\t([0-9A-F]{24}) /gm)].map((m) => m[1]));
const referenced = new Set([...text.matchAll(/([0-9A-F]{24})(?: \/\*)?[,)]/g)].map((m) => m[1]));
const dangling = [...referenced].filter((id) => !declared.has(id));

console.log(`  объектов   : ${declared.size}`);
console.log(`  битых ссылок: ${dangling.length ? dangling.join(', ') : 'нет'}`);

const ok = Object.values(checks).every(Boolean) && opens === closes && quotes % 2 === 0 && dangling.length === 0;
console.log(`\n${ok ? 'ПРОЕКТ ГОТОВ ДЛЯ XCODE' : 'ЕСТЬ ПРОБЛЕМЫ'}`);
process.exit(ok ? 0 : 1);
