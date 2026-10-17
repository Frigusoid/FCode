'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const swift = require('../src/main/modules/swift');

/** Настоящий вывод swift build — взят из живого запуска. */
const REAL_OUTPUT = `Building for debugging...
[0/2] Write sources
[1/2] Write swift-version--413BBEA0737331CC.txt
error: emit-module command failed with exit code 1 (use -v to see invocation)
[3/4] Emitting module FmtTest
/tmp/fmttest/Sources/FmtTest/bad.swift:2:14: error: cannot convert value of type 'String' to specified type 'Int'
1 | import Foundation
2 | let x: Int = "строка вместо числа"
  |              ^~~~~~~~~~~~~~~~~~~~~~~~
/tmp/fmttest/Sources/FmtTest/bad.swift:3:7: warning: variable 'y' was never used; consider replacing with '_'
/tmp/fmttest/Sources/FmtTest/bad.swift:2:14: note: remove the initializer
Build complete!
`;

test('разбор ошибок компилятора: путь, строка, колонка, вид', () => {
  const diagnostics = swift.parseDiagnostics(REAL_OUTPUT, { distro: 'Ubuntu' });

  assert.strictEqual(diagnostics.length, 2, 'должны остаться только error и warning');

  const error = diagnostics[0];
  assert.strictEqual(error.severity, 'error');
  assert.strictEqual(error.line, 1, 'строка 2 превращается в индекс 1');
  assert.strictEqual(error.character, 13, 'колонка 14 превращается в индекс 13');
  assert.match(error.message, /cannot convert value of type 'String'/);

  const warning = diagnostics[1];
  assert.strictEqual(warning.severity, 'warning');
  assert.strictEqual(warning.line, 2);
  assert.match(warning.message, /never used/);
});

test('строки без привязки к файлу игнорируются и не ломают разбор', () => {
  const diagnostics = swift.parseDiagnostics(REAL_OUTPUT);
  // «error: emit-module command failed» без пути — привязать некуда.
  assert.ok(!diagnostics.some((item) => /emit-module command failed/.test(item.message)));
  // Строки с исходным кодом и кареткой тоже не должны попасть в результат.
  assert.ok(!diagnostics.some((item) => item.message.includes('import Foundation')));
});

test('примечания приклеиваются к своей ошибке, а не становятся отдельными', () => {
  const diagnostics = swift.parseDiagnostics(REAL_OUTPUT);
  const error = diagnostics[0];
  assert.deepStrictEqual(error.notes, ['remove the initializer']);
});

test('путь /mnt/c переводится в формат Windows', () => {
  const output = '/mnt/c/Users/Frigus/proj/Sources/App/ContentView.swift:10:3: error: что-то не так\n';
  const [diagnostic] = swift.parseDiagnostics(output);

  assert.strictEqual(diagnostic.path, 'C:\\Users\\Frigus\\proj\\Sources\\App\\ContentView.swift');
  assert.strictEqual(diagnostic.line, 9);
  assert.strictEqual(diagnostic.character, 2);
});

test('пути вне /mnt доступны через UNC-путь к дистрибутиву', () => {
  assert.strictEqual(
    swift.wslPathToWindows('/tmp/build/foo.swift', 'Ubuntu'),
    '\\\\wsl$\\Ubuntu\\tmp\\build\\foo.swift',
  );
});

test('относительный путь достраивается от каталога сборки', () => {
  const output = 'Sources/App/ContentView.swift:5:1: error: тест\n';
  const [diagnostic] = swift.parseDiagnostics(output, { cwd: '/mnt/d/proj' });

  assert.strictEqual(diagnostic.path, 'D:\\proj\\Sources\\App\\ContentView.swift');
  assert.strictEqual(diagnostic.wslPath, '/mnt/d/proj/Sources/App/ContentView.swift');
});

test('ссылка без колонки тоже разбирается', () => {
  const output = '/mnt/d/proj/File.swift:7: error: без колонки\n';
  const [diagnostic] = swift.parseDiagnostics(output);

  assert.strictEqual(diagnostic.line, 6);
  assert.strictEqual(diagnostic.character, 0);
  assert.match(diagnostic.message, /без колонки/);
});

test('пустой и мусорный вывод не даёт диагностик', () => {
  assert.deepStrictEqual(swift.parseDiagnostics(''), []);
  assert.deepStrictEqual(swift.parseDiagnostics('Compiling...\nDone\n'), []);
  assert.deepStrictEqual(swift.parseDiagnostics(null), []);
});

test('диапазон диагностики не нулевой — иначе подчёркивание не видно', () => {
  const [diagnostic] = swift.parseDiagnostics('/mnt/d/a/B.swift:1:1: error: x\n');
  assert.ok(diagnostic.endCharacter > diagnostic.character);
  assert.strictEqual(diagnostic.endLine, diagnostic.line);
});
