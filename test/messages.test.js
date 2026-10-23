'use strict';
/*
 * Проверки словарей.
 *
 * Ключи в messages.js перекрываются молча: если один и тот же ключ объявлен
 * дважды, побеждает последний, и текст в интерфейсе оказывается чужим. Такое
 * уже случалось — окно конвертации показывало фразу из другого места.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', 'src', 'shared', 'messages.js');
const text = fs.readFileSync(SOURCE, 'utf8');

/** Разбить файл на языковые блоки по строкам «en: {» и «ru: {». */
function blocks() {
  const lines = text.split('\n');
  const result = { en: [], ru: [] };
  let current = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*en:\s*\{/.test(line)) current = 'en';
    else if (/^\s*ru:\s*\{/.test(line)) current = 'ru';
    else if (/^\s*\},?\s*$/.test(line) && current) current = null;
    else if (current) result[current].push({ line: i + 1, text: line });
  }

  return result;
}

function keysOf(entries) {
  const keys = new Map();
  for (const entry of entries) {
    const match = /^\s*'([^']+)':/.exec(entry.text);
    if (!match) continue;
    const key = match[1];
    if (!keys.has(key)) keys.set(key, []);
    keys.get(key).push(entry.line);
  }
  return keys;
}

test('ни один ключ не объявлен дважды в одном языке', () => {
  const parsed = blocks();

  for (const language of ['en', 'ru']) {
    const keys = keysOf(parsed[language]);
    const duplicates = [...keys.entries()].filter(([, lines]) => lines.length > 1);

    assert.deepStrictEqual(
      duplicates.map(([key, lines]) => `${language}:${key} (строки ${lines.join(', ')})`),
      [],
      'дубли ключей перекрывают друг друга',
    );
  }
});

test('в обеих языковых версиях одинаковый набор ключей', () => {
  const parsed = blocks();
  const en = new Set(keysOf(parsed.en).keys());
  const ru = new Set(keysOf(parsed.ru).keys());

  const onlyEn = [...en].filter((key) => !ru.has(key));
  const onlyRu = [...ru].filter((key) => !en.has(key));

  assert.deepStrictEqual(onlyEn, [], 'ключи без русского перевода');
  assert.deepStrictEqual(onlyRu, [], 'ключи без английского перевода');
});

test('строки словаря не склеиваются по две в одну', () => {
  const parsed = blocks();

  for (const language of ['en', 'ru']) {
    for (const entry of parsed[language]) {
      const quotes = (entry.text.match(/':/g) || []).length;
      assert.ok(
        quotes <= 1,
        `${language}, строка ${entry.line}: в одной строке несколько ключей`,
      );
    }
  }
});
