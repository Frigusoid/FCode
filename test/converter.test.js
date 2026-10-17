'use strict';
/*
 * Проверки конвертера Xcode → SwiftPM.
 *
 * Настоящий проект Xcode в репозиторий не положить, поэтому создаём маленький
 * макет: .xcodeproj с pbxproj, исходники, ресурсы и вложенный пакет. Проверяем
 * то, на чём конвертер спотыкался на живом проекте Pocket Poster.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const converter = require('../src/main/modules/converter');

/** Собрать макет проекта Xcode во временной папке. */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-conv-'));

  // project.pbxproj — минимальный, но с теми полями, что читает xcode.js.
  const projDir = path.join(root, 'Demo.xcodeproj');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, 'project.pbxproj'),
    `// !$*UTF8*$!
{
	archiveVersion = 1;
	objectVersion = 77;
	objects = {
/* Begin PBXFileSystemSynchronizedRootGroup section */
		AA0001 /* Demo */ = {isa = PBXFileSystemSynchronizedRootGroup; path = Demo; };
/* End PBXFileSystemSynchronizedRootGroup section */
/* Begin XCBuildConfiguration section */
		BB0001 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				PRODUCT_BUNDLE_IDENTIFIER = "com.example.Demo";
				IPHONEOS_DEPLOYMENT_TARGET = 17.0;
				MARKETING_VERSION = 1.0;
			};
			name = Debug;
		};
/* End XCBuildConfiguration section */
	};
	rootObject = CC0001;
}
`,
    'utf8',
  );

  // Исходники цели.
  const src = path.join(root, 'Demo');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, 'App.swift'),
    'import SwiftUI\n\n@main\nstruct DemoApp: App { var body: some Scene { WindowGroup { Text("Hi") } } }\n',
    'utf8',
  );
  // Файл с #Preview — конвертер обязан его срезать.
  fs.writeFileSync(
    path.join(src, 'Card.swift'),
    'import SwiftUI\n\nstruct Card: View { var body: some View { Text("card") } }\n\n#Preview {\n    Card()\n}\n',
    'utf8',
  );

  // Ресурсы в корне проекта.
  fs.writeFileSync(path.join(root, 'Localizable.xcstrings'), '{"sourceLanguage":"en"}', 'utf8');
  fs.mkdirSync(path.join(root, 'Assets.xcassets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Assets.xcassets', 'Contents.json'), '{}', 'utf8');

  // Вложенный пакет — должен стать локальной целью.
  const nested = path.join(root, 'Packages', 'Helper');
  fs.mkdirSync(path.join(nested, 'Sources'), { recursive: true });
  fs.writeFileSync(
    path.join(nested, 'Package.swift'),
    '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "Helper")\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(nested, 'Sources', 'Helper.swift'),
    'import Foundation\npublic struct Helper { public init() {} }\n',
    'utf8',
  );

  return root;
}

test('находит проект Xcode и понимает, что он не сконвертирован', () => {
  const root = makeProject();
  assert.strictEqual(converter.isXcodeProject(root), true);
  assert.strictEqual(converter.isConverted(root), false);
});

test('конвертация переносит исходники и ресурсы', () => {
  const root = makeProject();
  const result = converter.convert(root, { overwrite: true });

  assert.strictEqual(result.ok, true);

  const sources = path.join(result.outputDir, 'Sources', result.moduleName);
  assert.ok(fs.existsSync(path.join(sources, 'App.swift')), 'нет App.swift');
  assert.ok(fs.existsSync(path.join(sources, 'Card.swift')), 'нет Card.swift');
  assert.ok(fs.existsSync(path.join(sources, 'Localizable.xcstrings')), 'нет строк локализации');
  assert.ok(fs.existsSync(path.join(sources, 'Assets.xcassets')), 'нет каталога ресурсов');
});

test('конвертация создаёт манифест и настройки xtool', () => {
  const root = makeProject();
  const result = converter.convert(root, { overwrite: true });

  const manifest = fs.readFileSync(path.join(result.outputDir, 'Package.swift'), 'utf8');
  const yml = fs.readFileSync(path.join(result.outputDir, 'xtool.yml'), 'utf8');

  assert.match(manifest, /swift-tools-version:/);
  assert.match(manifest, /\.library\(/, 'xtool требует библиотечный продукт');
  assert.match(manifest, /swiftLanguageMode\(\.v5\)/, 'нужен языковой режим Swift 5');
  assert.match(yml, /bundleID:/);
});

test('срезает блоки #Preview — их нет в SwiftPM', () => {
  const root = makeProject();
  const result = converter.convert(root, { overwrite: true });

  const card = fs.readFileSync(
    path.join(result.outputDir, 'Sources', result.moduleName, 'Card.swift'),
    'utf8',
  );
  assert.doesNotMatch(card, /#Preview/, 'блок #Preview остался');
  assert.match(card, /struct Card/, 'сама структура пропала');
});

test('вложенный пакет становится локальной целью', () => {
  const root = makeProject();
  const result = converter.convert(root, { overwrite: true });

  assert.deepStrictEqual(result.nestedPackages, ['Helper']);

  const manifest = fs.readFileSync(path.join(result.outputDir, 'Package.swift'), 'utf8');
  assert.match(manifest, /name: "Helper"/, 'нет цели Helper');
  assert.match(manifest, /"Helper",/, 'Helper не подключён к приложению');

  const helper = path.join(result.outputDir, 'Vendor', 'Helper', 'Helper.swift');
  assert.ok(fs.existsSync(helper), 'исходник вложенного пакета не перенесён');
});

test('исходный проект не изменяется', () => {
  const root = makeProject();
  const before = fs.readFileSync(path.join(root, 'Demo', 'Card.swift'), 'utf8');

  converter.convert(root, { overwrite: true });

  const after = fs.readFileSync(path.join(root, 'Demo', 'Card.swift'), 'utf8');
  assert.strictEqual(after, before, 'конвертер испортил исходный файл');
});

test('повторная конвертация без перезаписи отклоняется', () => {
  const root = makeProject();
  converter.convert(root, { overwrite: true });

  assert.throws(
    () => converter.convert(root, { overwrite: false }),
    /уже сконвертирован/,
  );
});

test('ensureImport добавляет импорт только когда он нужен', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-imp-'));
  const file = path.join(dir, 'View.swift');
  fs.writeFileSync(file, 'import SwiftUI\n\nlet x = GIFImage()\n', 'utf8');

  assert.strictEqual(converter.ensureImport(file, 'GIFImage'), true);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /import GIFImage/);
  // Импорт встал после последнего import, а не в середину кода.
  assert.ok(text.indexOf('import GIFImage') < text.indexOf('let x'));

  // Второй раз ничего не делает.
  assert.strictEqual(converter.ensureImport(file, 'GIFImage'), false);
});

test('findNestedPackages находит пакеты в Packages/', () => {
  const root = makeProject();
  const found = converter.findNestedPackages(root);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].name, 'Helper');
});

test('не считает обычную папку проектом Xcode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-plain-'));
  assert.strictEqual(converter.isXcodeProject(dir), false);
});
