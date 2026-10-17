'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'src', 'renderer', 'index.html');

/**
 * Перевод подставляет textContent, а значит стирает всё вложенное.
 * Если у элемента с data-i18n есть дочерние элементы, они исчезнут при первой
 * же смене языка. Именно так пропадал значок с числом проблем.
 *
 * Проверяем: содержимое каждого элемента с data-i18n не должно содержать тегов.
 */
test('у элементов с data-i18n нет вложенных элементов', () => {
  const html = fs.readFileSync(HTML, 'utf8');
  const offenders = [];

  // Ищем открывающий тег с data-i18n и смотрим, что идёт до закрывающего.
  const pattern = /<([a-zA-Z][\w-]*)([^>]*\sdata-i18n="[^"]+"[^>]*)>([\s\S]*?)<\/\1>/g;

  for (const match of html.matchAll(pattern)) {
    const [, tag, , content] = match;
    // data-i18n-html и data-i18n-title сюда не попадают: у первого подстановка
    // HTML разрешена, второй вообще атрибут.
    if (/data-i18n-html=/.test(match[2])) continue;
    if (/<[a-zA-Z]/.test(content)) {
      const id = /\sid="([^"]+)"/.exec(match[2]);
      offenders.push(`<${tag}${id ? ` id="${id[1]}"` : ''}> содержит: ${content.trim().slice(0, 70)}`);
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `перевод сотрёт вложенные элементы:\n${offenders.join('\n')}`,
  );
});

test('у каждой иконки в разметке есть запасной символ', () => {
  const html = fs.readFileSync(HTML, 'utf8');
  const icons = [...html.matchAll(/<span class="ico"[^>]*>/g)].map((m) => m[0]);
  assert.ok(icons.length > 5, 'иконки в разметке не найдены');

  const broken = icons.filter((tag) => !/data-fallback="[^"]+"/.test(tag));
  assert.deepStrictEqual(broken, [], `без запасного символа: ${broken.join(', ')}`);
});

test('все ключи локализации из разметки есть в словаре', () => {
  const html = fs.readFileSync(HTML, 'utf8');
  const messages = require('../src/shared/messages');

  const keys = new Set();
  for (const match of html.matchAll(/data-i18n(?:-html|-title)?="([^"]+)"/g)) keys.add(match[1]);

  const missing = [...keys].filter(
    (key) => !Object.prototype.hasOwnProperty.call(messages.en, key),
  );
  assert.deepStrictEqual(missing, [], `нет в словаре: ${missing.join(', ')}`);

  const untranslated = [...keys].filter(
    (key) => !Object.prototype.hasOwnProperty.call(messages.ru, key),
  );
  assert.deepStrictEqual(untranslated, [], `нет перевода: ${untranslated.join(', ')}`);
});
