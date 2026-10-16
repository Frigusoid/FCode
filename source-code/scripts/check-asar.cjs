// Разбор app.asar напрямую по формату. Читатель @electron/asar на Windows
// путается с разделителями путей, поэтому разбираем архив сами.
//
// Раскладка заголовка (проверено на сборке electron-builder 26.x):
//   [0]  uint32 LE  = 4               (размер внешнего pickle)
//   [4]  uint32 LE  = размер pickle
//   [8]  uint32 LE  = размер данных pickle
//   [12] uint32 LE  = длина строки JSON-оглавления
//   [16] ...        = сам JSON-заголовок
// Данные файлов лежат по смещениям, записанным в оглавлении (поле offset).
const fs = require('fs');
const path = require('path');

const asarPath = process.argv[2] || path.join(__dirname, '..', 'release', 'win-unpacked', 'resources', 'app.asar');
const buf = fs.readFileSync(asarPath);

const headerJsonSize = buf.readUInt32LE(12);
const HEADER_START = 16;
const headerJson = buf.toString('utf8', HEADER_START, HEADER_START + headerJsonSize);
const header = JSON.parse(headerJson);
// Данные начинаются сразу после оглавления, выровненного до 4 байт.
const dataStart = HEADER_START + headerJsonSize;

console.log(`asar: ${asarPath}`);
console.log(`размер: ${(buf.length / 1024 / 1024).toFixed(1)} МБ`);
console.log(`оглавление: ${headerJsonSize} б, данные с ${dataStart}\n`);

const entries = [];
(function walk(node, prefix) {
  for (const name of Object.keys(node.files || {})) {
    const entry = node.files[name];
    const full = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, full);
    else entries.push({ path: full, size: entry.size, offset: Number(entry.offset), unpacked: Boolean(entry.unpacked) });
  }
})(header, '');

console.log(`файлов внутри: ${entries.length}`);

const read = (entry) => {
  if (entry.unpacked) return fs.readFileSync(path.join(`${asarPath}.unpacked`, entry.path));
  return buf.subarray(dataStart + entry.offset, dataStart + entry.offset + entry.size);
};

let failed = false;
const wanted = ['loading.gif', 'index.html', 'main.js', 'bundle.js', 'preload.js', 'package.json'];
console.log('\nключевые файлы:');
for (const name of wanted) {
  const hits = entries.filter((e) => e.path.endsWith(name));
  if (hits.length === 0) {
    console.log(`  ${name.padEnd(14)} НЕТ`);
    failed = true;
    continue;
  }
  for (const hit of hits) {
    console.log(`  ${name.padEnd(14)} ${String(read(hit).length).padStart(9)} б   ${hit.path}`);
  }
}

// loading.gif — ключевой ресурс: должен присутствовать, быть настоящим GIF
// и совпадать побайтово с исходником в проекте.
const gif = entries.find((e) => e.path.endsWith('loading.gif'));
if (!gif) {
  console.log('\nОШИБКА: loading.gif не попал в сборку');
  process.exit(1);
}
const packed = read(gif);
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'loading.gif'));
const isGif = packed.subarray(0, 3).toString('ascii') === 'GIF';
const identical = packed.length === source.length && packed.equals(source);
console.log(`\nloading.gif: ${packed.length} б, сигнатура ${isGif ? 'GIF' : 'БИТАЯ'}`);
console.log(`совпадает с src/renderer/loading.gif: ${identical ? 'да' : 'НЕТ'}`);
if (!isGif || !identical) failed = true;

const pkgEntry = entries.find((e) => e.path === 'package.json');
if (pkgEntry) {
  const pkg = JSON.parse(read(pkgEntry).toString('utf8'));
  console.log('\npackage.json из сборки:');
  for (const key of ['name', 'productName', 'version', 'description']) {
    console.log(`  ${key.padEnd(12)} ${pkg[key]}`);
  }
  console.log(`  ${'author'.padEnd(12)} ${typeof pkg.author === 'object' ? pkg.author.name : pkg.author}`);
} else {
  console.log('\npackage.json в сборке не найден');
  failed = true;
}

console.log(failed ? '\nПРОВЕРКА НЕ ПРОЙДЕНА' : '\nПРОВЕРКА ПРОЙДЕНА');
process.exit(failed ? 1 : 0);
