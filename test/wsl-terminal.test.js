'use strict';
/*
 * Проверки запуска консоли WSL.
 *
 * Главное, что здесь ловится: команда должна доехать до bash целой. Раньше она
 * передавалась через `cmd /c start`, cmd ломал кавычки, и окно открывалось
 * пустым. Поэтому проверяем не только текст обёртки, но и реальный запуск:
 * выполняется команда с кавычками и пробелами, и мы сверяем вывод.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const term = require('../src/main/modules/wsl-terminal');

test('путь к wsl.exe указывает в Program Files', () => {
  const candidate = term.systemWslPath();
  assert.match(candidate, /WSL[\\/]wsl\.exe$/i);

  if (fs.existsSync(candidate)) assert.strictEqual(term.executable(), candidate);
  else assert.strictEqual(term.executable(), 'wsl.exe');
});

test('обёртка открывает домашнюю папку и передаёт команду через base64', () => {
  const text = term.shimContent('xtool auth login', 'Ubuntu');

  assert.match(text, /--cd ~/);
  assert.match(text, /-d Ubuntu/);
  // Команда не попадает в файл открытым текстом — только в base64.
  assert.doesNotMatch(text, /xtool auth login/);

  const encoded = /echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(text);
  assert.ok(encoded, 'нет base64 в обёртке');
  assert.strictEqual(
    Buffer.from(encoded[1], 'base64').toString('utf8'),
    'xtool auth login',
  );
});

test('без команды обёртка просто открывает консоль', () => {
  const text = term.shimContent(undefined, 'Ubuntu');
  assert.match(text, /--cd ~/);
  assert.doesNotMatch(text, /base64/);
  assert.doesNotMatch(text, /read _/);
});

test('ожидание Enter отключается для тестов', () => {
  assert.match(term.shimContent('echo x', 'Ubuntu'), /read _/);
  assert.doesNotMatch(term.shimContent('echo x', 'Ubuntu', { wait: false }), /read _/);
});

test('обёртка пишется во временную папку', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-shim-'));
  const file = term.writeShim('echo hi', 'Ubuntu', { dir, wait: false });

  assert.ok(fs.existsSync(file));
  assert.match(file, /\.cmd$/);
  assert.match(fs.readFileSync(file, 'utf8'), /--cd ~/);
});

test('команда с кавычками доезжает до bash целиком', () => {
  // Проверяем именно то, что ломалось: пробелы, кавычки и точка с запятой.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-shim-run-'));
  const command = `echo "привет мир" && echo 'second part' && echo 42`;
  const file = term.writeShim(command, 'Ubuntu', { dir, wait: false });

  const output = execFileSync('cmd.exe', ['/c', file], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, WSL_UTF8: '1' },
  });

  assert.match(output, /привет мир/, `вывод: ${output}`);
  assert.match(output, /second part/, `вывод: ${output}`);
  assert.match(output, /42/, `вывод: ${output}`);
});
