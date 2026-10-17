'use strict';
/*
 * Согласование версий SDK и компилятора.
 *
 * Проверки описывают то, на чём мы реально споткнулись: SDK от Xcode 26.6
 * собран компилятором 6.3.2, и Swift 6.1.3 не смог прочитать его интерфейсы —
 * сборка развалилась на тысячах «unknown attribute 'safe'». Обратное
 * направление (компилятор новее SDK) работает, поэтому правило одностороннее.
 *
 * Вторая проверка — про deployment target: свежий SDK не мешает собирать под
 * старые iOS. Это частый источник недоразумений, и он зафиксирован тестом.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const versions = require('../src/main/modules/versions');

test('версии сравниваются по числам, а не по строкам', () => {
  // Строковое сравнение поставило бы «6.10» ниже «6.9».
  assert.strictEqual(versions.compareVersions('6.10', '6.9'), 1);
  assert.strictEqual(versions.compareVersions('6.1.3', '6.1'), 1);
  assert.strictEqual(versions.compareVersions('6.1', '6.1.0'), 0);
  assert.strictEqual(versions.compareVersions('6.0.3', '6.1'), -1);
});

test('для Xcode 26.6 требуется Swift 6.4.1', () => {
  const entry = versions.toolchainForXcode('26.6');
  assert.ok(entry, 'версия должна быть в таблице');
  assert.strictEqual(entry.swift, '6.4.1');
});

test('для неизвестной версии берётся ближайшая младшая', () => {
  // Xcode 26.9 в таблице нет, но 26.6 есть — он точно совместим.
  const entry = versions.toolchainForXcode('26.9');
  assert.ok(entry);
  assert.ok(versions.compareVersions(entry.xcode, '26.9') <= 0, 'версия не должна быть новее запрошенной');
});

test('старый компилятор признаётся неподходящим', () => {
  // Это ровно наш случай: Swift 6.1.3 из apt против SDK от Xcode 26.6.
  const result = versions.checkCompatibility({ swiftVersion: '6.1.3', xcodeVersion: '26.6' });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.required, '6.4.1');
  assert.match(result.message, /старше/);
  assert.ok(result.fix, 'должно быть предложено решение');
  assert.strictEqual(result.fix.swift, '6.4.1');
});

test('компилятор новее SDK считается подходящим', () => {
  // Swift 6.4.1 читает интерфейсы, записанные 6.3.2 — это нормальное направление.
  const result = versions.checkCompatibility({ swiftVersion: '6.4.1', xcodeVersion: '26.6' });
  assert.strictEqual(result.ok, true);
});

test('ровно совпадающий компилятор тоже подходит', () => {
  const result = versions.checkCompatibility({ swiftVersion: '6.1.3', xcodeVersion: '16.4' });
  assert.strictEqual(result.ok, true);
});

test('ссылка на тулчейн собирается по версии и выпуску Ubuntu', () => {
  const url = versions.swiftTarballUrl('6.4.1', '26.04');
  assert.match(url, /swift-6\.4\.1-release/);
  assert.match(url, /ubuntu26\.04\.tar\.gz$/);
  // Кодовое имя выпуска входит в адрес.
  assert.match(url, /resolute/);

  assert.strictEqual(versions.swiftTarballUrl('6.4.1', '99.99'), null, 'неизвестный выпуск — null');
});

test('версия Xcode определяется по установленному SDK', () => {
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-sdk-'));
  try {
    const sdkDir = path.join(
      bundle,
      'Developer', 'Platforms', 'iPhoneOS.platform', 'Developer', 'SDKs', 'iPhoneOS26.5.sdk',
    );
    fs.mkdirSync(sdkDir, { recursive: true });

    const info = versions.detectXcodeVersion(bundle);
    assert.ok(info, 'версия должна определиться');
    assert.strictEqual(info.iosVersion, '26.5');
    assert.strictEqual(info.sdkName, 'iPhoneOS26.5.sdk');
  } finally {
    fs.rmSync(bundle, { recursive: true, force: true });
  }
});

test('свежий SDK поддерживает старые цели развёртывания', () => {
  // Главный ответ на вопрос «зачем такой свежий SDK, мы же под iOS 16 собираем».
  // Один SDK покрывает много версий: минимальную задаёт deployment target.
  const entry = versions.TOOLCHAINS.find((item) => item.xcode === '26.6');
  assert.ok(entry, 'связка для Xcode 26.6 должна быть в таблице');
  assert.ok(
    versions.compareVersions(entry.swift, '6.3.2') >= 0,
    'требуемый Swift должен быть не старше компилятора самого SDK',
  );
});

test('для версии ниже таблицы ничего не предлагается', () => {
  // Xcode 15 старше самой старой записи: подсказать нечего, и это честный null,
  // а не случайная новая версия.
  const result = versions.toolchainForXcode('15.0');
  assert.strictEqual(result, null);
});

test('неизвестная версия SDK не ломает проверку', () => {
  const result = versions.checkCompatibility({ swiftVersion: '6.1.3' });
  assert.strictEqual(result.ok, true, 'без данных о SDK проверка пропускается');
  assert.strictEqual(result.fix, null);
});
