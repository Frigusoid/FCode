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

test('переносит Info.plist и ссылается на него в .xcodeproj', () => {
  const root = makeProject();
  // Xcode держит plist рядом с .xcodeproj, через дефис.
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleURLTypes</key>
  <array><dict><key>CFBundleURLSchemes</key><array><string>demo</string></array></dict></array>
</dict>
</plist>
`;
  fs.writeFileSync(path.join(root, 'Demo-Info.plist'), plist, 'utf8');

  const result = converter.convert(root, { overwrite: true });

  assert.strictEqual(result.infoPlist, 'Info.plist', 'plist должен быть перенесён');
  assert.match(fs.readFileSync(path.join(result.outputDir, 'Info.plist'), 'utf8'), /CFBundleURLSchemes/);

  const pbxproj = fs.readFileSync(path.join(result.outputDir, 'Demo.xcodeproj', 'project.pbxproj'), 'utf8');
  assert.match(pbxproj, /INFOPLIST_FILE = Info\.plist;/);
  assert.doesNotMatch(
    pbxproj,
    /GENERATE_INFOPLIST_FILE/,
    'синтезированный plist отключён, иначе настройки конфликтуют',
  );
});

test('ZIPFoundation остаётся зависимостью, а не выбрасывается', () => {
  const root = makeProject();

  // Пакет в проекте Xcode.
  const projFile = path.join(root, 'Demo.xcodeproj', 'project.pbxproj');
  const original = fs.readFileSync(projFile, 'utf8');
  const withPackage = original.replace(
    '/* Begin XCBuildConfiguration section */',
    `/* Begin XCRemoteSwiftPackageReference section */
		EE0001 /* XCRemoteSwiftPackageReference "ZIPFoundation" */ = {
			isa = XCRemoteSwiftPackageReference;
			repositoryURL = "https://github.com/weichsel/ZIPFoundation";
			requirement = {
				kind = upToNextMajorVersion;
				minimumVersion = 0.9.19;
			};
		};
/* End XCRemoteSwiftPackageReference section */
/* Begin XCBuildConfiguration section */`,
  );
  fs.writeFileSync(projFile, withPackage, 'utf8');

  // Код действительно импортирует модуль - именно на этом проект и падал.
  fs.writeFileSync(
    path.join(root, 'Demo', 'Archive.swift'),
    'import Foundation\nimport ZIPFoundation\n\nstruct Archive { let url: URL }\n',
    'utf8',
  );

  const result = converter.convert(root, { overwrite: true });
  const manifest = fs.readFileSync(path.join(result.outputDir, 'Package.swift'), 'utf8');

  // Пакет с системной библиотекой переносится исходниками: его манифест
  // объявляет CZLib через pkgConfig, и при линковке под iOS подхватывалась
  // линуксовая libz.so, на которой ld64.lld падал с «unhandled file type».
  assert.doesNotMatch(
    manifest,
    /\.package\(url: "https:\/\/github\.com\/weichsel\/ZIPFoundation"/,
    'пакет не должен подключаться как удалённый',
  );
  assert.match(
    manifest,
    /name: "ZIPFoundation",\s*\n\s*path: "Vendor\/ZIPFoundation"/,
    'должна появиться локальная цель из исходников',
  );
  assert.match(manifest, /^\s+"ZIPFoundation",$/m, 'цель приложения должна зависеть от неё');
  // libz подключается линкером — без него ZIPFoundation не соберётся.
  assert.match(manifest, /linkedLibrary\("z"\)/);
});

test('папка из Packages без манифеста попадает в цель приложения', () => {
  const root = makeProject();

  // Xcode держит такую папку в составе цели: манифеста у неё нет.
  const extra = path.join(root, 'Demo', 'Packages', 'GIFImage', 'Sources');
  fs.mkdirSync(extra, { recursive: true });
  fs.writeFileSync(path.join(extra, 'GIFImage.swift'), 'import SwiftUI\n\nstruct GIFImage: View { var body: some View { EmptyView() } }\n', 'utf8');

  const result = converter.convert(root, { overwrite: true });
  const target = path.join(result.outputDir, 'Sources', result.moduleName);

  assert.ok(
    fs.existsSync(path.join(target, 'GIFImage', 'GIFImage.swift')),
    'файлы папки должны компилироваться в составе цели',
  );
  assert.ok(
    !fs.existsSync(path.join(target, 'Packages')),
    'саму папку Packages переносить не нужно',
  );
});

test('находит повторное объявление в одной функции', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-dup-'));
  const file = path.join(dir, 'Sample.swift');

  fs.writeFileSync(
    file,
    `struct A {
    func run() {
        let url = first()
        work(url)
        let url = second()
        use(url)
    }
}
`,
    'utf8',
  );

  const duplicates = converter.findDuplicateDeclarations(file);
  assert.strictEqual(duplicates.length, 1);
  assert.deepStrictEqual(duplicates[0], { name: 'url', firstLine: 3, secondLine: 5 });
});

test('одноимённые переменные в разных функциях — не конфликт', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-dup-'));
  const file = path.join(dir, 'Sample.swift');

  fs.writeFileSync(
    file,
    `struct A {
    func one() {
        let url = first()
    }

    func two() {
        let url = second()
    }
}
`,
    'utf8',
  );

  assert.deepStrictEqual(converter.findDuplicateDeclarations(file), []);
});

test('вложенный блок не конфликтует с внешним', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-dup-'));
  const file = path.join(dir, 'Sample.swift');

  fs.writeFileSync(
    file,
    `func run() {
    let url = first()
    if condition {
        let url = second()
        use(url)
    }
    use(url)
}
`,
    'utf8',
  );

  assert.deepStrictEqual(converter.findDuplicateDeclarations(file), []);
});

test('ZIPFoundation помечен как пакет с системной библиотекой', () => {
  assert.ok(converter.SYSTEM_LIBRARY_PACKAGES.includes('zipfoundation'));
});
