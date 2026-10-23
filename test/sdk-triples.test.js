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

test('читает triple цели из swift-sdk.json', () => {
  const json = JSON.stringify({
    schemaVersion: '4.0',
    targetTriples: {
      'arm64-apple-ios': { sdkRootPath: 'Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk' },
      'arm64-apple-ios-simulator': { sdkRootPath: 'Developer/Platforms/iPhoneSimulator.platform/...' },
      'arm64-apple-macosx': { sdkRootPath: '...' },
    },
  });

  const targets = xtool.parseSdkTargets(json);
  assert.ok(targets.includes('arm64-apple-ios'));
  assert.ok(targets.includes('arm64-apple-ios-simulator'));
});

test('без iOS-цели список её не содержит — это и есть сломанный SDK', () => {
  const json = JSON.stringify({
    targetTriples: {
      'arm64-apple-ios-simulator': {},
      'arm64-apple-macosx': {},
    },
  });

  const targets = xtool.parseSdkTargets(json);
  assert.strictEqual(targets.includes('arm64-apple-ios'), false);
});

test('swift sdk list показывает имя бандла, а не triple', () => {
  // Отсюда и путаница: список печатает «darwin», хотя компилятор ищет triple.
  // Проверяем, что имя бандла и triple цели — разные вещи.
  const bundleName = 'darwin';
  const json = JSON.stringify({ targetTriples: { 'arm64-apple-ios': {} } });

  assert.strictEqual(xtool.parseSdkTargets(json).includes(bundleName), false);
  assert.ok(xtool.parseSdkTargets(json).includes('arm64-apple-ios'));
});

test('на битом swift-sdk.json возвращает пустой список', () => {
  assert.deepStrictEqual(xtool.parseSdkTargets('не json'), []);
  assert.deepStrictEqual(xtool.parseSdkTargets(''), []);
  assert.deepStrictEqual(xtool.parseSdkTargets('нет'), []);
});
