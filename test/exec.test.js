'use strict';
/*
 * Проверки правила «от кого запускать команды в WSL».
 *
 * Токен Apple ID xtool хранит в домашней папке пользователя, поэтому команды
 * xtool обязаны идти от него, а не от root. Системные задачи вроде apt наоборот
 * требуют root, чтобы не спрашивать пароль. Перепутать эти два случая легко,
 * а стоит это часами поиска причины «Logged out».
 */

const test = require('node:test');
const assert = require('node:assert');

const wslExec = require('../src/main/modules/wsl-exec');

/** Достать пользователя из аргументов wsl.exe. */
function userOf(args) {
  const index = args.indexOf('-u');
  return index === -1 ? null : args[index + 1];
}

test('по умолчанию команды идут от root — для apt это обязательно', () => {
  const args = wslExec.buildArgs('Ubuntu', undefined, 'apt-get update');
  assert.strictEqual(userOf(args), 'root');
});

test('user: null даёт пользователя дистрибутива — там лежит токен Apple ID', () => {
  const args = wslExec.buildArgs('Ubuntu', null, 'xtool auth status');
  assert.strictEqual(userOf(args), null, 'флаг -u не должен добавляться');
  assert.ok(!args.includes('-u'), 'wsl.exe сам подставит пользователя по умолчанию');
});

test('явный пользователь подставляется как есть', () => {
  const args = wslExec.buildArgs('Ubuntu', 'frigus', 'xtool dev');
  assert.strictEqual(userOf(args), 'frigus');
});

test('дистрибутив и скрипт всегда на месте', () => {
  const args = wslExec.buildArgs('Ubuntu', null, 'echo привет');
  assert.strictEqual(args[0], '-d');
  assert.strictEqual(args[1], 'Ubuntu');
  assert.ok(args.includes('bash'));
  assert.ok(args.includes('-lc'));
});

test('многострочный скрипт кодируется, а не передаётся как есть', () => {
  // Кавычки и $ в аргументах командной строки Windows ломаются,
  // поэтому скрипт уходит в base64.
  const script = 'echo "$HOME"\nfor i in 1 2; do echo $i; done';
  const args = wslExec.buildArgs('Ubuntu', null, script);
  const last = args[args.length - 1];

  assert.ok(!last.includes('\n'), 'переводы строк не должны попадать в аргумент');
  assert.notStrictEqual(last, script);

  // Скрипт передаётся как «echo <base64> | base64 -d | bash».
  const encoded = /^echo ([A-Za-z0-9+/=]+) \| base64 -d \| bash$/.exec(last);
  assert.ok(encoded, `неожиданный формат: ${last.slice(0, 60)}`);
  assert.strictEqual(Buffer.from(encoded[1], 'base64').toString('utf8'), script);
});

test('команды xtool запускаются от пользователя, а не от root', () => {
  // Это то самое место, где раньше терялся токен: установка SDK шла от root
  // и получала «Logged out» при живом токене в домашней папке пользователя.
  const requirements = require('../src/main/modules/requirements');
  assert.ok(typeof requirements.installSdk === 'function');

  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'main', 'modules', 'requirements.js'),
    'utf8',
  );
  const call = /wslExec\.run\(\{([^}]*)\}\)/.exec(source);
  assert.ok(call, 'вызов wslExec.run не найден');
  assert.match(call[1], /user:\s*null/, 'установка SDK должна идти от владельца токена');
});
