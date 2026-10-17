'use strict';
/*
 * Движок локализации, общий для главного процесса и интерфейса.
 *
 * Оба процесса собираются из одного исходника: главный процесс подключает файл
 * через require, интерфейс — через esbuild. Поэтому словарь один на всех и не
 * может разойтись.
 *
 * Ключи плоские и точечные ("toolbar.build"), чтобы словари en и ru было легко
 * сверять построчно. Подстановка параметров — через {имя}.
 */

const messages = require('./messages');

const SUPPORTED = ['en', 'ru'];
const FALLBACK = 'en';

let current = FALLBACK;
const listeners = new Set();

function normalize(language) {
  if (!language) return FALLBACK;
  const short = String(language).toLowerCase().split(/[-_]/)[0];
  return SUPPORTED.includes(short) ? short : FALLBACK;
}

function setLanguage(language) {
  const next = normalize(language);
  const changed = next !== current;
  current = next;
  if (changed) listeners.forEach((listener) => listener(next));
  return current;
}

function getLanguage() {
  return current;
}

function onLanguageChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined
      ? String(params[name])
      : match,
  );
}

/**
 * Перевести ключ.
 * Если перевода нет, возвращается английский вариант, затем сам ключ — так
 * непереведённая строка видна сразу и не ломает интерфейс.
 */
function t(key, params) {
  const table = messages[current] || messages[FALLBACK];
  const value = table[key];
  if (typeof value === 'string') return interpolate(value, params);

  const fallbackTable = messages[FALLBACK] || {};
  if (typeof fallbackTable[key] === 'string') return interpolate(fallbackTable[key], params);

  return key;
}

/** Есть ли перевод — используется в тестах для поиска пропусков. */
function has(key, language) {
  const table = messages[language || current] || {};
  return typeof table[key] === 'string';
}

/** Все ключи словаря — для проверки полноты языков. */
function keys(language) {
  return Object.keys(messages[language || current] || {});
}

module.exports = {
  SUPPORTED,
  FALLBACK,
  t,
  has,
  keys,
  setLanguage,
  getLanguage,
  onLanguageChange,
  normalize,
  messages,
};
