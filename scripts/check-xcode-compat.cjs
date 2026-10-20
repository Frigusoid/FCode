// Отчёт о совместимости: оригинальный проект Xcode против сконвертированного.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const xcode = require('../src/main/modules/xcode');

const ORIGINAL = process.argv[2] || 'Q:\\Downloads\\Pocket-Poster-main1\\Pocket-Poster-main';
const CONVERTED = process.argv[3] || 'D:\\FCode-work\\pp-converted';

function sh(script) {
  return execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'frigus', '--', 'bash', '-lc', script], {
    encoding: 'utf8',
    env: { ...process.env, WSL_UTF8: '1' },
    timeout: 180000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function countFiles(dir, extensions) {
  let count = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'Vendor') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) count += 1;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return count;
}

/** Структурная проверка pbxproj: скобки, ссылки, кавычки. */
function lintPbxproj(file) {
  const text = fs.readFileSync(file, 'utf8');
  const problems = [];

  const open = (text.match(/\{/g) || []).length;
  const close = (text.match(/\}/g) || []).length;
  if (open !== close) problems.push(`скобки не сходятся: { ${open} } ${close}`);

  const parenOpen = (text.match(/\(/g) || []).length;
  const parenClose = (text.match(/\)/g) || []).length;
  if (parenOpen !== parenClose) problems.push(`круглые скобки: ( ${parenOpen} ) ${parenClose}`);

  const quotes = (text.match(/"/g) || []).length;
  if (quotes % 2 !== 0) problems.push(`непарные кавычки: ${quotes}`);

  // Все идентификаторы, на которые ссылаются, должны быть объявлены.
  const declared = new Set([...text.matchAll(/^\t\t([0-9A-F]{24}) /gm)].map((m) => m[1]));
  const referenced = new Set([...text.matchAll(/([0-9A-F]{24}) \/\*/g)].map((m) => m[1]));
  for (const id of referenced) {
    if (!declared.has(id)) problems.push(`ссылка на несуществующий объект ${id}`);
  }

  if (!/rootObject = [0-9A-F]{24}/.test(text)) problems.push('нет rootObject');

  return { problems, objects: declared.size };
}

console.log('=== оригинал ===');
const original = xcode.analyzeProject(ORIGINAL);
console.log(`  проект    : ${original.projectName}`);
console.log(`  цель      : ${original.target?.name} (${original.target?.kind})`);
console.log(`  bundleId  : ${original.build.bundleId}`);
console.log(`  iOS       : ${original.build.deploymentTarget}`);
console.log(`  swift     : ${original.sources.length} файлов`);
console.log(`  ресурсы   : ${original.resources.length}: ${original.resources.map((r) => path.basename(r)).join(', ')}`);
console.log(`  пакеты    : ${original.packages.length}`);

console.log('');
console.log('=== после конвертации ===');
const converted = xcode.analyzeProject(CONVERTED);
console.log(`  проект    : ${converted.projectName}`);
console.log(`  цель      : ${converted.target?.name} (${converted.target?.kind})`);
console.log(`  bundleId  : ${converted.build.bundleId}`);
console.log(`  iOS       : ${converted.build.deploymentTarget}`);
console.log(`  swift     : ${countFiles(path.join(CONVERTED, 'Sources'), ['.swift'])} файлов`);
console.log(`  ресурсы   : ${countFiles(path.join(CONVERTED, 'Sources'), ['.xcassets', '.xcstrings', '.json', '.plist'])} файлов`);

console.log('');
console.log('=== проверка сгенерированного .xcodeproj ===');
const pbxprojFile = path.join(CONVERTED, 'Pocket_Poster.xcodeproj', 'project.pbxproj');
const lint = lintPbxproj(pbxprojFile);
console.log(`  объектов  : ${lint.objects}`);
console.log(`  проблемы  : ${lint.problems.length ? lint.problems.join('; ') : 'нет'}`);

const pbxproj = fs.readFileSync(pbxprojFile, 'utf8');
console.log(`  Info.plist: ${/INFOPLIST_FILE = Info\.plist;/.test(pbxproj) ? 'подключён' : 'синтезируется'}`);

console.log('');
console.log('=== что сохранилось, что нет ===');

const originalPlist = path.join(ORIGINAL, 'Pocket-Poster-Info.plist');
const originalKeys = fs.existsSync(originalPlist)
  ? [...fs.readFileSync(originalPlist, 'utf8').matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])
  : [];
const convertedPlist = path.join(CONVERTED, 'Info.plist');
const convertedKeys = fs.existsSync(convertedPlist)
  ? [...fs.readFileSync(convertedPlist, 'utf8').matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])
  : [];

console.log(`  ключей Info.plist: было ${originalKeys.length}, стало ${convertedKeys.length}`);
const lost = originalKeys.filter((key) => !convertedKeys.includes(key));
console.log(`  потеряно ключей  : ${lost.length ? lost.join(', ') : 'ничего'}`);

console.log(`  Swift-файлов     : было ${original.sources.length}, стало ${countFiles(path.join(CONVERTED, 'Sources'), ['.swift'])}`);
console.log(`  Пакеты SwiftPM   : ${converted.packages.length} объявлено`);
