'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');

/** Пиктографические эмодзи — именно они заменены на PNG-иконки. */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{1F900}-\u{1F9FF}]/u;

function collectFiles(dir, extensions, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, extensions, acc);
    else if (extensions.includes(path.extname(entry.name))) acc.push(full);
  }
  return acc;
}

test('эмодзи встречаются только как запасные символы иконок', () => {
  const files = collectFiles(RENDERER, ['.html', '.css', '.js']);
  const offenders = [];

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((line, index) => {
      if (!EMOJI.test(line)) return;
      // Разрешено: значение data-fallback в разметке и запись fallback в наборе иконок.
      const allowed =
        /data-fallback="[^"]*[\u{1F000}-\u{1FAFF}][^"]*"/u.test(line) ||
        /fallback:\s*'[^']*[\u{1F000}-\u{1FAFF}][^']*'/u.test(line) ||
        /^\s*\*/.test(line);
      if (!allowed) {
        offenders.push(`${path.relative(ROOT, file)}:${index + 1} — ${line.trim().slice(0, 80)}`);
      }
    });
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `эмодзи вне запасных символов:\n${offenders.join('\n')}`,
  );
});

test('каждая иконка в разметке описана в наборе иконок', () => {
  const iconsSource = fs.readFileSync(path.join(RENDERER, 'src', 'icons.js'), 'utf8');
  const defined = new Set(
    [...iconsSource.matchAll(/^\s{2}'?([a-zA-Z][a-zA-Z-]*)'?:\s*\{\s*fallback:/gm)].map(
      (match) => match[1],
    ),
  );

  assert.ok(defined.size > 25, `набор иконок подозрительно мал: ${defined.size}`);
  assert.ok(defined.has('open'));
  assert.ok(defined.has('file-swift'));

  const sources = [
    path.join(RENDERER, 'index.html'),
    path.join(RENDERER, 'src', 'index.js'),
  ].map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));

  const unknown = [];
  for (const { file, text } of sources) {
    for (const match of text.matchAll(/data-icon="([^"]+)"/g)) {
      // В шаблонных строках стоит ${name} — это не имя иконки.
      if (match[1].includes('${')) continue;
      if (!defined.has(match[1])) {
        unknown.push(`${path.relative(ROOT, file)} — ${match[1]}`);
      }
    }
  }

  assert.deepStrictEqual(unknown, [], `иконки без описания: ${unknown.join(', ')}`);
});

test('у каждой иконки есть текстовый запасной вариант', () => {
  const iconsSource = fs.readFileSync(path.join(RENDERER, 'src', 'icons.js'), 'utf8');

  const entries = [
    ...iconsSource.matchAll(/^\s{2}'?([a-zA-Z][a-zA-Z-]*)'?:\s*\{\s*fallback:\s*'([^']*)'/gm),
  ];

  assert.ok(entries.length > 25);
  for (const [, name, fallback] of entries) {
    assert.ok(fallback.length > 0, `у иконки ${name} пустой запасной символ`);
  }
});

test('в разметке у каждой иконки указан запасной символ', () => {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const missing = [];

  for (const match of html.matchAll(/<span class="ico"([^>]*)>/g)) {
    if (!/data-fallback="[^"]+"/.test(match[1])) missing.push(match[0]);
  }

  assert.deepStrictEqual(missing, [], `без запасного символа: ${missing.join(', ')}`);
});

test('список нужных PNG описан в документации иконок', () => {
  const readme = fs.readFileSync(path.join(RENDERER, 'icons', 'README.md'), 'utf8');
  const iconsSource = fs.readFileSync(path.join(RENDERER, 'src', 'icons.js'), 'utf8');

  const names = [
    ...iconsSource.matchAll(/^\s{2}'?([a-zA-Z][a-zA-Z-]*)'?:\s*\{\s*fallback:/gm),
  ].map((match) => match[1]);

  const notDocumented = names.filter((name) => !readme.includes(`\`${name}.png\``));
  assert.deepStrictEqual(
    notDocumented,
    [],
    `в icons/README.md не описаны: ${notDocumented.join(', ')}`,
  );
});
