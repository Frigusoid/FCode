'use strict';
/*
 * Проверки настроек проекта: чтение, запись, смена версии пакета.
 *
 * Настройки живут в двух файлах (xtool.yml и Package.swift), и ошибка в любом
 * из них ломает сборку, поэтому проверяем и значения, и то, что соседние
 * строки манифеста не пострадали.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const settings = require('../src/main/modules/project-settings');
const packages = require('../src/main/modules/packages');

const MANIFEST = `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Demo",
    platforms: [
        .iOS(.v17),
    ],
    dependencies: [
        .package(url: "https://github.com/mhdhejazi/Dynamic", from: "1.2.0"),
    ],
    targets: [
        .target(name: "Demo", path: "Sources/Demo"),
    ]
)
`;

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-settings-'));
  fs.writeFileSync(path.join(root, 'Package.swift'), MANIFEST, 'utf8');
  fs.writeFileSync(path.join(root, 'xtool.yml'), 'version: 1\nbundleID: com.example.demo\n', 'utf8');
  fs.mkdirSync(path.join(root, 'Sources', 'Demo'), { recursive: true });
  return root;
}

test('читает имя, bundle id и версию iOS', () => {
  const root = makeProject();
  const result = settings.read(root);

  assert.strictEqual(result.name, 'Demo');
  assert.strictEqual(result.bundleId, 'com.example.demo');
  assert.strictEqual(result.iosVersion, '17');
  assert.strictEqual(result.hasManifest, true);
  assert.strictEqual(result.hasConfig, true);
});

test('меняет bundle id в xtool.yml', () => {
  const root = makeProject();
  const result = settings.write(root, { bundleId: 'com.frigusoid.demo' });

  assert.deepStrictEqual(result.changed, ['bundleId']);
  assert.strictEqual(settings.read(root).bundleId, 'com.frigusoid.demo');

  const config = fs.readFileSync(path.join(root, 'xtool.yml'), 'utf8');
  assert.match(config, /^version: 1$/m, 'остальные строки не тронуты');
});

test('меняет имя и версию iOS в Package.swift', () => {
  const root = makeProject();
  const result = settings.write(root, { name: 'PocketDemo', iosVersion: '16.4' });

  assert.ok(result.changed.includes('name'));
  assert.ok(result.changed.includes('iosVersion'));

  const text = fs.readFileSync(path.join(root, 'Package.swift'), 'utf8');
  assert.match(text, /name: "PocketDemo"/);
  assert.match(text, /\.iOS\(\.v16\.4\)/);
  assert.strictEqual(packages.checkSyntax(text), null, 'файл должен остаться целым');
  // Чужие строки на месте.
  assert.match(text, /github\.com\/mhdhejazi\/Dynamic/);
});

test('сохраняет только переданные поля', () => {
  const root = makeProject();
  settings.write(root, { bundleId: 'com.new.id' });

  const after = settings.read(root);
  assert.strictEqual(after.name, 'Demo', 'имя не должно меняться');
  assert.strictEqual(after.iosVersion, '17', 'версия iOS не должна меняться');
});

test('не принимает мусор в версии iOS', () => {
  const root = makeProject();
  settings.write(root, { iosVersion: 'не число' });

  assert.strictEqual(settings.read(root).iosVersion, '17');
});

test('меняет версию подключённого пакета', () => {
  const root = makeProject();
  const result = packages.setVersion(root, {
    url: 'https://github.com/mhdhejazi/Dynamic',
    version: '2.0.0',
  });

  assert.strictEqual(result.packages[0].requirement.value, '2.0.0');

  const text = fs.readFileSync(path.join(root, 'Package.swift'), 'utf8');
  assert.match(text, /\.package\(url: "https:\/\/github\.com\/mhdhejazi\/Dynamic", \.from\("2\.0\.0"\)\)/);
  assert.strictEqual(packages.checkSyntax(text), null);
});

test('не меняет версию несуществующего пакета', () => {
  const root = makeProject();
  assert.throws(
    () => packages.setVersion(root, { url: 'https://github.com/no/such', version: '1.0.0' }),
    /не найден/,
  );
});
