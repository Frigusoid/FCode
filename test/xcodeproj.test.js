'use strict';
/*
 * Проверки генерации .xcodeproj.
 *
 * Xcode под рукой нет, поэтому проверяем две вещи, которые видно без Mac:
 *   1. структура pbxproj разбирается нашим же парсером (xcode.parsePbxproj);
 *   2. в настройках есть всё, без чего Xcode не соберёт приложение.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const xcodeproj = require('../src/main/modules/xcodeproj');
const xcode = require('../src/main/modules/xcode');

/** Макет SwiftPM-проекта. */
function makeSwiftProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-xcodeproj-'));
  fs.mkdirSync(path.join(root, 'Sources', 'Demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Sources', 'Demo', 'App.swift'), 'import SwiftUI\n', 'utf8');
  fs.writeFileSync(
    path.join(root, 'Package.swift'),
    '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "Demo")\n',
    'utf8',
  );
  return root;
}

test('создаёт .xcodeproj с project.pbxproj', () => {
  const root = makeSwiftProject();
  const result = xcodeproj.generate(root, { name: 'Demo', bundleId: 'com.example.demo' });

  assert.strictEqual(result.ok, true);
  assert.ok(fs.existsSync(path.join(result.path, 'project.pbxproj')));
  assert.ok(
    fs.existsSync(path.join(result.path, 'project.xcworkspace', 'contents.xcworkspacedata')),
    'workspace должен быть создан',
  );
});

test('pbxproj разбирается нашим парсером как проект Xcode', () => {
  const root = makeSwiftProject();
  const result = xcodeproj.generate(root, { name: 'Demo', bundleId: 'com.example.demo' });

  const analysis = xcode.analyzeProject(root);
  assert.strictEqual(analysis.projectName, 'Demo');
  assert.ok(analysis.target, 'цель должна найтись');
  assert.strictEqual(analysis.target.kind, 'app', 'тип цели — приложение');
  assert.match(analysis.build.bundleId || '', /com\.example\.demo/);
});

test('в настройках есть обязательные ключи', () => {
  const text = xcodeproj.buildPbxproj({
    name: 'Demo',
    sourceDir: 'Sources/Demo',
    bundleId: 'com.example.demo',
    iosVersion: '17.0',
  });

  for (const key of [
    'PRODUCT_BUNDLE_IDENTIFIER',
    'GENERATE_INFOPLIST_FILE',
    'IPHONEOS_DEPLOYMENT_TARGET',
    'SWIFT_VERSION',
    'TARGETED_DEVICE_FAMILY',
    'SDKROOT',
  ]) {
    assert.match(text, new RegExp(`${key} = `), `нет ${key}`);
  }

  // Приложение должно быть именно приложением, а не библиотекой.
  assert.match(text, /com\.apple\.product-type\.application/);
  // Современный формат: файлы подключаются синхронизированной группой.
  assert.match(text, /PBXFileSystemSynchronizedRootGroup/);
  assert.match(text, /fileSystemSynchronizedGroups/);
});

test('версия iOS и номер сборки попадают в настройки', () => {
  const text = xcodeproj.buildPbxproj({
    name: 'Demo',
    sourceDir: 'Sources/Demo',
    bundleId: 'com.example.demo',
    iosVersion: '18.0',
    version: '2.3',
  });

  assert.match(text, /IPHONEOS_DEPLOYMENT_TARGET = 18\.0;/);
  assert.match(text, /MARKETING_VERSION = 2\.3;/);
});

test('путь к исходникам определяется по папке Sources', () => {
  const root = makeSwiftProject();
  const result = xcodeproj.generate(root, { name: 'Demo', bundleId: 'com.example.demo' });
  assert.strictEqual(result.sourceDir, 'Sources/Demo');
});

test('существующий проект не перезаписывается без разрешения', () => {
  const root = makeSwiftProject();
  xcodeproj.generate(root, { name: 'Demo', bundleId: 'com.example.demo', overwrite: true });

  assert.throws(
    () => xcodeproj.generate(root, { name: 'Demo', bundleId: 'com.example.demo' }),
    /уже существует/,
  );
});

test('идентификаторы объектов уникальны и нужной длины', () => {
  const text = xcodeproj.buildPbxproj({
    name: 'Demo',
    sourceDir: 'Sources/Demo',
    bundleId: 'com.example.demo',
  });

  const ids = new Set();
  for (const match of text.matchAll(/^\t\t([0-9A-F]{24}) /gm)) {
    assert.strictEqual(match[1].length, 24);
    assert.strictEqual(ids.has(match[1]), false, `повтор идентификатора ${match[1]}`);
    ids.add(match[1]);
  }
  assert.ok(ids.size >= 10, `мало объектов: ${ids.size}`);
});

test('с Info.plist проект ссылается на файл, а не синтезирует его', () => {
  const withPlist = xcodeproj.buildPbxproj({
    name: 'Demo',
    sourceDir: 'Sources/Demo',
    bundleId: 'com.example.demo',
    infoPlist: 'Info.plist',
  });

  assert.match(withPlist, /INFOPLIST_FILE = Info\.plist;/);
  assert.doesNotMatch(withPlist, /GENERATE_INFOPLIST_FILE/);
});

test('без Info.plist Xcode синтезирует plist сам', () => {
  const without = xcodeproj.buildPbxproj({
    name: 'Demo',
    sourceDir: 'Sources/Demo',
    bundleId: 'com.example.demo',
  });

  assert.match(without, /GENERATE_INFOPLIST_FILE = YES;/);
  // Именно отдельный ключ: подстрока есть и внутри GENERATE_INFOPLIST_FILE.
  assert.doesNotMatch(without, /^\t+INFOPLIST_FILE = /m);
});

test('добавляет зависимости SwiftPM: удалённую и локальную', () => {
  const text = xcodeproj.buildPbxproj({
    name: 'Demo',
    sourceDir: 'Sources/Demo',
    bundleId: 'com.example.demo',
    packages: [
      { kind: 'remote', url: 'https://github.com/mhdhejazi/Dynamic', version: '1.2.0', product: 'Dynamic' },
      { kind: 'local', path: 'Vendor/CachedAsyncImage', product: 'CachedAsyncImage' },
    ],
  });

  assert.match(text, /packageReferences = \(/);
  assert.match(text, /XCRemoteSwiftPackageReference/);
  assert.match(text, /XCLocalSwiftPackageReference/);
  assert.match(text, /XCSwiftPackageProductDependency/);
  assert.match(text, /repositoryURL = "https:\/\/github\.com\/mhdhejazi\/Dynamic";/);
  assert.match(text, /minimumVersion = 1\.2\.0;/);
  assert.match(text, /relativePath = Vendor\/CachedAsyncImage;/);
  assert.match(text, /productName = Dynamic;/);
  assert.match(text, /productName = CachedAsyncImage;/);

  // Продукты должны быть подключены именно к цели, иначе Xcode их не увидит.
  const targetBlock = /packageProductDependencies = \(([^)]*)\);/.exec(text);
  assert.ok(targetBlock, 'нет списка продуктов у цели');
  assert.match(targetBlock[1], /[0-9A-F]{24}/);
});

test('без пакетов секции зависимостей не появляются', () => {
  const text = xcodeproj.buildPbxproj({
    name: 'Demo',
    sourceDir: 'Sources/Demo',
    bundleId: 'com.example.demo',
  });

  assert.doesNotMatch(text, /XCRemoteSwiftPackageReference/);
  assert.doesNotMatch(text, /XCSwiftPackageProductDependency/);
});

test('скобки сбалансированы при зависимостях', () => {
  const text = xcodeproj.buildPbxproj({
    name: 'Demo',
    sourceDir: 'Sources/Demo',
    bundleId: 'com.example.demo',
    packages: [{ kind: 'remote', url: 'https://github.com/a/b', version: '2.0.0', product: 'B' }],
  });

  const opens = (text.match(/\{/g) || []).length;
  const closes = (text.match(/\}/g) || []).length;
  assert.strictEqual(opens, closes);
});
