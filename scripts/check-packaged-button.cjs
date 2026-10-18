// Ищет строку в собранном bundle.js внутри установленного app.asar.
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || 'dist';
const asarPath = path.join(__dirname, '..', root, 'win-unpacked', 'resources', 'app.asar');

if (!fs.existsSync(asarPath)) {
  console.log('app.asar не найден:', asarPath);
  console.log('значит dist\\win-unpacked занят или не пересобран');
  process.exit(1);
}

const buf = fs.readFileSync(asarPath);
const headerSize = buf.readUInt32LE(12);
const headerStart = 16;
const header = JSON.parse(buf.toString('utf8', headerStart, headerStart + headerSize));
const dataStart = headerStart + headerSize;

const walk = (node, prefix, out) => {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, full, out);
    else out.push({ path: full, offset: Number(entry.offset), size: entry.size });
  }
};

const entries = [];
walk(header, '', entries);

const bundle = entries.find((e) => e.path.endsWith('bundle.js'));
if (!bundle) {
  console.log('bundle.js в архиве не найден');
  process.exit(1);
}

const text = buf.toString('utf8', dataStart + bundle.offset, dataStart + bundle.offset + bundle.size);

const checks = [
  ['кнопка в панели iOS SDK', 'step.id === "ios-sdk"'],
  ['вызов починки', 'handleFixSdkHost'],
  ['подпись кнопки', 'Fix iOS SDK'],
];

let failed = false;
console.log(`bundle.js: ${bundle.size} байт`);
for (const [label, needle] of checks) {
  const found = text.includes(needle);
  console.log(`  ${label.padEnd(28)} ${found ? 'есть' : 'НЕТ'}`);
  if (!found) failed = true;
}

process.exit(failed ? 1 : 0);
