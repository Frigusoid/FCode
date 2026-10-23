'use strict';
/*
 * Проверки разбора причины отказа при входе в Apple ID.
 *
 * Раньше интерфейс выбрасывал ответ Apple и всегда писал «проверьте пароль».
 * Из-за этого настоящая причина — блокировка попыток или неверный код
 * двухфакторной проверки — оставалась невидимой.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Функция живёт внутри signin.js рядом с DOM, поэтому проверяем её исходник:
// вырезаем тело explainFailure и исполняем отдельно.
const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'signin.js'),
  'utf8',
);

const start = source.indexOf('const explainFailure = (text) => {');
assert.ok(start !== -1, 'explainFailure не найдена в signin.js');

// Ищем закрывающую скобку функции по балансу.
let depth = 0;
let end = start;
for (let i = source.indexOf('{', start); i < source.length; i += 1) {
  if (source[i] === '{') depth += 1;
  else if (source[i] === '}') {
    depth -= 1;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}

const body = source.slice(start, end);
// Заглушка перевода: возвращаем ключ, чтобы проверять выбор подсказки.
const explainFailure = new Function('t', `${body}\nreturn explainFailure;`)((key) => key);

test('достаёт текст ошибки из вывода xtool', () => {
  const output = 'Logging in...\nError: This action cannot be completed at this time. (-80045)\nMore text';
  const result = explainFailure(output);

  assert.match(result.reason, /cannot be completed/);
  // Код -80045 означает блокировку попыток, а не неверный пароль.
  assert.strictEqual(result.hint, 'auth.hintTooMany');
});

test('неверный пароль подсказывает проверить пароль', () => {
  const output = 'Error: Incorrect password for this Apple ID.';
  const result = explainFailure(output);

  assert.match(result.reason, /Incorrect password/);
  assert.strictEqual(result.hint, 'auth.hintPassword');
});

test('ошибка двухфакторной проверки распознаётся', () => {
  const output = 'Error: Invalid two-factor verification code.';
  const result = explainFailure(output);

  assert.strictEqual(result.hint, 'auth.hintTwoFactor');
});

test('истёкшая сессия распознаётся', () => {
  const output = 'Error: The authentication token has expired.';
  const result = explainFailure(output);

  assert.strictEqual(result.hint, 'auth.hintSession');
});

test('без понятной ошибки подсказка общая', () => {
  const result = explainFailure('Logging in...\nsomething odd happened');

  assert.strictEqual(result.reason, 'something odd happened');
  assert.strictEqual(result.hint, 'auth.hintUnknown');
});

test('пустой вывод не ломает разбор', () => {
  const result = explainFailure('');

  assert.strictEqual(result.reason, '');
  assert.strictEqual(result.hint, 'auth.hintUnknown');
});
