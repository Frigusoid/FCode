'use strict';
/*
 * Проверки разбора Swift SDK.
 *
 * Главный сценарий: бандл объявлен под x86_64-unknown-linux-gnu, а система
 * представляется как x86_64-pc-linux-gnu. `swift sdk list` при этом показывает
 * darwin, поэтому проблема выглядит как «SDK есть, а сборка не идёт».
 */

const test = require('node:test');
const assert = require('node:assert');

const xtool = require('../src/main/modules/xtool');

test('разбирает triple из info.json бандла', () => {
  const json = JSON.stringify({
    schemaVersion: '1.0',
    artifacts: {
      darwin: {
        type: 'swiftSDK',
        version: '0.0.1',
        variants: [
          {
            path: '.',
            supportedTriples: ['aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu'],
          },
        ],
      },
    },
  });

  const triples = xtool.parseSdkTriples(json);
  assert.deepStrictEqual(triples, ['aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu']);
});

test('собирает triple из нескольких вариантов', () => {
  const json = JSON.stringify({
    artifacts: {
      darwin: {
        variants: [
          { supportedTriples: ['aarch64-unknown-linux-gnu'] },
          { supportedTriples: ['x86_64-unknown-linux-gnu'] },
        ],
      },
    },
  });

  assert.deepStrictEqual(xtool.parseSdkTriples(json), [
    'aarch64-unknown-linux-gnu',
    'x86_64-unknown-linux-gnu',
  ]);
});

test('на битом JSON возвращает пустой список, а не падает', () => {
  assert.deepStrictEqual(xtool.parseSdkTriples('не json'), []);
  assert.deepStrictEqual(xtool.parseSdkTriples(''), []);
  assert.deepStrictEqual(xtool.parseSdkTriples('нет'), []);
});

test('берёт triple системы из вывода swift --version', () => {
  const output = 'Swift version 6.1.3 (swift-6.1.3-RELEASE)\nTarget: x86_64-pc-linux-gnu';
  assert.strictEqual(xtool.hostTripleOf(output), 'x86_64-pc-linux-gnu');
});

test('понимает aarch64', () => {
  const output = 'Swift version 6.1.3\nTarget: aarch64-unknown-linux-gnu';
  assert.strictEqual(xtool.hostTripleOf(output), 'aarch64-unknown-linux-gnu');
});

test('без строки Target возвращает null', () => {
  assert.strictEqual(xtool.hostTripleOf('Swift version 6.1.3'), null);
  assert.strictEqual(xtool.hostTripleOf(''), null);
});

test('ловит расхождение pc и unknown — из-за него сборка и падала', () => {
  const triples = xtool.parseSdkTriples(
    JSON.stringify({
      artifacts: {
        darwin: { variants: [{ supportedTriples: ['x86_64-unknown-linux-gnu'] }] },
      },
    }),
  );
  const host = xtool.hostTripleOf('Target: x86_64-pc-linux-gnu');

  assert.ok(host);
  assert.strictEqual(triples.includes(host), false, 'расхождение должно обнаруживаться');
});
