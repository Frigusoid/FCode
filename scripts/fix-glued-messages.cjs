// Разлепляет строки словаря, в которых оказалось два ключа подряд.
const fs = require('node:fs');

const FILE = 'D:\\FCode\\src\\shared\\messages.js';
const lines = fs.readFileSync(FILE, 'utf8').split('\n');

const fixed = [];
let repaired = 0;

for (const line of lines) {
  // Признак склейки: два «ключ:» в одной строке.
  const matches = [...line.matchAll(/'([^']+)':\s*/g)];
  if (matches.length < 2) {
    fixed.push(line);
    continue;
  }

  // Режем по началу второго ключа, сохраняя отступ первой строки.
  const indent = /^\s*/.exec(line)[0];
  const cut = line.indexOf(`'${matches[1][1]}':`);
  const first = line.slice(0, cut).replace(/\s+$/, '');
  const second = indent + line.slice(cut).replace(/^\s+/, '');
  fixed.push(first, second);
  repaired += 1;
}

fs.writeFileSync(FILE, fixed.join('\n'), 'utf8');
console.log('разлеплено строк:', repaired);
console.log('было строк:', lines.length, 'стало:', fixed.length);
