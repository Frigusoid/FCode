'use strict';
/*
 * Разбор проектов Xcode (.xcodeproj).
 *
 * Зачем это нужно. xtool собирает SwiftPM-пакеты, а не .xcodeproj: у него нет
 * и не может быть парсера формата Xcode. Поэтому проект с GitHub, где лежит
 * «Приложение.xcodeproj», для FCode выглядел как чужая папка.
 *
 * Здесь мы читаем project.pbxproj и переносим из него то, что нужно для сборки:
 * имя цели, идентификатор пакета, минимальную версию iOS, версию приложения,
 * список SwiftPM-зависимостей и папку с исходниками. Из этого собирается
 * Package.swift в том виде, который xtool понимает.
 *
 * Формат pbxproj — обычный список в стиле NeXTSTEP, но с двумя тонкостями:
 *
 * 1. Xcode 16 (objectVersion 77) больше не перечисляет файлы поштучно: он
 *    синхронизирует папку целиком через PBXFileSystemSynchronizedRootGroup.
 *    Поэтому исходники берём из группы, а не из PBXFileReference.
 *
 * 2. Значения могут быть в кавычках и содержать пробелы и дефисы —
 *    «PRODUCT_BUNDLE_IDENTIFIER = "com.lemin.Pocket-Poster"».
 *
 * Полноценный парсер plist здесь избыточен; разбор идёт по блокам isa с
 * сопоставлением фигурных скобок, чего для реальных проектов достаточно.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Расширения, которые считаются исходным кодом. */
const SOURCE_EXTENSIONS = new Set(['.swift', '.m', '.mm', '.c', '.cpp', '.h', '.hpp']);

/** Расширения ресурсов, которые SwiftPM умеет обрабатывать. */
const RESOURCE_EXTENSIONS = new Set([
  '.xcassets',
  '.storyboard',
  '.xib',
  '.xcstrings',
  '.strings',
  '.plist',
  '.json',
  '.png',
  '.jpg',
  '.jpeg',
  '.pdf',
  '.ttf',
  '.otf',
  '.mp3',
  '.wav',
  '.html',
  '.css',
  '.geojson',
]);

/**
 * Найти блоки вида `{ isa = <Тип>; ... }` с учётом вложенности скобок.
 * @param {string} text содержимое project.pbxproj
 * @param {string} isa тип объекта
 */
function findBlocks(text, isa) {
  const blocks = [];
  const pattern = new RegExp(`\\{\\s*isa = ${isa};`, 'g');
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const start = text.lastIndexOf('{', match.index + match[0].length);
    if (start === -1) continue;

    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;

    blocks.push({
      body: text.slice(start, end + 1),
      // Комментарий перед блоком обычно содержит человекочитаемое имя.
      label: (text.slice(Math.max(0, start - 160), start).match(/\/\*\s*(.+?)\s*\*\/\s*$/) || [])[1] || null,
    });
  }

  return blocks;
}

/** Достать значение настройки: поддерживает кавычки и пробелы. */
function readSetting(body, key) {
  const pattern = new RegExp(`\\b${key}\\s*=\\s*("([^"]*)"|([^;\\n]*));`);
  const match = pattern.exec(body);
  if (!match) return null;
  const value = match[2] !== undefined ? match[2] : match[3];
  return value === undefined ? null : value.trim();
}

/** Собрать пары ключ-значение из блока settings. */
function readSettings(body) {
  const settings = {};
  const blockMatch = /settings = \{([\s\S]*?)\n\t\t\t\};/.exec(body) || /settings = \{([\s\S]*?)\};/.exec(body);
  const source = blockMatch ? blockMatch[1] : body;

  const pattern = /([A-Z_][A-Z0-9_]*)\s*=\s*("([^"]*)"|([^;\n]*));/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const value = match[3] !== undefined ? match[3] : match[4];
    settings[match[1]] = value === undefined ? '' : value.trim();
  }
  return settings;
}

/**
 * Разобрать project.pbxproj.
 * @param {string} text
 * @returns {{objectVersion: number, targets: Array, packages: Array, sourceGroups: string[]}}
 */
function parsePbxproj(text) {
  const objectVersion = Number((/objectVersion = (\d+);/.exec(text) || [])[1] || 0);

  // --- цели ---
  const targets = findBlocks(text, 'PBXNativeTarget').map((block) => {
    const name = readSetting(block.body, 'name') || block.label || 'Target';
    const productType = readSetting(block.body, 'productType') || '';
    return {
      name: name.replace(/^"|"$/g, ''),
      productType,
      kind: productType.includes('application')
        ? 'app'
        : productType.includes('framework')
          ? 'framework'
          : productType.includes('static-library') || productType.includes('dynamic-library')
            ? 'library'
            : productType.includes('app-extension')
              ? 'extension'
              : 'other',
    };
  });

  // --- настройки сборки ---
  // Настройки цели узнаём по наличию PRODUCT_BUNDLE_IDENTIFIER: у проекта в
  // целом его нет, а у цели приложения он обязателен.
  const configurations = findBlocks(text, 'XCBuildConfiguration')
    .map((block) => {
      const settings = readSettings(block.body);
      const configName = readSetting(block.body, 'name') || '';
      return { name: configName.replace(/^"|"$/g, ''), settings };
    })
    .filter((item) => item.settings.PRODUCT_BUNDLE_IDENTIFIER);

  const release = configurations.find((item) => /release/i.test(item.name)) || configurations[0] || null;
  const debug = configurations.find((item) => /debug/i.test(item.name)) || null;
  const chosen = release || debug;

  const build = chosen ? chosen.settings : {};

  // --- зависимости SwiftPM ---
  const packages = findBlocks(text, 'XCRemoteSwiftPackageReference').map((block) => {
    const url = (readSetting(block.body, 'repositoryURL') || '').replace(/^"|"$/g, '');
    const kind = readSetting(block.body, 'kind') || 'upToNextMajorVersion';
    const version =
      readSetting(block.body, 'minimumVersion') ||
      readSetting(block.body, 'version') ||
      readSetting(block.body, 'branch') ||
      null;

    return {
      name: block.label || (url.split('/').pop() || '').replace(/\.git$/, ''),
      url,
      kind,
      version,
      // SwiftPM-эквивалент требования Xcode.
      requirement:
        kind === 'branch'
          ? `.branch("${version}")`
          : kind === 'exactVersion'
            ? `.exact("${version}")`
            : kind === 'upToNextMinorVersion'
              ? `.upToNextMinor(from: "${version}")`
              : `.upToNextMajor(from: "${version}")`,
    };
  });

  // --- папки с исходниками ---
  // Xcode 16 синхронизирует папку целиком; в старых версиях файлы перечислены
  // поштучно, поэтому поддерживаем оба случая.
  const sourceGroups = findBlocks(text, 'PBXFileSystemSynchronizedRootGroup')
    .map((block) => {
      const raw = readSetting(block.body, 'path');
      return raw ? raw.replace(/^"|"$/g, '') : null;
    })
    .filter(Boolean);

  const fileReferences = findBlocks(text, 'PBXFileReference')
    .map((block) => {
      const raw = readSetting(block.body, 'path');
      return raw ? raw.replace(/^"|"$/g, '') : null;
    })
    .filter(Boolean);

  return {
    objectVersion,
    targets,
    packages: packages.filter((item) => item.url),
    sourceGroups,
    fileReferences,
    build: {
      bundleId: build.PRODUCT_BUNDLE_IDENTIFIER || null,
      deploymentTarget: Number(build.IPHONEOS_DEPLOYMENT_TARGET || 0) || null,
      marketingVersion: build.MARKETING_VERSION || null,
      buildVersion: build.CURRENT_PROJECT_VERSION || null,
      infoPlist: (build.INFOPLIST_FILE || '').replace(/^"|"$/g, '') || null,
      swiftVersion: build.SWIFT_VERSION || null,
      productName: build.PRODUCT_NAME || null,
    },
    configurations: configurations.map((item) => item.name),
  };
}


/** Модули, которые приходят вместе с системой и не являются пакетами. */
const SYSTEM_MODULES = new Set([
  'Swift', 'Foundation', 'SwiftUI', 'SwiftUICore', 'UIKit', 'AppKit', 'Combine',
  'CoreData', 'CoreGraphics', 'CoreImage', 'CoreLocation', 'CoreMedia',
  'CoreTransferable', 'CoreVideo', 'AVFoundation', 'AVKit', 'PhotosUI',
  'WebKit', 'ImageIO', 'UniformTypeIdentifiers', 'MapKit', 'Metal', 'MetalKit',
  'SpriteKit', 'SceneKit', 'GameplayKit', 'ARKit', 'RealityKit', 'StoreKit',
  'UserNotifications', 'WidgetKit', 'Intents', 'IntentsUI', 'WatchKit',
  'HealthKit', 'HomeKit', 'Contacts', 'ContactsUI', 'EventKit', 'MessageUI',
  'MultipeerConnectivity', 'NetworkExtension', 'PassKit', 'PDFKit', 'QuickLook',
  'SafariServices', 'Speech', 'SpriteKit', 'VideoToolbox', 'Vision',
  'CryptoKit', 'LocalAuthentication', 'BackgroundTasks', 'Charts', 'Security',
]);

/** Собрать все import из исходников проекта. */
function collectImports(rootPath, files) {
  const found = new Set();

  for (const relative of files) {
    if (!/\.(swift|m|mm)$/i.test(relative)) continue;
    const full = path.join(rootPath, relative);

    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }

    // import Foo / @_exported import Foo / #import <Foo/Bar.h>
    const pattern = /^\s*(?:@_exported\s+)?import\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (!SYSTEM_MODULES.has(match[1])) found.add(match[1]);
    }
  }

  return [...found];
}

/** Привести имя к виду без разделителей, чтобы сравнивать «на глаз». */
function normalizeName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Сопоставить пакет с модулем, который он предоставляет.
 *
 * Имя пакета и имя продукта часто различаются: «swiftui-cached-async-image»
 * даёт продукт «CachedAsyncImage». Сопоставляем по вхождению нормализованных
 * имён, а если не совпало — оставляем имя пакета как есть.
 */
function productNameFor(pkg, imports) {
  const packageKey = normalizeName(pkg.name);
  const urlKey = normalizeName((pkg.url || '').split('/').pop() || '');

  const exact = imports.find((name) => normalizeName(name) === packageKey || normalizeName(name) === urlKey);
  if (exact) return exact;

  const partial = imports.find((name) => {
    const key = normalizeName(name);
    return key.length > 2 && (packageKey.includes(key) || key.includes(packageKey) || urlKey.includes(key));
  });

  return partial || pkg.name;
}

/** Имя модуля Swift не может содержать пробелы, дефисы и цифру в начале. */
function moduleNameFor(name) {
  const cleaned = String(name)
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'M$1');
  return cleaned || 'App';
}

/** Пройти по папке и разложить файлы на исходники и ресурсы. */
function collectFiles(rootPath, relativeDir) {
  const sources = [];
  const resources = [];
  const absolute = path.join(rootPath, relativeDir);

  if (!fs.existsSync(absolute)) return { sources, resources };

  const walk = (dir, relative) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'build' || entry.name === '.build') continue;

      const full = path.join(dir, entry.name);
      const rel = path.posix.join(relative, entry.name);

      if (entry.isDirectory()) {
        const ext = path.extname(entry.name).toLowerCase();
        // .xcassets и подобные папки-ресурсы дальше не разбираем.
        if (RESOURCE_EXTENSIONS.has(ext)) resources.push(rel);
        else walk(full, rel);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (SOURCE_EXTENSIONS.has(ext)) sources.push(rel);
        else if (RESOURCE_EXTENSIONS.has(ext)) resources.push(rel);
      }
    }
  };

  walk(absolute, relativeDir);
  return { sources, resources };
}

/**
 * Разобрать проект Xcode целиком.
 * @param {string} rootPath папка, где лежит .xcodeproj
 */
function analyzeProject(rootPath) {
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root)) throw new Error(`Папка не найдена: ${root}`);

  const entries = fs.readdirSync(root, { withFileTypes: true });
  const bundle = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj'));
  if (!bundle) throw new Error(`В папке нет .xcodeproj: ${root}`);

  const pbxprojPath = path.join(root, bundle.name, 'project.pbxproj');
  if (!fs.existsSync(pbxprojPath)) throw new Error(`Нет project.pbxproj: ${pbxprojPath}`);

  const parsed = parsePbxproj(fs.readFileSync(pbxprojPath, 'utf8'));

  // Исходники: сначала синхронизированные группы Xcode 16, иначе — папка цели.
  let sourceDir = parsed.sourceGroups[0] || null;
  if (!sourceDir) {
    const appTarget = parsed.targets.find((item) => item.kind === 'app') || parsed.targets[0];
    if (appTarget) {
      const candidate = entries.find(
        (entry) => entry.isDirectory() && entry.name === appTarget.name,
      );
      if (candidate) sourceDir = candidate.name;
    }
  }

  const collected = sourceDir ? collectFiles(root, sourceDir) : { sources: [], resources: [] };

  // Модули из импортов нужны, чтобы правильно назвать продукты зависимостей.
  const imports = collectImports(root, collected.sources);

  const appTarget = parsed.targets.find((item) => item.kind === 'app') || parsed.targets[0] || null;
  const displayName = appTarget ? appTarget.name : path.basename(bundle.name, '.xcodeproj');

  return {
    root,
    projectFile: path.join(root, bundle.name),
    projectName: path.basename(bundle.name, '.xcodeproj'),
    target: appTarget,
    displayName,
    moduleName: moduleNameFor(displayName),
    sourceDir,
    sources: collected.sources,
    resources: collected.resources,
    packages: parsed.packages.map((item) => ({
      ...item,
      product: productNameFor(item, imports),
    })),
    imports,
    build: parsed.build,
    objectVersion: parsed.objectVersion,
    targets: parsed.targets,
    configurations: parsed.configurations,
    // SwiftPM-совместимость: старые версии инструментов не понимают часть настроек.
    isModernFormat: parsed.objectVersion >= 77,
  };
}

/** Собрать Package.swift в том виде, который понимает xtool. */
function generatePackageSwift(analysis, options = {}) {
  const moduleName = options.moduleName || analysis.moduleName;
  const iosVersion = options.iosVersion || analysis.build.deploymentTarget || 17;
  const packageName = options.packageName || moduleName;

  const lines = [];
  // 6.0 берём, потому что именно его использует сам xtool new.
  lines.push('// swift-tools-version: 6.0');
  lines.push('');
  lines.push('import PackageDescription');
  lines.push('');
  lines.push('let package = Package(');
  lines.push(`    name: "${packageName}",`);
  lines.push('    platforms: [');
  lines.push(`        .iOS(.v${iosVersion}),`);
  lines.push('        .macOS(.v14),');
  lines.push('    ],');
  lines.push('    products: [');
  // Комментарий в чужом проекте должен быть на английском: файл увидят\n  // все, кто склонирует репозиторий, а не только русскоязычные.\n  lines.push('        // xtool turns exactly one library product into an app.');
  lines.push('        .library(');
  lines.push(`            name: "${packageName}",`);
  lines.push(`            targets: ["${moduleName}"]`);
  lines.push('        ),');
  lines.push('    ],');

  if (analysis.packages.length > 0) {
    lines.push('    dependencies: [');
    for (const item of analysis.packages) {
      lines.push(`        .package(url: "${item.url}", ${item.requirement || '.upToNextMajor(from: "1.0.0")'}),`);
    }
    lines.push('    ],');
  }

  lines.push('    targets: [');
  lines.push('        .target(');
  lines.push(`            name: "${moduleName}",`);
  lines.push('            dependencies: [');

  // Имя продукта внутри пакета обычно совпадает с именем самого пакета.
  for (const item of analysis.packages) {
    // Имя продукта берём из импортов кода: пакет и продукт называются по-разному.
    lines.push(`                .product(name: "${item.product || item.name}", package: "${item.name}"),`);
  }

  lines.push('            ],');

  if (analysis.sourceDir) {
    lines.push(`            path: "${analysis.sourceDir}",`);
  }

  // Всё, что ниже, указывается относительно path цели, а не корня пакета.
  const relativeToTarget = (value) => {
    if (!analysis.sourceDir) return value;
    const prefix = `${analysis.sourceDir}/`;
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
  };

  const excluded = [];

  // Info.plist подставляет xtool из xtool.yml — в ресурсах он лишний.
  if (analysis.build.infoPlist) {
    const base = path.posix.basename(analysis.build.infoPlist);
    if (analysis.sources.includes(base) || analysis.resources.includes(base)) excluded.push(base);
  }

  // Папка для превью нужна только Xcode; вне macOS она мешает сборке.
  const previewDirs = analysis.resources
    .filter((item) => /(^|\/)Preview Content(\/|$)/.test(item))
    .map((item) => relativeToTarget(item));
  excluded.push(...previewDirs);

  if (excluded.length > 0) {
    lines.push(`            exclude: [${[...new Set(excluded)].map((item) => `"${item}"`).join(', ')}],`);
  }

  const assetCatalogs = analysis.resources
    .filter((item) => item.endsWith('.xcassets'))
    .filter((item) => !/(^|\/)Preview Content(\/|$)/.test(item))
    .map((item) => relativeToTarget(item));

  if (assetCatalogs.length > 0) {
    lines.push('            resources: [');
    for (const item of assetCatalogs) {
      lines.push(`                .process("${item}"),`);
    }
    lines.push('            ],');
  }

  lines.push('        ),');
  lines.push('    ]');
  lines.push(')');
  lines.push('');

  return lines.join('\n');
}

/** Собрать xtool.yml — из него xtool берёт идентификатор приложения. */
function generateXtoolYml(analysis, options = {}) {
  const bundleId =
    options.bundleId ||
    analysis.build.bundleId ||
    `com.example.${moduleNameFor(analysis.displayName).toLowerCase()}`;

  return `version: 1\nbundleID: ${bundleId}\n`;
}

/**
 * Перенести проект Xcode в вид, понятный xtool.
 *
 * Файлы не перезаписываются без явного разрешения: важно не затереть то,
 * что пользователь уже поправил руками.
 *
 * @param {string} rootPath
 * @param {{write?: boolean, moduleName?: string, bundleId?: string, iosVersion?: number}} options
 */
function convertProject(rootPath, options = {}) {
  const analysis = analyzeProject(rootPath);
  const manifest = generatePackageSwift(analysis, options);
  const yml = generateXtoolYml(analysis, options);

  const manifestPath = path.join(analysis.root, 'Package.swift');
  const ymlPath = path.join(analysis.root, 'xtool.yml');

  const existing = {
    manifest: fs.existsSync(manifestPath),
    yml: fs.existsSync(ymlPath),
  };

  const result = {
    analysis,
    manifest,
    yml,
    manifestPath,
    ymlPath,
    existing,
    written: false,
  };

  if (!options.write) return result;

  if (existing.manifest && !options.overwrite) {
    throw new Error('Package.swift уже существует — включите перезапись, если он вам не нужен');
  }

  fs.writeFileSync(manifestPath, manifest, 'utf8');
  if (!existing.yml || options.overwrite) fs.writeFileSync(ymlPath, yml, 'utf8');
  result.written = true;

  return result;
}

module.exports = {
  parsePbxproj,
  collectImports,
  productNameFor,
  analyzeProject,
  generatePackageSwift,
  generateXtoolYml,
  convertProject,
  moduleNameFor,
  collectFiles,
  SOURCE_EXTENSIONS,
  RESOURCE_EXTENSIONS,
};
