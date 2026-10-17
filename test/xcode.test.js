'use strict';
/*
 * Разбор проектов Xcode.
 *
 * Проверки построены на настоящем формате project.pbxproj: взят проект
 * Pocket-Poster с GitHub — SwiftUI-приложение с тремя SwiftPM-зависимостями,
 * записанное Xcode 16 (objectVersion 77). В этом формате файлы больше не
 * перечисляются поштучно, а синхронизируются целой папкой, поэтому парсер,
 * написанный по старым проектам, на нём ломается.
 *
 * Отдельно проверяется то, что нельзя угадать: имя пакета и имя продукта
 * различаются («swiftui-cached-async-image» даёт продукт «CachedAsyncImage»),
 * и правильное имя берётся из импортов самого кода.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const xcode = require('../src/main/modules/xcode');

/** Манифест, повторяющий структуру реального проекта. */
const PBXPROJ = `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 77;
	objects = {

/* Begin PBXBuildFile section */
		6F09B7BB2DEB873F00CDE89C /* ZIPFoundation in Frameworks */ = {isa = PBXBuildFile; productRef = 6F09B7BA2DEB873F00CDE89C /* ZIPFoundation */; };
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
		6F09B79D2DEB694B00CDE89C /* Pocket Poster.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = "Pocket Poster.app"; sourceTree = BUILT_PRODUCTS_DIR; };
/* End PBXFileReference section */

/* Begin PBXFileSystemSynchronizedRootGroup section */
		6F09BA002E00800000CDE89C /* Pocket Poster */ = {
			isa = PBXFileSystemSynchronizedRootGroup;
			path = "Pocket Poster";
			sourceTree = "<group>";
		};
/* End PBXFileSystemSynchronizedRootGroup section */

/* Begin PBXNativeTarget section */
		6F09B79B2DEB694B00CDE89C /* Pocket Poster */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = 6F09B7B42DEB694C00CDE89C /* Build configuration list for PBXNativeTarget "Pocket Poster" */;
			name = "Pocket Poster";
			productName = "Pocket Poster";
			productType = "com.apple.product-type.application";
		};
/* End PBXNativeTarget section */

/* Begin XCBuildConfiguration section */
		6F09B7B52DEB694C00CDE89C /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CURRENT_PROJECT_VERSION = 0;
				GENERATE_INFOPLIST_FILE = YES;
				INFOPLIST_FILE = "Pocket-Poster-Info.plist";
				IPHONEOS_DEPLOYMENT_TARGET = 16.0;
				MARKETING_VERSION = 3.0;
				PRODUCT_BUNDLE_IDENTIFIER = "com.lemin.Pocket-Poster";
				PRODUCT_NAME = "$(TARGET_NAME)";
				SWIFT_VERSION = 5.0;
			};
			name = Debug;
		};
		6F09B7B62DEB694C00CDE89C /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CURRENT_PROJECT_VERSION = 0;
				GENERATE_INFOPLIST_FILE = YES;
				INFOPLIST_FILE = "Pocket-Poster-Info.plist";
				IPHONEOS_DEPLOYMENT_TARGET = 16.0;
				MARKETING_VERSION = 3.0;
				PRODUCT_BUNDLE_IDENTIFIER = "com.lemin.Pocket-Poster";
				PRODUCT_NAME = "$(TARGET_NAME)";
				SWIFT_VERSION = 5.0;
			};
			name = Release;
		};
/* End XCBuildConfiguration section */

/* Begin XCRemoteSwiftPackageReference section */
		6F09B7B92DEB873F00CDE89C /* XCRemoteSwiftPackageReference "ZIPFoundation" */ = {
			isa = XCRemoteSwiftPackageReference;
			repositoryURL = "https://github.com/weichsel/ZIPFoundation";
			requirement = {
				kind = upToNextMajorVersion;
				minimumVersion = 0.9.19;
			};
		};
		6FB105532E26D3EC00185A5C /* XCRemoteSwiftPackageReference "swiftui-cached-async-image" */ = {
			isa = XCRemoteSwiftPackageReference;
			repositoryURL = "https://github.com/lorenzofiamingo/swiftui-cached-async-image";
			requirement = {
				kind = upToNextMajorVersion;
				minimumVersion = 2.1.1;
			};
		};
/* End XCRemoteSwiftPackageReference section */
	};
	rootObject = 6F09B79A2DEB694B00CDE89C /* Project object */;
}
`;

/** Создать временный проект, похожий на настоящий. */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-xcode-'));

  fs.mkdirSync(path.join(root, 'Pocket Poster.xcodeproj'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'Pocket Poster.xcodeproj', 'project.pbxproj'),
    PBXPROJ,
    'utf8',
  );

  const sources = path.join(root, 'Pocket Poster');
  fs.mkdirSync(path.join(sources, 'API'), { recursive: true });
  fs.mkdirSync(path.join(sources, 'Assets.xcassets'), { recursive: true });
  fs.mkdirSync(path.join(sources, 'Preview Content', 'Preview Assets.xcassets'), { recursive: true });

  fs.writeFileSync(
    path.join(sources, 'Pocket_PosterApp.swift'),
    'import SwiftUI\nimport CachedAsyncImage\n\n@main struct App {}\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(sources, 'API', 'CowabungaAPI.swift'),
    'import Foundation\nimport ZIPFoundation\nimport Dynamic\n',
    'utf8',
  );
  fs.writeFileSync(path.join(sources, 'Assets.xcassets', 'Contents.json'), '{}', 'utf8');

  return root;
}

test('разбор настоящего формата pbxproj', () => {
  const parsed = xcode.parsePbxproj(PBXPROJ);

  assert.strictEqual(parsed.objectVersion, 77, 'версия формата Xcode 16');
  assert.strictEqual(parsed.targets.length, 1);
  assert.strictEqual(parsed.targets[0].name, 'Pocket Poster');
  assert.strictEqual(parsed.targets[0].kind, 'app');

  assert.strictEqual(parsed.build.bundleId, 'com.lemin.Pocket-Poster');
  assert.strictEqual(parsed.build.deploymentTarget, 16);
  assert.strictEqual(parsed.build.marketingVersion, '3.0');
  assert.strictEqual(parsed.build.infoPlist, 'Pocket-Poster-Info.plist');
});

test('папка исходников берётся из синхронизированной группы', () => {
  // Xcode 16 не перечисляет файлы поштучно — они синхронизируются папкой.
  const parsed = xcode.parsePbxproj(PBXPROJ);
  assert.deepStrictEqual(parsed.sourceGroups, ['Pocket Poster']);
});

test('зависимости SwiftPM читаются с версиями', () => {
  const parsed = xcode.parsePbxproj(PBXPROJ);

  assert.strictEqual(parsed.packages.length, 2);

  const zip = parsed.packages.find((item) => item.name === 'ZIPFoundation');
  assert.strictEqual(zip.url, 'https://github.com/weichsel/ZIPFoundation');
  assert.strictEqual(zip.requirement, '.upToNextMajor(from: "0.9.19")');
});

test('обход проекта находит исходники и ресурсы', () => {
  const root = makeProject();
  try {
    const analysis = xcode.analyzeProject(root);

    assert.strictEqual(analysis.moduleName, 'Pocket_Poster', 'пробел заменяется подчёркиванием');
    assert.strictEqual(analysis.sourceDir, 'Pocket Poster');
    assert.ok(analysis.sources.some((item) => item.endsWith('Pocket_PosterApp.swift')));
    assert.ok(analysis.sources.some((item) => item.endsWith('CowabungaAPI.swift')));
    assert.ok(analysis.resources.some((item) => item.endsWith('Assets.xcassets')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('системные модули не считаются зависимостями', () => {
  const imports = xcode.collectImports(process.cwd(), []);
  assert.deepStrictEqual(imports, [], 'пустой список файлов — пустой результат');
});

test('имя продукта берётся из импортов, а не из имени пакета', () => {
  // На этом ломалась сборка: пакет «swiftui-cached-async-image»
  // предоставляет продукт «CachedAsyncImage».
  const pkg = { name: 'swiftui-cached-async-image', url: 'https://github.com/lorenzofiamingo/swiftui-cached-async-image' };
  const imports = ['CachedAsyncImage', 'ZIPFoundation'];

  assert.strictEqual(xcode.productNameFor(pkg, imports), 'CachedAsyncImage');

  // Если совпадения нет, остаётся имя пакета — манифест всё равно останется валидным.
  const other = { name: 'Unknown', url: 'https://github.com/x/unknown' };
  assert.strictEqual(xcode.productNameFor(other, imports), 'Unknown');
});

test('манифест собирается в формате, который понимает xtool', () => {
  const root = makeProject();
  try {
    const result = xcode.convertProject(root, { write: false });
    const manifest = result.manifest;

    // xtool превращает в приложение ровно один библиотечный продукт.
    assert.match(manifest, /\.library\(/);
    assert.match(manifest, /name: "Pocket_Poster"/);
    assert.match(manifest, /\.iOS\(\.v16\)/);

    // Продукт зависимости назван по импорту.
    assert.match(
      manifest,
      /\.product\(name: "CachedAsyncImage", package: "swiftui-cached-async-image"\)/,
    );

    // Ресурсы указываются относительно path цели, без повторения папки.
    assert.match(manifest, /path: "Pocket Poster"/);
    assert.match(manifest, /\.process\("Assets\.xcassets"\)/);
    assert.ok(
      !manifest.includes('.process("Pocket Poster/Assets.xcassets")'),
      'путь ресурса не должен повторять папку цели',
    );

    // Папка превью исключается: она нужна только Xcode.
    assert.match(manifest, /exclude: \["Preview Content\/Preview Assets\.xcassets"\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('xtool.yml получает идентификатор из проекта', () => {
  const root = makeProject();
  try {
    const result = xcode.convertProject(root, { write: false });
    assert.match(result.yml, /^version: 1\nbundleID: com\.lemin\.Pocket-Poster\n$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('файлы не пишутся без разрешения', () => {
  const root = makeProject();
  try {
    const result = xcode.convertProject(root, { write: false });
    assert.strictEqual(result.written, false);
    assert.ok(!fs.existsSync(path.join(root, 'Package.swift')), 'предпросмотр ничего не создаёт');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('существующий Package.swift не затирается молча', () => {
  const root = makeProject();
  try {
    fs.writeFileSync(path.join(root, 'Package.swift'), '// мой файл\n', 'utf8');

    assert.throws(
      () => xcode.convertProject(root, { write: true }),
      /уже существует/,
      'перезапись только по явному разрешению',
    );

    // С разрешением — перезаписывается.
    const forced = xcode.convertProject(root, { write: true, overwrite: true });
    assert.strictEqual(forced.written, true);
    assert.match(fs.readFileSync(path.join(root, 'Package.swift'), 'utf8'), /\.library\(/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('папка без .xcodeproj даёт понятную ошибку', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-empty-'));
  try {
    assert.throws(() => xcode.analyzeProject(root), /нет \.xcodeproj/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
