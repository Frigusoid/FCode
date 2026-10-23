'use strict';
/*
 * Проверки установки SDK.
 *
 * Здесь была ошибка, которая валила настройку на новом компьютере:
 * путь из Windows-диалога («D:\Xcode_16.4.xip») уходил в bash как есть.
 * Внутри Linux такого пути нет, и xtool отвечал
 * «Could not read file or directory at path 'D:\Xcode_16.4.xip'».
 */

const test = require('node:test');
const assert = require('node:assert');

const xtool = require('../src/main/modules/xtool');
const requirements = require('../src/main/modules/requirements');

test('путь Windows превращается в путь Linux', () => {
  assert.strictEqual(xtool.toWslPath('D:\\Xcode_16.4.xip'), '/mnt/d/Xcode_16.4.xip');
  assert.strictEqual(
    xtool.toWslPath('C:\\Users\\Frigus\\Downloads\\Xcode_16.4.xip'),
    '/mnt/c/Users/Frigus/Downloads/Xcode_16.4.xip',
  );
});

test('кириллица и пробелы в пути не ломаются', () => {
  assert.strictEqual(
    xtool.toWslPath('D:\\Мои файлы\\Xcode.xip'),
    '/mnt/d/Мои файлы/Xcode.xip',
  );
});

test('в команду установки попадает путь Linux, а не Windows', async () => {
  // Перехватываем запуск, чтобы увидеть сам текст скрипта.
  const wslExec = require('../src/main/modules/wsl-exec');
  const originalRun = wslExec.run;
  let captured = null;

  wslExec.run = async (options) => {
    captured = options.script;
    return { ok: true, code: 0, output: '' };
  };

  try {
    await requirements.installSdk('D:\\Xcode_16.4.xip', {});
  } finally {
    wslExec.run = originalRun;
  }

  assert.ok(captured, 'скрипт не сформирован');
  assert.match(captured, /\/mnt\/d\/Xcode_16\.4\.xip/, 'нет пути Linux');
  assert.doesNotMatch(captured, /D:\\\\Xcode/, 'в скрипт попал путь Windows');
});

test('скрипт проверяет, что архив виден из Linux', async () => {
  const wslExec = require('../src/main/modules/wsl-exec');
  const originalRun = wslExec.run;
  let captured = null;

  wslExec.run = async (options) => {
    captured = options.script;
    return { ok: true, code: 0, output: '' };
  };

  try {
    await requirements.installSdk('C:\\Downloads\\Xcode.xip', {});
  } finally {
    wslExec.run = originalRun;
  }

  // Проверка даёт понятную ошибку вместо «exit code 1» из недр xtool.
  assert.match(captured, /SDK_SOURCE_NOT_FOUND/);
  assert.match(captured, /\[ ! -e /);
});

test('кавычки в пути экранируются', async () => {
  const wslExec = require('../src/main/modules/wsl-exec');
  const originalRun = wslExec.run;
  let captured = null;

  wslExec.run = async (options) => {
    captured = options.script;
    return { ok: true, code: 0, output: '' };
  };

  try {
    // Апостроф в имени папки — реальный случай (имена вроде «tet-`obed»).
    await requirements.installSdk("D:\\tet-'obed\\Xcode.xip", {});
  } finally {
    wslExec.run = originalRun;
  }

  assert.ok(captured.includes("'\\''"), 'апостроф не экранирован');
});

test('resolveSdkSource принимает .xip напрямую', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-xip-'));
  const xip = path.join(dir, 'Xcode_16.4.xip');
  fs.writeFileSync(xip, 'not really a xip', 'utf8');

  const direct = requirements.resolveSdkSource(xip);
  assert.strictEqual(direct.path, xip);
  assert.strictEqual(direct.kind, 'xip');

  // Папка: находим .xip внутри.
  const inFolder = requirements.resolveSdkSource(dir);
  assert.strictEqual(inFolder.path, xip);
  assert.strictEqual(inFolder.kind, 'xip');
});
