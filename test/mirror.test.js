'use strict';
/*
 * Проверки модуля зеркала.
 *
 * Зеркало нужно потому, что SwiftPM не работает через 9p-монтирование /mnt:
 * сборка падает на блокировке файла состояния. Проект копируется внутрь Linux,
 * собирается там, а пути диагностик переводятся обратно в формат Windows.
 *
 * Отдельное внимание — именам папок. На реальном проекте папка называлась
 * «tet-`», и обратный апостроф ломал bash: путь подставлялся в двойных кавычках
 * и воспринимался как подстановка команды. Теперь такие данные кодируются.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mirror = require('../src/main/modules/mirror');

test('ключ зеркала устойчив и различает пути', () => {
  const first = mirror.mirrorKey('D:\\Projects\\Alpha');
  const second = mirror.mirrorKey('D:\\Projects\\Beta');

  assert.strictEqual(first, mirror.mirrorKey('D:\\Projects\\Alpha'), 'тот же путь — тот же ключ');
  assert.notStrictEqual(first, second, 'разные пути не должны смешиваться');
  assert.ok(/^[0-9a-f]{12}$/.test(first), `неожиданный формат ключа: ${first}`);
});

test('путь Windows переводится в путь WSL', () => {
  assert.strictEqual(mirror.toWslPath('D:\\Projects\\App'), '/mnt/d/Projects/App');
  assert.strictEqual(mirror.toWslPath('C:\\Users\\me\\code'), '/mnt/c/Users/me/code');
});

test('путь зеркала возвращается в формат Windows', () => {
  const root = '/tmp/fcode-build/abc123';
  const project = 'D:\\Projects\\App';

  assert.strictEqual(
    mirror.mirrorToWindows(`${root}/Sources/App/main.swift`, root, project),
    path.join(project, 'Sources', 'App', 'main.swift'),
  );
  assert.strictEqual(mirror.mirrorToWindows(root, root, project), path.resolve(project));
});

test('чужой путь не переписывается', () => {
  // Файл вне зеркала — например, из системной библиотеки — должен остаться как есть.
  const outside = '/usr/lib/swift/Foundation.swift';
  assert.strictEqual(mirror.mirrorToWindows(outside, '/tmp/fcode-build/abc', 'D:\\App'), outside);
});

test('пути с обратным апострофом и кавычками не ломают скрипт', () => {
  // Именно на таком имени падала сборка: bash видел подстановку команды.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'modules', 'mirror.js'),
    'utf8',
  );

  // Путь не должен подставляться в скрипт напрямую — только через base64.
  assert.ok(
    source.includes('base64 -d'),
    'путь обязан передаваться в скрипт закодированным',
  );
  assert.ok(
    !/\$\{source\}/.test(source),
    'путь не должен подставляться в текст скрипта как есть',
  );
  assert.ok(
    /Buffer\.from\(source, 'utf8'\)\.toString\('base64'\)/.test(source),
    'исходный путь должен кодироваться в base64',
  );
});

test('кодирование пути переживает спецсимволы', () => {
  const nasty = '/mnt/q/Documents/tet-`/obed';
  const encoded = Buffer.from(nasty, 'utf8').toString('base64');

  // В закодированной строке нет ничего, что bash мог бы истолковать.
  assert.match(encoded, /^[A-Za-z0-9+/=]+$/);
  assert.strictEqual(Buffer.from(encoded, 'base64').toString('utf8'), nasty);
});
