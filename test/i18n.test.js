'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const i18n = require('../src/shared/i18n');
const messages = require('../src/shared/messages');

test('словари en и ru содержат одинаковый набор ключей', () => {
  const en = Object.keys(messages.en).sort();
  const ru = Object.keys(messages.ru).sort();

  const missingInRu = en.filter((key) => !Object.prototype.hasOwnProperty.call(messages.ru, key));
  const missingInEn = ru.filter((key) => !Object.prototype.hasOwnProperty.call(messages.en, key));

  assert.deepStrictEqual(missingInRu, [], `нет перевода на русский: ${missingInRu.join(', ')}`);
  assert.deepStrictEqual(missingInEn, [], `нет английского оригинала: ${missingInEn.join(', ')}`);
  assert.ok(en.length > 200, `словарь подозрительно мал: ${en.length} ключей`);
});

test('параметры {name} совпадают в обоих языках', () => {
  const placeholders = (text) => (text.match(/\{(\w+)\}/g) || []).sort().join(',');
  const mismatched = [];

  for (const [key, english] of Object.entries(messages.en)) {
    const russian = messages.ru[key];
    if (typeof russian !== 'string') continue;
    if (placeholders(english) !== placeholders(russian)) {
      mismatched.push(`${key}: en[${placeholders(english)}] ru[${placeholders(russian)}]`);
    }
  }

  assert.deepStrictEqual(mismatched, [], `несовпадение параметров:\n${mismatched.join('\n')}`);
});

test('ни одна строка не осталась пустой', () => {
  for (const language of ['en', 'ru']) {
    for (const [key, value] of Object.entries(messages[language])) {
      assert.strictEqual(typeof value, 'string', `${language}.${key} — не строка`);
      assert.ok(value.trim().length > 0, `${language}.${key} пустая`);
    }
  }
});

test('t() подставляет параметры и переключает язык', () => {
  i18n.setLanguage('en');
  assert.strictEqual(i18n.t('toolbar.open'), 'Open');
  assert.strictEqual(i18n.t('log.openedFile', { name: 'App.swift', size: '4 KiB' }), 'Opened App.swift (4 KiB)');

  i18n.setLanguage('ru');
  assert.strictEqual(i18n.t('toolbar.open'), 'Открыть');
  assert.strictEqual(i18n.t('log.openedFile', { name: 'App.swift', size: '4 КиБ' }), 'Открыт App.swift (4 КиБ)');

  i18n.setLanguage('en');
});

test('язык по умолчанию — английский, неизвестный код откатывается к нему', () => {
  assert.strictEqual(i18n.FALLBACK, 'en');
  assert.strictEqual(i18n.normalize('de'), 'en');
  assert.strictEqual(i18n.normalize('ru-RU'), 'ru');
  assert.strictEqual(i18n.normalize('EN'), 'en');
  assert.strictEqual(i18n.normalize(undefined), 'en');
});

test('неизвестный ключ возвращается как есть, а не как undefined', () => {
  i18n.setLanguage('en');
  assert.strictEqual(i18n.t('нет.такого.ключа'), 'нет.такого.ключа');
});

test('подписчики получают уведомление только при реальной смене языка', () => {
  const seen = [];
  const unsubscribe = i18n.onLanguageChange((language) => seen.push(language));

  i18n.setLanguage('en');
  i18n.setLanguage('ru');
  i18n.setLanguage('ru-RU');
  i18n.setLanguage('de');
  i18n.setLanguage('en');

  unsubscribe();
  i18n.setLanguage('ru');

  assert.deepStrictEqual(seen, ['ru', 'en']);
  i18n.setLanguage('en');
});
