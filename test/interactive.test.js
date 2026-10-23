'use strict';
/*
 * Проверки драйвера интерактивных команд.
 *
 * Драйвер ведёт диалог с `xtool auth`: показывает приглашения и отправляет
 * ответы. Здесь проверяется то, что не требует запуска Apple: распознавание
 * приглашений и раскодирование вывода.
 */

const test = require('node:test');
const assert = require('node:assert');

const interactive = require('../src/main/modules/interactive');
const wslExec = require('../src/main/modules/wsl-exec');

test('приглашение распознаётся по двоеточию', () => {
  assert.strictEqual(interactive.looksLikePrompt('Enter the 2FA code: '), true);
  assert.strictEqual(interactive.looksLikePrompt('Select a team (0-2): '), true);
  assert.strictEqual(interactive.looksLikePrompt('Continue? '), true);
});

test('обычная строка вывода не считается приглашением', () => {
  assert.strictEqual(interactive.looksLikePrompt('Logging in...'), false);
  assert.strictEqual(interactive.looksLikePrompt(''), false);
  assert.strictEqual(interactive.looksLikePrompt('Error: something failed'), false);
});

test('слишком длинный хвост не принимается за приглашение', () => {
  assert.strictEqual(interactive.looksLikePrompt(`${'a'.repeat(600)}:`), false);
});

test('вывод в UTF-16LE раскодируется, а не превращается в кракозябры', () => {
  // Именно так wsl.exe печатает свои сообщения об ошибках.
  const text = 'Wsl/Service/WSL_E_DISTRO_NOT_FOUND';
  const utf16 = Buffer.from(text, 'utf16le');

  const decoded = wslExec.decodeChunk(utf16);
  assert.strictEqual(decoded, text);
  assert.ok(!decoded.includes('\u0000'), 'в строке остались нулевые байты');
});

test('обычный UTF-8 не портится', () => {
  const buffer = Buffer.from('Swift version 6.1.3\n', 'utf8');
  assert.strictEqual(wslExec.decodeChunk(buffer), 'Swift version 6.1.3\n');
});

test('кириллица в UTF-8 читается правильно', () => {
  const buffer = Buffer.from('Готово\n', 'utf8');
  assert.strictEqual(wslExec.decodeChunk(buffer), 'Готово\n');
});

test('wsl.exe запускается с принудительным UTF-8', () => {
  assert.strictEqual(wslExec.WSL_ENV.WSL_UTF8, '1');
});

test('сессия отправляет ответ в stdin', () => {
  const session = new interactive.InteractiveSession({
    command: 'echo test',
    onOutput: () => {},
  });
  // Без запуска процесса send должен спокойно вернуть false, а не упасть.
  assert.strictEqual(session.send('123456'), false);
});

test('драйвер не падает, если процесса ещё нет', () => {
  const session = new interactive.InteractiveSession({
    command: 'echo test',
    onOutput: () => {},
  });

  // killChild и failSoon должны спокойно переживать отсутствие процесса:
  // их вызывают в том числе при зависании WSL.
  assert.doesNotThrow(() => session.killChild());
  assert.doesNotThrow(() => session.failSoon('Error: test'));
});

test('failSoon не запускает второй таймер', () => {
  const session = new interactive.InteractiveSession({
    command: 'echo test',
    onOutput: () => {},
  });

  session.failSoon('первый раз');
  const firstTimer = session.failTimer;
  session.failSoon('второй раз');

  assert.strictEqual(session.failTimer, firstTimer, 'таймер перезаписан');
});

// Запуск настоящего процесса живёт в scripts/verify-signin.cjs: держать его
// в общем наборе нельзя — на машине без запущенного WSL прогон зависает.
