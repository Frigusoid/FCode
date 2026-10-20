'use strict';
/*
 * Генерация настоящего .xcodeproj из SwiftPM-проекта.
 *
 * Зачем. xtool собирает SwiftPM и на Linux не умеет обратное —
 * `xtool dev generate-xcode-project` там «does nothing». Но если человек потом
 * захочет открыть проект в Xcode на Mac (или отдать другому), папки Sources и
 * Package.swift недостаточно: Xcode ждёт .xcodeproj.
 *
 * Здесь собирается современный формат Xcode 16: файлы не перечисляются
 * поштучно, а подключается синхронизированная группа
 * (PBXFileSystemSynchronizedRootGroup) — Xcode сам подхватывает всё, что лежит
 * в папке. Это короче и меньше ломается при добавлении файлов.
 *
 * Формат project.pbxproj — старый plist в стиле NeXTSTEP, не XML. Поэтому
 * строки с дефисами и пробелами берём в кавычки, а идентификаторы объектов
 * делаем 24-символьными шестнадцатеричными, как это делает сам Xcode.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Настройки, общие для проекта. */
const PROJECT_SETTINGS = {
  ALWAYS_SEARCH_USER_PATHS: 'NO',
  CLANG_ENABLE_MODULES: 'YES',
  CLANG_ENABLE_OBJC_ARC: 'YES',
  COPY_PHASE_STRIP: 'NO',
  ENABLE_STRICT_OBJC_MSGSEND: 'YES',
  GCC_C_LANGUAGE_STANDARD: 'gnu17',
  GCC_NO_COMMON_BLOCKS: 'YES',
  CLANG_WARN_DOCUMENTATION_COMMENTS: 'YES',
  CLANG_WARN_UNGUARDED_AVAILABILITY: 'YES_AGGRESSIVE',
  DEBUG_INFORMATION_FORMAT: 'dwarf',
  ENABLE_TESTABILITY: 'YES',
  GCC_OPTIMIZATION_LEVEL: '0',
  MTL_ENABLE_DEBUG_INFO: 'INCLUDE_SOURCE',
  ONLY_ACTIVE_ARCH: 'YES',
  SWIFT_ACTIVE_COMPILATION_CONDITIONS: 'DEBUG',
  SWIFT_OPTIMIZATION_LEVEL: '-Onone',
};

/** Настройки цели: то, из чего Xcode делает приложение. */
function targetSettings(options, release) {
  const base = {
    ASSETCATALOG_COMPILER_APPICON_NAME: options.iconName || 'AppIcon',
    CODE_SIGN_STYLE: 'Automatic',
    CURRENT_PROJECT_VERSION: '1',
    DEVELOPMENT_TEAM: options.teamId || '',
    INFOPLIST_KEY_UIApplicationSceneManifest_Generation: 'YES',
    INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents: 'YES',
    INFOPLIST_KEY_UILaunchScreen_Generation: 'YES',
    INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad:
      '"UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"',
    INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone:
      '"UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"',
    IPHONEOS_DEPLOYMENT_TARGET: String(options.iosVersion || '17.0'),
    MARKETING_VERSION: options.version || '1.0',
    PRODUCT_BUNDLE_IDENTIFIER: options.bundleId,
    PRODUCT_NAME: '"$(TARGET_NAME)"',
    SWIFT_EMIT_LOC_STRINGS: 'YES',
    SWIFT_VERSION: '5.0',
    TARGETED_DEVICE_FAMILY: '"1,2"',
  };

  if (options.infoPlist) {
    // Если у проекта есть свой Info.plist (URL-схемы, типы файлов, доступ к
    // документам), Xcode должен взять именно его. Синтезированный plist эти
    // ключи не воспроизводит, а INFOPLIST_KEY_* с чужим файлом конфликтуют.
    base.INFOPLIST_FILE = options.infoPlist;
  } else {
    base.GENERATE_INFOPLIST_FILE = 'YES';
  }

  if (release) {
    Object.assign(base, {
      DEBUG_INFORMATION_FORMAT: '"dwarf-with-dsym"',
      ENABLE_NS_ASSERTIONS: 'NO',
      SWIFT_COMPILATION_MODE: 'wholemodule',
      VALIDATE_PRODUCT: 'YES',
    });
  }

  return base;
}

/** Значение настройки в синтаксисе pbxproj. */
function formatSetting(value) {
  const text = String(value);
  if (text === '') return '""';
  // Уже в кавычках или простое слово — оставляем как есть.
  if (text.startsWith('"') || /^[A-Za-z0-9_.$()/]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

/** Блок настроек. */
function renderSettings(settings, indent = '\t\t\t\t') {
  return Object.entries(settings)
    .map(([key, value]) => `${indent}${key} = ${formatSetting(value)};`)
    .join('\n');
}

/** Список идентификаторов в формате pbxproj. */
function idList(ids) {
  return ids.map((id) => `\t\t\t\t${id},`).join('\n');
}

/**
 * Сгенерировать идентификатор объекта: 24 hex-символа.
 */
function makeId(seed, index) {
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha1').update(`${seed}:${index}`).digest('hex');
  return hash.slice(0, 24).toUpperCase();
}

/**
 * Объекты зависимостей SwiftPM.
 *
 * Без них проект откроется, но не соберётся: код импортирует, например,
 * `Dynamic` и `CachedAsyncImage`. Удалённый пакет описываем как
 * XCRemoteSwiftPackageReference, локальный — как XCLocalSwiftPackageReference,
 * а сами продукты подключаем к цели через XCSwiftPackageProductDependency.
 *
 * @param {Array<{kind: string, url?: string, path?: string, version?: string, product: string}>} packages
 * @param {{seed: string, targetId: string}} ids
 */
function buildPackageSections(packages, ids) {
  const remote = [];
  const local = [];
  const products = [];
  const references = [];
  let counter = 100;

  for (const pkg of packages || []) {
    const isLocal = pkg.kind === 'local';
    const refId = makeId(ids.seed, counter++);
    references.push(refId);

    if (isLocal) {
      local.push(
        `\t\t${refId} /* XCLocalSwiftPackageReference "${pkg.path}" */ = {\n` +
        `\t\t\tisa = XCLocalSwiftPackageReference;\n` +
        `\t\t\trelativePath = ${pkg.path};\n` +
        `\t\t};`,
      );
    } else {
      local.push(
        `\t\t${refId} /* XCRemoteSwiftPackageReference "${pkg.url}" */ = {\n` +
        `\t\t\tisa = XCRemoteSwiftPackageReference;\n` +
        `\t\t\trepositoryURL = "${pkg.url}";\n` +
        `\t\t\trequirement = {\n` +
        `\t\t\t\tkind = upToNextMajorVersion;\n` +
        `\t\t\t\tminimumVersion = ${pkg.version || '1.0.0'};\n` +
        `\t\t\t};\n` +
        `\t\t};`,
      );
    }

    if (!pkg.product) continue;

    const productId = makeId(ids.seed, counter++);
    products.push(
      `\t\t${productId} /* ${pkg.product} */ = {\n` +
      `\t\t\tisa = XCSwiftPackageProductDependency;\n` +
      `\t\t\tpackage = ${refId};\n` +
      `\t\t\tproductName = ${pkg.product};\n` +
      `\t\t};`,
    );
  }

  let objects = '';
  if (local.length) {
    objects += `/* Begin XCLocalSwiftPackageReference section */\n${local.join('\n')}\n/* End XCLocalSwiftPackageReference section */\n\n`;
  }
  if (products.length) {
    objects += `/* Begin XCSwiftPackageProductDependency section */\n${products.join('\n')}\n/* End XCSwiftPackageProductDependency section */\n\n`;
  }

  const productIds = [];
  for (const entry of products) {
    const match = /^\t\t([0-9A-F]{24}) /.exec(entry);
    if (match) productIds.push(match[1]);
  }

  return { objects, references, productIds };
}


/**
 * Собрать текст project.pbxproj.
 *
 * @param {{name: string, sourceDir: string, bundleId: string,
 *          iosVersion?: string|number, version?: string, teamId?: string,
 *          iconName?: string}} options
 * @returns {string}
 */
function buildPbxproj(options) {
  const name = options.name;
  const sourceDir = options.sourceDir || 'Sources';
  const seed = `${name}:${options.bundleId}`;

  const ids = {
    syncGroup: makeId(seed, 1),
    frameworks: makeId(seed, 2),
    mainGroup: makeId(seed, 3),
    productsGroup: makeId(seed, 4),
    target: makeId(seed, 5),
    targetConfigs: makeId(seed, 6),
    sources: makeId(seed, 7),
    resources: makeId(seed, 8),
    productRef: makeId(seed, 9),
    project: makeId(seed, 10),
    projectConfigs: makeId(seed, 11),
    projectDebug: makeId(seed, 12),
    projectRelease: makeId(seed, 13),
    targetDebug: makeId(seed, 14),
    targetRelease: makeId(seed, 15),
  };

  const debugProject = {
    ...PROJECT_SETTINGS,
    SDKROOT: 'iphoneos',
    SWIFT_VERSION: '5.0',
  };
  const releaseProject = {
    ...PROJECT_SETTINGS,
    SDKROOT: 'iphoneos',
    SWIFT_VERSION: '5.0',
    DEBUG_INFORMATION_FORMAT: '"dwarf-with-dsym"',
    ENABLE_NS_ASSERTIONS: 'NO',
    MTL_ENABLE_DEBUG_INFO: 'NO',
    SWIFT_COMPILATION_MODE: 'wholemodule',
    VALIDATE_PRODUCT: 'YES',
    GCC_OPTIMIZATION_LEVEL: 's',
    SWIFT_OPTIMIZATION_LEVEL: '-O',
    ONLY_ACTIVE_ARCH: 'NO',
  };

  // Зависимости: без них проект не соберётся, хотя и откроется.
  const packages = buildPackageSections(options.packages, { seed, targetId: ids.target });
  const packageProductList = packages.productIds.length
    ? packages.productIds.map((id) => `\t\t\t\t${id},`).join('\n')
    : '';
  const packageReferenceList = packages.references.length
    ? packages.references.map((id) => `\t\t\t\t${id},`).join('\n')
    : '';

  // Дополнительные папки с исходниками (скачанные зависимости). Xcode
  // подхватывает их как синхронизированные группы, без перечисления файлов.
  const extras = (options.extraGroups || []).map((group, index) => ({
    id: makeId(seed, 200 + index),
    name: group.name || path.basename(group.path),
    path: group.path,
  }));
  const extraGroupObjects = extras
    .map(
      (group) =>
        `\t\t${group.id} /* ${group.name} */ = {\n` +
        `\t\t\tisa = PBXFileSystemSynchronizedRootGroup;\n` +
        `\t\t\tpath = ${group.path};\n` +
        `\t\t\tsourceTree = "<group>";\n` +
        `\t\t};`,
    )
    .join('\n');
  const mainGroupChildren = [
    `\t\t\t\t${ids.syncGroup} /* ${name} */,`,
    ...extras.map((group) => `\t\t\t\t${group.id} /* ${group.name} */,`),
    `\t\t\t\t${ids.productsGroup} /* Products */,`,
  ].join('\n');
  const targetGroups = [
    `\t\t\t\t${ids.syncGroup} /* ${name} */,`,
    ...extras.map((group) => `\t\t\t\t${group.id} /* ${group.name} */,`),
  ].join('\n');

  return `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 77;
	objects = {

/* Begin PBXFileReference section */
		${ids.productRef} /* ${name}.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = ${name}.app; sourceTree = BUILT_PRODUCTS_DIR; };
/* End PBXFileReference section */

/* Begin PBXFileSystemSynchronizedRootGroup section */
		${ids.syncGroup} /* ${name} */ = {
			isa = PBXFileSystemSynchronizedRootGroup;
			path = ${sourceDir};
			sourceTree = "<group>";
		};
${extraGroupObjects}
/* End PBXFileSystemSynchronizedRootGroup section */

/* Begin PBXFrameworksBuildPhase section */
		${ids.frameworks} /* Frameworks */ = {
			isa = PBXFrameworksBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
		${ids.mainGroup} = {
			isa = PBXGroup;
			children = (
${mainGroupChildren}
			);
			sourceTree = "<group>";
		};
		${ids.productsGroup} /* Products */ = {
			isa = PBXGroup;
			children = (
				${ids.productRef} /* ${name}.app */,
			);
			name = Products;
			sourceTree = "<group>";
		};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		${ids.target} /* ${name} */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = ${ids.targetConfigs} /* Build configuration list for PBXNativeTarget "${name}" */;
			buildPhases = (
				${ids.sources} /* Sources */,
				${ids.frameworks} /* Frameworks */,
				${ids.resources} /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			fileSystemSynchronizedGroups = (
${targetGroups}
			);
			name = ${name};
			packageProductDependencies = (
${packageProductList}
			);
			productName = ${name};
			productReference = ${ids.productRef} /* ${name}.app */;
			productType = "com.apple.product-type.application";
		};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		${ids.project} /* Project object */ = {
			isa = PBXProject;
			attributes = {
				BuildIndependentTargetsInParallel = 1;
				LastSwiftUpdateCheck = 1600;
				LastUpgradeCheck = 1600;
				TargetAttributes = {
					${ids.target} = {
						CreatedOnToolsVersion = 16.0;
					};
				};
			};
			buildConfigurationList = ${ids.projectConfigs} /* Build configuration list for PBXProject "${name}" */;
			compatibilityVersion = "Xcode 15.0";
			developmentRegion = en;
			hasScannedForEncodings = 0;
			knownRegions = (
				en,
				Base,
			);
			mainGroup = ${ids.mainGroup};
			minimizedProjectReferenceProxies = 1;
			preferredProjectObjectVersion = 77;
			packageReferences = (
${packageReferenceList}
			);
			productRefGroup = ${ids.productsGroup} /* Products */;
			projectDirPath = "";
			projectRoot = "";
			targets = (
				${ids.target} /* ${name} */,
			);
		};
/* End PBXProject section */

${packages.objects}
/* Begin PBXResourcesBuildPhase section */
		${ids.resources} /* Resources */ = {
			isa = PBXResourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
		${ids.sources} /* Sources */ = {
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
		${ids.projectDebug} /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
${renderSettings(debugProject)}
			};
			name = Debug;
		};
		${ids.projectRelease} /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
${renderSettings(releaseProject)}
			};
			name = Release;
		};
		${ids.targetDebug} /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
${renderSettings(targetSettings(options, false))}
			};
			name = Debug;
		};
		${ids.targetRelease} /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
${renderSettings(targetSettings(options, true))}
			};
			name = Release;
		};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		${ids.projectConfigs} /* Build configuration list for PBXProject "${name}" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				${ids.projectDebug} /* Debug */,
				${ids.projectRelease} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
		${ids.targetConfigs} /* Build configuration list for PBXNativeTarget "${name}" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				${ids.targetDebug} /* Debug */,
				${ids.targetRelease} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
/* End XCConfigurationList section */
	};
	rootObject = ${ids.project} /* Project object */;
}
`;
}

/** Содержимое project.xcworkspace — Xcode создаёт его сам, но пусть будет. */
const WORKSPACE_DATA = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace
   version = "1.0">
   <FileRef
      location = "self:">
   </FileRef>
</Workspace>
`;

/**
 * Создать .xcodeproj рядом с SwiftPM-проектом.
 *
 * Существующий проект не перезаписываем без разрешения: в нём могут быть
 * ручные настройки, которые мы не воспроизведём.
 *
 * @param {string} projectPath папка проекта
 * @param {{name?: string, sourceDir?: string, bundleId?: string,
 *          iosVersion?: string|number, version?: string, teamId?: string,
 *          infoPlist?: string, overwrite?: boolean}} options
 */
function generate(projectPath, options = {}) {
  const root = path.resolve(projectPath);
  if (!fs.existsSync(root)) throw new Error(`Папка не найдена: ${root}`);

  const name = options.name || path.basename(root).replace(/[^\w.-]/g, '_');
  const bundleId = options.bundleId || `com.example.${name.toLowerCase().replace(/[^\w]/g, '')}`;

  // Папка с исходниками: Sources/<цель> либо просто Sources.
  let sourceDir = options.sourceDir;
  if (!sourceDir) {
    const sources = path.join(root, 'Sources');
    if (fs.existsSync(sources)) {
      const children = fs.readdirSync(sources, { withFileTypes: true }).filter((e) => e.isDirectory());
      sourceDir = children.length === 1 ? `Sources/${children[0].name}` : 'Sources';
    } else {
      sourceDir = '.';
    }
  }

  const bundlePath = path.join(root, `${name}.xcodeproj`);
  if (fs.existsSync(bundlePath) && !options.overwrite) {
    throw new Error(`${name}.xcodeproj уже существует — включите перезапись`);
  }

  fs.mkdirSync(bundlePath, { recursive: true });
  const pbxproj = buildPbxproj({
    name,
    sourceDir,
    bundleId,
    iosVersion: options.iosVersion,
    version: options.version,
    teamId: options.teamId,
    iconName: options.iconName,
    infoPlist: options.infoPlist,
    packages: options.packages,
    extraGroups: options.extraGroups,
  });

  fs.writeFileSync(path.join(bundlePath, 'project.pbxproj'), pbxproj, 'utf8');

  // Xcode открывает .xcodeproj и без workspace, но с ним меньше сюрпризов.
  const workspaceDir = path.join(bundlePath, 'project.xcworkspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'contents.xcworkspacedata'), WORKSPACE_DATA, 'utf8');

  return {
    ok: true,
    path: bundlePath,
    name,
    sourceDir,
    bundleId,
  };
}

module.exports = { generate, buildPbxproj, targetSettings, PROJECT_SETTINGS };
