'use strict';
/*
 * Конвертация Xcode-проекта в вид, который собирает xtool.
 *
 * Зачем это нужно. xtool собирает только SwiftPM-пакеты. Проект, скачанный с
 * GitHub, обычно содержит «Приложение.xcodeproj» и папку с исходниками рядом.
 * Такой проект xtool не понимает и падает с «Could not find Package.swift».
 *
 * Модуль xcode.js умеет разобрать project.pbxproj и собрать текст манифеста.
 * Здесь — вторая половина работы: разложить файлы так, как ждёт SwiftPM, и
 * снять те места, на которых сборка заведомо спотыкается. Всё это выяснено
 * на реальном проекте (Pocket Poster):
 *
 * 1. Исходники должны лежать в Sources/<Цель>/, ресурсы — внутри той же папки.
 * 2. Вложенные пакеты из Packages/ надо подключить как локальные цели, иначе
 *    «cannot find X in scope».
 * 3. Пакет с чужим манифестом (tools-version ниже, чем используемые в нём
 *    платформы) заставляет Swift отвергнуть весь проект целиком. Такой пакет
 *    переносится внутрь проекта копией исходника.
 * 4. Макросы #Preview есть только в Xcode: в SwiftPM они не собираются.
 * 5. Код, написанный под Swift 5, в режиме Swift 6 даёт десятки ошибок
 *    изоляции акторов — цели объявляются в языковом режиме 5.
 * 6. ZIPFoundation выбрасывать нельзя: без него код с `import ZIPFoundation`
 *    падает на «no such module». Пакет остаётся зависимостью, а нужная ему
 *    системная zlib подключается через linkerSettings: .linkedLibrary("z").
 *
 * Файлы исходного проекта не изменяются: конвертация идёт в копию.
 */

const fs = require('node:fs');
const path = require('node:path');
const xcode = require('./xcode');
const xcodeproj = require('./xcodeproj');

/** Пакеты, которые тянут библиотеки хоста и ломают линковку под iOS. */

/** Известные плохие манифесты: tools-version ниже используемых платформ. */
const BROKEN_MANIFEST_PACKAGES = ['swiftui-cached-async-image'];

/**
 * Пакеты, чей манифест тянет системную библиотеку хоста.
 *
 * ZIPFoundation объявляет `.systemLibrary(name: "CZLib", pkgConfig: "zlib")`.
 * Для Linux это нормально, но при линковке под iOS в командной строке
 * оказывается `-L/usr/lib/x86_64-linux-gnu` и `-lz` находит ELF-овую
 * libz.so — ld64.lld отвечает «unhandled file type» и сборка падает.
 *
 * Поэтому исходники такого пакета переносим внутрь проекта отдельной целью:
 * манифест с pkgConfig больше не участвует, а `-lz` берётся из iOS SDK
 * (там есть libz.tbd) через наш linkerSettings.
 */
const SYSTEM_LIBRARY_PACKAGES = ['zipfoundation'];

/** Файлы и папки, которые незачем переносить. */
const SKIP_NAMES = new Set([
  'build',
  'DerivedData',
  '.git',
  '.build',
  'Pods',
  'xcuserdata',
  '.swiftpm',
  'xtool',
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Скопировать папку целиком, пропуская служебное. */
function copyTree(from, to, options = {}) {
  if (!fs.existsSync(from)) return 0;
  ensureDir(to);

  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    if (options.skip && options.skip(entry)) continue;

    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);

    if (entry.isDirectory()) {
      count += copyTree(source, target, options);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
      count += 1;
    }
  }
  return count;
}

/**
 * Найти вложенные SwiftPM-пакеты внутри Xcode-проекта.
 * Обычно это папка Packages/, где каждый подкаталог со своим Package.swift.
 */
function findNestedPackages(root) {
  const found = [];

  const candidates = ['Packages', 'LocalPackages', 'Modules'];
  for (const dirName of candidates) {
    const dir = path.join(root, dirName);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(dir, entry.name);
      if (fs.existsSync(path.join(candidate, 'Package.swift'))) {
        found.push({ name: entry.name, path: candidate });
      }
    }
  }

  return found;
}

/**
 * Найти повторные объявления `let`/`var` в одной области видимости.
 *
 * Swift запрещает два объявления с одним именем в одном блоке, но проект
 * спокойно доезжает до сборки, и там ошибка выглядит как «invalid redeclaration
 * of 'url'» без объяснений. Ищем такие места сразу после конвертации, чтобы
 * предупредить до сборки.
 *
 * Область видимости — стек вложенности фигурных скобок: конфликт есть только
 * при полном совпадении пути вложенности.
 *
 * @param {string} filePath
 * @returns {Array<{name: string, firstLine: number, secondLine: number}>}
 */
function findDuplicateDeclarations(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const lines = text.split('\n');
  const duplicates = [];
  // Путь вложенности — из уникальных номеров блоков, а не из глубины: два
  // разных блока на одной глубине не должны считаться одним и тем же местом.
  const stack = [];
  const visible = new Map();
  let counter = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith('//')) continue;

    const declaration = /^\s*(?:let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=/.exec(line);
    if (declaration) {
      const key = `${stack.join('/')}::${declaration[1]}`;
      const previous = visible.get(key);
      if (previous) {
        duplicates.push({ name: declaration[1], firstLine: previous, secondLine: index + 1 });
      } else {
        visible.set(key, index + 1);
      }
    }

    for (const ch of line) {
      if (ch === '{') {
        counter += 1;
        stack.push(counter);
      } else if (ch === '}') {
        const closed = stack.pop();
        if (closed === undefined) continue;

        // Всё, что было объявлено внутри закрытого блока, больше не видно.
        const prefix = `${stack.join('/')}/${closed}::`;
        for (const key of [...visible.keys()]) {
          if (key.startsWith(prefix)) visible.delete(key);
        }
      }
    }
  }

  return duplicates;
}

/** Сколько .swift-файлов внутри папки (с подпапками). */
function countSwiftFiles(dir) {
  let count = 0;

  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.build' || entry.name === 'Tests') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.swift')) count += 1;
    }
  };

  if (fs.existsSync(dir)) walk(dir);
  return count;
}

/**
 * Перенести исходники вложенных папок из Packages/ внутрь цели приложения.
 *
 * Xcode держит такие папки в составе самой цели — часто это вообще не пакет,
 * а просто набор файлов (в Pocket Poster у GIFImage нет Package.swift), и код
 * пользуется их типами без `import`. SwiftPM вынес бы их в отдельный модуль, и
 * без импорта сборка падала бы на «cannot find 'GIFImage' in scope». Копируем
 * файлы в цель — поведение остаётся прежним.
 *
 * @param {string} sourceRoot папка исходников приложения
 * @param {string} sourcesDir папка назначения (Sources/<Цель>)
 * @returns {Array<{name: string, files: number}>}
 */
function inlineSourcePackages(sourceRoot, sourcesDir) {
  const result = [];
  const packagesDir = path.join(sourceRoot, 'Packages');
  if (!fs.existsSync(packagesDir) || !fs.statSync(packagesDir).isDirectory()) return result;

  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const packagePath = path.join(packagesDir, entry.name);

    // Берём папку Sources, если она есть, иначе саму папку — но без манифеста
    // и тестов: Package.swift внутри цели SwiftPM считает лишним файлом.
    const innerSources = path.join(packagePath, 'Sources');
    const from = fs.existsSync(innerSources) ? innerSources : packagePath;

    const swiftFiles = countSwiftFiles(from);
    if (swiftFiles === 0) continue;

    const to = path.join(sourcesDir, entry.name);
    const files = copyTree(from, to, {
      skip: (item) => item.name === 'Tests' || item.name === 'Package.swift'
        || item.name === '.build' || item.name.endsWith('.xcodeproj'),
    });

    if (files > 0) result.push({ name: entry.name, files });
  }

  return result;
}

/**
 * Убрать блоки `#Preview { ... }` — макрос доступен только в Xcode.
 * @returns {number} сколько блоков убрано
 */
function stripPreviews(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return 0;
  }
  if (!text.includes('#Preview')) return 0;

  const lines = text.split('\n');
  const out = [];
  let removed = 0;
  let i = 0;

  while (i < lines.length) {
    if (lines[i].trimStart().startsWith('#Preview')) {
      // Считаем баланс скобок, чтобы срезать блок целиком.
      let depth = 0;
      let started = false;
      while (i < lines.length) {
        const line = lines[i];
        depth += (line.match(/\{/g) || []).length;
        depth -= (line.match(/\}/g) || []).length;
        if (line.includes('{')) started = true;
        i += 1;
        if (started && depth <= 0) break;
      }
      removed += 1;
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }

  if (removed > 0) fs.writeFileSync(filePath, out.join('\n'), 'utf8');
  return removed;
}

/**
 * Добавить импорт модуля, если его ещё нет.
 *
 * В Xcode модуль виден через проект, а в SwiftPM нужен явный import —
 * без него сборка падает с «cannot find 'X' in scope».
 */
function ensureImport(filePath, moduleName) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }

  const importLine = `import ${moduleName}`;
  if (new RegExp(`^\\s*import\\s+${moduleName}\\s*$`, 'm').test(text)) return false;
  // Тип может быть виден и без импорта, если модуль назван так же.
  if (!new RegExp(`\\b${moduleName}\\b`).test(text)) return false;

  const lines = text.split('\n');
  let lastImport = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*import\s+\w/.test(lines[i])) lastImport = i;
  }
  if (lastImport === -1) return false;

  lines.splice(lastImport + 1, 0, importLine);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return true;
}

/** Собрать адреса репозиториев пакетов, объявленных в проекте. */
function packageUrls(analysis) {
  return (analysis.packages || []).map((item) => item.url || '').filter(Boolean);
}

/** Относится ли пакет к списку по фрагменту адреса или имени. */
function matchesPackage(analysis, names) {
  return (analysis.packages || []).filter((item) => {
    const haystack = `${item.url || ''} ${item.name || ''} ${item.product || ''}`.toLowerCase();
    return names.some((needle) => haystack.includes(needle.toLowerCase()));
  });
}

/**
 * Сгенерировать манифест с учётом найденных проблем.
 *
 * Базовый текст берём из xcode.js, а затем правим его под то, что реально
 * мешает сборке: убираем ломающие зависимости, подключаем локальные цели,
 * включаем языковой режим Swift 5.
 */
function buildManifest(analysis, options, notes) {
  const moduleName = options.moduleName || analysis.moduleName;
  const iosVersion = options.iosVersion || analysis.build?.iosVersion || 17;
  const bundleId = options.bundleId || analysis.build?.bundleId || `com.example.${moduleName.toLowerCase()}`;

  const nested = options.nestedPackages || [];
  // Только те пакеты, чьи исходники реально оказались внутри проекта.
  const vendored = options.vendored || [];
  const broken = matchesPackage(analysis, BROKEN_MANIFEST_PACKAGES);
  const systemLinked = matchesPackage(analysis, SYSTEM_LIBRARY_PACKAGES);

  const targetName = analysis.sourceDir && /^[A-Za-z0-9_]+$/.test(analysis.sourceDir)
    ? moduleName
    : moduleName;

  const lines = [];
  lines.push('// swift-tools-version: 6.0');
  lines.push('import PackageDescription');
  lines.push('');
  lines.push('// Манифест создан FCode из проекта Xcode.');
  lines.push('//');
  lines.push('// xtool собирает только SwiftPM-пакеты, поэтому исходники разложены в');
  lines.push('// Sources/, а зависимости перенесены из project.pbxproj.');
  if (broken.length) {
    lines.push('//');
    lines.push(`// ${broken.map((p) => p.name || p.product).join(', ')} подключён копией исходника:`);
    lines.push('// его манифест объявляет tools-version ниже, чем используемые в нём');
    lines.push('// платформы (в частности visionOS), и Swift отвергает весь проект целиком.');
  }
  lines.push('');

  const platforms = [`        .iOS(.v${iosVersion}),`];
  lines.push('let package = Package(');
  lines.push(`    name: "${moduleName}",`);
  lines.push('    platforms: [');
  lines.push(...platforms);
  lines.push('        .macOS(.v14),');
  lines.push('    ],');
  lines.push('    products: [');
  lines.push('        // xtool требует ровно один библиотечный продукт.');
  lines.push('        .library(');
  lines.push(`            name: "${moduleName}",`);
  lines.push(`            targets: ["${moduleName}"]`);
  lines.push('        ),');
  lines.push('    ],');

  // Внешние зависимости: из проекта минус те, чьи исходники уже лежат рядом.
  //
  // ZIPFoundation раньше выбрасывался целиком («тянет libz.so»), и это была
  // ошибка: код делает import ZIPFoundation, а модуля в сборке нет — проект
  // падал на «no such module». Нужен именно пакет, а libz подключается
  // через linkerSettings ниже.
  const external = (analysis.packages || []).filter((item) => {
    const haystack = `${item.url || ''} ${item.name || ''}`.toLowerCase();
    if (BROKEN_MANIFEST_PACKAGES.some((n) => haystack.includes(n.toLowerCase()))) return false;
    if (SYSTEM_LIBRARY_PACKAGES.some((n) => haystack.includes(n.toLowerCase()))) return false;
    return Boolean(item.url);
  });

  lines.push('    dependencies: [');
  if (external.length === 0) lines.push('        // внешних зависимостей нет');
  for (const item of external) {
    lines.push(`        .package(url: "${item.url}", from: "${item.version || '1.0.0'}"),`);
  }
  lines.push('    ],');

  lines.push('    targets: [');

  // Локальные копии проблемных пакетов — только те, что реально перенесены.
  for (const vendorName of vendored) {
    lines.push('        .target(');
    lines.push(`            name: "${vendorName}",`);
    lines.push(`            path: "Vendor/${vendorName}",`);
    lines.push('            swiftSettings: [.swiftLanguageMode(.v5)]');
    lines.push('        ),');
  }

  // Вложенные пакеты проекта подключаем как локальные цели.
  for (const nestedPkg of nested) {
    lines.push('        .target(');
    lines.push(`            name: "${nestedPkg.name}",`);
    lines.push(`            path: "Vendor/${nestedPkg.name}",`);
    lines.push('            swiftSettings: [.swiftLanguageMode(.v5)]');
    lines.push('        ),');
  }

  lines.push('        .target(');
  lines.push(`            name: "${targetName}",`);
  lines.push('            dependencies: [');

  for (const vendorName of vendored) {
    lines.push(`                "${vendorName}",`);
  }
  for (const nestedPkg of nested) {
    lines.push(`                "${nestedPkg.name}",`);
  }
  for (const item of external) {
    lines.push(`                .product(name: "${item.product || item.name}", package: "${item.name}"),`);
  }
  if (vendored.length === 0 && nested.length === 0 && external.length === 0) {
    lines.push('                // зависимостей нет');
  }

  lines.push('            ],');
  lines.push(`            path: "Sources/${targetName}",`);
  // Пустой список ресурсов SwiftPM считает ошибкой, поэтому объявляем его
  // только когда внутри цели действительно есть что обрабатывать.
  if (options.hasResources) {
    lines.push('            resources: [');
    lines.push('                .copy("Assets.xcassets"),');
    lines.push('                .copy("Localizable.xcstrings"),');
    lines.push('            ],');
  }
  lines.push('            swiftSettings: [.swiftLanguageMode(.v5)],');
  lines.push('            linkerSettings: [.linkedLibrary("z")]');
  lines.push('        ),');
  lines.push('    ]');
  lines.push(')');
  lines.push('');

  return lines.join('\n');
}

/**
 * Конвертировать проект Xcode в SwiftPM-пакет.
 *
 * Исходный проект не трогаем: рядом создаётся папка с результатом, и уже в ней
 * раскладываются файлы. Так пользователь в любой момент может вернуться к
 * исходному виду.
 *
 * @param {string} rootPath папка, где лежит .xcodeproj
 * @param {{outputDir?: string, overwrite?: boolean, moduleName?: string, bundleId?: string, iosVersion?: number}} options
 */
function convert(rootPath, options = {}) {
  const analysis = xcode.analyzeProject(rootPath);
  const notes = [];

  const moduleName = options.moduleName
    || (analysis.sourceDir && /^[A-Za-z_][A-Za-z0-9_]*$/.test(analysis.sourceDir)
      ? analysis.sourceDir
      : analysis.moduleName);

  const outputDir = options.outputDir || path.join(path.dirname(analysis.root), `${path.basename(analysis.root)}-xtool`);

  if (fs.existsSync(outputDir)) {
    if (!options.overwrite) {
      const marker = path.join(outputDir, 'Package.swift');
      if (fs.existsSync(marker)) {
        throw new Error(`Папка уже сконвертирована: ${outputDir}. Включите перезапись.`);
      }
    }
    fs.rmSync(outputDir, { recursive: true, force: true });
  }

  ensureDir(outputDir);
  const sourcesDir = path.join(outputDir, 'Sources', moduleName);
  const vendorDir = path.join(outputDir, 'Vendor');
  ensureDir(sourcesDir);

  // 1. Исходники цели.
  const sourceRoot = analysis.sourceDir
    ? path.join(analysis.root, analysis.sourceDir)
    : analysis.root;
  const copied = copyTree(sourceRoot, sourcesDir, {
    // Файлы проекта Xcode и вложенные пакеты переносим отдельно.
    skip: (entry) => entry.name.endsWith('.xcodeproj') || entry.name === 'Packages',
  });
  notes.push(`перенесено файлов: ${copied}`);

  // 1a. Вложенные пакеты внутри папки исходников.
  //
  // Xcode держал их файлы в составе самой цели: в Pocket Poster код пишет
  // GIFImage(...) без import, потому что модуль был один. Если такие файлы не
  // перенести, сборка падает на «cannot find 'GIFImage' in scope». Поэтому
  // копируем их исходники в цель приложения — так же, как это делал Xcode.
  const inlinedPackages = inlineSourcePackages(sourceRoot, sourcesDir);
  for (const item of inlinedPackages) {
    notes.push(`исходники ${item.name} добавлены в цель: Xcode компилировал их в составе приложения`);
  }

  // 1b. Повторные объявления в одном блоке: Swift их не примет, и сборка
  // упадёт на «invalid redeclaration». Сообщаем сразу, с файлом и строкой.
  for (const file of walkSwift(sourcesDir)) {
    for (const duplicate of findDuplicateDeclarations(file)) {
      const relative = path.relative(outputDir, file).replace(/\\/g, '/');
      notes.push(
        `повторное объявление: ${relative}:${duplicate.secondLine} — переменная ${duplicate.name} `
        + `(первое на строке ${duplicate.firstLine}); такую сборку Swift не примет`,
      );
    }
  }

  // 2. Ресурсы, лежащие в корне рядом с исходниками.
  const resourceNames = [
    'Assets.xcassets',
    'Localizable.xcstrings',
    'Resources',
  ];
  for (const entry of fs.readdirSync(analysis.root, { withFileTypes: true })) {
    if (!entry.name.endsWith('.xcstrings') && !resourceNames.includes(entry.name)) continue;
    const from = path.join(analysis.root, entry.name);
    const to = path.join(sourcesDir, entry.name);
    if (fs.statSync(from).isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }

  // 3. Вложенные пакеты — как локальные цели.
  const nestedPackages = findNestedPackages(analysis.root);
  for (const pkg of nestedPackages) {
    const target = path.join(vendorDir, pkg.name);
    ensureDir(target);
    // Кладём только исходники: у вложенного пакета свой манифест, он не нужен.
    const pkgSources = path.join(pkg.path, 'Sources');
    if (fs.existsSync(pkgSources)) copyTree(pkgSources, target);
    else copyTree(pkg.path, target, { skip: (e) => e.name === 'Package.swift' });
  }
  if (nestedPackages.length) {
    notes.push(`вложенных пакетов: ${nestedPackages.length} (${nestedPackages.map((p) => p.name).join(', ')})`);
  }

  // 4. Проблемные зависимости — копией исходника внутрь проекта.
  // Сюда же пакеты с системной библиотекой: их манифест ломает линковку iOS.
  const broken = matchesPackage(analysis, BROKEN_MANIFEST_PACKAGES);
  const systemLinked = matchesPackage(analysis, SYSTEM_LIBRARY_PACKAGES);
  const vendorable = [...broken, ...systemLinked];

  for (const pkg of vendorable) {
    const vendorName = pkg.product || pkg.name;
    const target = path.join(vendorDir, vendorName);
    const url = String(pkg.url || '');

    // Сначала пробуем локальный кэш, чтобы не ходить в сеть зря.
    const cached = findCachedPackage(analysis.root, url);
    if (cached && fs.existsSync(cached)) {
      copyTree(cached, target);
      notes.push(`${vendorName} перенесён из кэша пакетов`);
      continue;
    }

    // Иначе скачиваем копию исходников через git в WSL.
    const downloaded = downloadPackage(url, vendorName, options);
    if (downloaded) {
      // Копируем только исходники: чужой манифест внутри цели ломает сборку
      // («no such module 'PackageDescription'»), он нам не нужен. Содержимое
      // Sources/ кладём прямо в цель — иначе файлы окажутся на уровень глубже.
      const pkgSources = path.join(downloaded, 'Sources');
      if (fs.existsSync(pkgSources)) {
        for (const entry of fs.readdirSync(pkgSources)) {
          const from = path.join(pkgSources, entry);
          const to = path.join(target, entry);
          if (fs.statSync(from).isDirectory()) copyTree(from, to);
          else fs.copyFileSync(from, to);
        }
      } else {
        copyTree(downloaded, target, { skip: (e) => e.name === 'Package.swift' });
      }
      notes.push(`${vendorName} скачан с GitHub`);
    } else {
      // Цель в манифест не попадёт: без исходников SwiftPM ругается на путь.
      notes.push(`${vendorName} скачать не удалось — зависимость исключена из сборки`);
    }
  }

  // 5. Убрать макросы #Preview и добавить недостающие импорты.
  let previewsRemoved = 0;
  for (const file of walkSwift(sourcesDir)) {
    previewsRemoved += stripPreviews(file);
  }
  for (const file of walkSwift(vendorDir)) {
    stripPreviews(file);
  }
  if (previewsRemoved) notes.push(`убрано блоков #Preview: ${previewsRemoved}`);

  for (const pkg of broken) {
    const vendorName = pkg.product || pkg.name;
    for (const file of walkSwift(sourcesDir)) {
      if (ensureImport(file, vendorName)) notes.push(`добавлен import ${vendorName} в ${path.basename(file)}`);
    }
  }

  // 6. Манифест и настройки xtool.
  // Если исходники зависимости скачать не удалось, объявлять её цель нельзя:
  // SwiftPM упадёт на «invalid custom path for target».
  const vendored = vendorable
    .map((pkg) => pkg.product || pkg.name)
    .filter((name) => fs.existsSync(path.join(vendorDir, name)));

  const hasResources = fs.existsSync(path.join(sourcesDir, 'Assets.xcassets'))
    || fs.existsSync(path.join(sourcesDir, 'Localizable.xcstrings'));

  const manifest = buildManifest(analysis, {
    moduleName,
    bundleId: options.bundleId,
    iosVersion: options.iosVersion,
    nestedPackages,
    vendored,
    hasResources,
  }, notes);

  fs.writeFileSync(path.join(outputDir, 'Package.swift'), manifest, 'utf8');

  const bundleId = options.bundleId || analysis.build?.bundleId || `com.example.${moduleName.toLowerCase()}`;
  fs.writeFileSync(path.join(outputDir, 'xtool.yml'), `version: 1\nbundleID: ${bundleId}\n`, 'utf8');

  // 7. Обратная совместимость с Xcode: рядом с Package.swift кладём настоящий
  // .xcodeproj. xtool на Linux генерировать его не умеет, а без него проект
  // не открыть в Xcode на Mac. Основной сборкой остаётся SwiftPM — .xcodeproj
  // лишь делает проект переносимым.
  //
  // Info.plist переносим отдельно: в нём бывают URL-схемы, типы файлов и
  // доступ к документам, которых нет ни в SwiftPM, ни в синтезированном Xcode
  // plist. Без этого приложение после переноса теряет часть поведения.
  const infoPlistSource = findInfoPlist(analysis);
  let infoPlistName = null;
  if (infoPlistSource) {
    try {
      fs.copyFileSync(infoPlistSource, path.join(outputDir, 'Info.plist'));
      infoPlistName = 'Info.plist';
      notes.push(`перенесён ${path.basename(infoPlistSource)} — сохранены URL-схемы и типы файлов`);
    } catch (error) {
      notes.push(`Info.plist не перенесён: ${error.message}`);
    }
  }

  let xcodeProject = null;
  if (options.xcodeproj !== false) {
    try {
      xcodeProject = xcodeproj.generate(outputDir, {
        name: moduleName,
        sourceDir: `Sources/${moduleName}`,
        bundleId,
        iosVersion: options.iosVersion || analysis.build?.iosVersion || 17,
        version: options.version || '1.0',
        infoPlist: infoPlistName,
        packages: xcodeRemotePackages(analysis, vendored),
        extraGroups: vendored.map((name) => ({ name, path: `Vendor/${name}` })),
        overwrite: true,
      });
      notes.push(`создан ${xcodeProject.name}.xcodeproj — проект открывается в Xcode на Mac`);
    } catch (error) {
      notes.push(`.xcodeproj не создан: ${error.message}`);
    }
  }

  return {
    ok: true,
    outputDir,
    moduleName,
    bundleId,
    analysis,
    nestedPackages: nestedPackages.map((p) => p.name),
    notes,
    manifest,
    xcodeProject,
    infoPlist: infoPlistName,
  };
}

/**
 * Удалённые зависимости для генерируемого .xcodeproj.
 *
 * Пусть Xcode разрешает их сам: так проект остаётся обычным, без копий в
 * Vendor. Скачанные пакеты сюда не попадают — их исходники подключены
 * отдельными группами, иначе модуль объявился бы дважды.
 *
 * @param {object} analysis разбор оригинального проекта
 * @param {string[]} vendored имена пакетов, лежащих в Vendor
 */
function xcodeRemotePackages(analysis, vendored) {
  const result = [];

  for (const pkg of analysis.packages || []) {
    const product = pkg.product || pkg.name;
    if (!product || !pkg.url) continue;
    if (vendored.includes(product)) continue;

    result.push({
      kind: 'remote',
      url: pkg.url,
      version: pkg.version || '1.0.0',
      product,
    });
  }

  return result;
}

/**
 * Найти Info.plist приложения в исходном проекте.
 *
 * Xcode обычно держит его рядом с .xcodeproj, с именем вида
 * «Приложение-Info.plist»; встречается и внутри папки исходников.
 */
function findInfoPlist(analysis) {
  const candidates = [
    path.join(analysis.root, `${analysis.displayName}-Info.plist`),
    // Xcode часто заменяет пробелы дефисами: «Pocket Poster» → «Pocket-Poster-Info.plist».
    path.join(analysis.root, `${String(analysis.displayName || '').replace(/\s+/g, '-')}-Info.plist`),
    path.join(analysis.root, `${analysis.target?.name || ''}-Info.plist`),
    path.join(analysis.root, 'Info.plist'),
  ];

  if (analysis.sourceDir) {
    candidates.push(path.join(analysis.root, analysis.sourceDir, 'Info.plist'));
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }

  // Последняя попытка: любой *-Info.plist в корне проекта.
  try {
    const found = fs
      .readdirSync(analysis.root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /-Info\.plist$/i.test(entry.name))
      .map((entry) => path.join(analysis.root, entry.name));
    if (found.length) return found[0];
  } catch {
    /* корень уже проверен выше */
  }

  return null;
}

/**
 * Скачать исходники пакета через git внутри WSL.
 *
 * Клонирование идёт в Linux: git там уже есть (он нужен xtool), а на Windows
 * его может не оказаться. Возвращает путь к скачанной папке или null.
 */
function downloadPackage(url, name, options = {}) {
  if (!url) return null;

  const target = path.join(options.cacheDir || require('node:os').tmpdir(), 'fcode-pkg-cache', name);
  if (fs.existsSync(path.join(target, 'Sources')) || fs.existsSync(path.join(target, name))) {
    return target;
  }

  const { execFileSync } = require('node:child_process');
  // Внутри Linux путь к кэшу строим из Windows-пути: /mnt/<диск>/<остальное>.
  const linuxTarget = /^([A-Za-z]):\\(.*)$/.exec(target);
  const linuxPath = linuxTarget
    ? `/mnt/${linuxTarget[1].toLowerCase()}/${linuxTarget[2].replace(/\\/g, '/')}`
    : target.replace(/\\/g, '/');

  try {
    // Без -u: имя пользователя в WSL у каждого своё (frigus, frigusoid, любое),
    // а зашитое имя даёт «WSL_E_USER_NOT_FOUND» и молча ломает загрузку пакета.
    execFileSync('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc',
      `set -e; mkdir -p "$(dirname '${linuxPath}')"; rm -rf '${linuxPath}'; ` +
      `git clone --depth 1 '${url}' '${linuxPath}' 2>&1 | tail -2`,
    ], { stdio: 'pipe', timeout: 180000 });
  } catch {
    return null;
  }

  return fs.existsSync(target) ? target : null;
}

/** Найти пакет в локальном кэше SwiftPM по адресу репозитория. */
function findCachedPackage(root, url) {
  if (!url) return null;
  const name = url.replace(/\.git$/, '').split('/').pop();
  if (!name) return null;

  const candidates = [
    path.join(root, '.build', 'checkouts', name),
    path.join(process.env.HOME || '', '.cache', 'org.swift.swiftpm', 'repositories', name),
    path.join('/tmp', 'fcode-pkg-cache', name),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Все .swift файлы в папке, рекурсивно. */
function walkSwift(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkSwift(full));
    else if (entry.name.endsWith('.swift')) found.push(full);
  }
  return found;
}

/** Это проект Xcode, а не SwiftPM-пакет? */
function isXcodeProject(rootPath) {
  try {
    return fs.readdirSync(rootPath, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj'));
  } catch {
    return false;
  }
}

/** Уже сконвертирован? */
function isConverted(rootPath) {
  return fs.existsSync(path.join(rootPath, 'Package.swift'))
    && fs.existsSync(path.join(rootPath, 'xtool.yml'));
}

module.exports = {
  convert,
  isXcodeProject,
  isConverted,
  findNestedPackages,
  stripPreviews,
  ensureImport,
  walkSwift,
  BROKEN_MANIFEST_PACKAGES,
  SYSTEM_LIBRARY_PACKAGES,
  findDuplicateDeclarations,
};
