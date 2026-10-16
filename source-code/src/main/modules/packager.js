'use strict';
/*
 * Сборка .ipa из .xcarchive / .app — целиком на Windows, без macOS.
 *
 * Схема (та же, что делает Xcode при Export):
 *   MyApp.xcarchive/Products/Applications/MyApp.app  ->  Payload/MyApp.app
 *   MyApp.xcarchive/SwiftSupport/iphoneos/*.dylib    ->  SwiftSupport/iphoneos/*.dylib   (только App Store)
 *   MyApp.xcarchive/dSYMs/MyApp.app.dSYM             ->  Symbols/MyApp.app.dSYM          (опционально)
 *
 * Два неочевидных момента, без которых .ipa не установится:
 *
 * 1. Права. .ipa — это zip, и исполняемый файл внутри должен иметь mode 0755.
 *    При переносе архива на NTFS Unix-биты теряются, поэтому режим вычисляется
 *    заново: любой Mach-O внутри бандла помечается как 0755, остальное 0644.
 *
 * 2. Симлинки внутри .framework (Versions/Current -> A). Их нужно писать как
 *    настоящие symlink-записи, иначе фреймворк развалится.
 *
 * Плюс: упаковка идёт потоково прямо из .xcarchive в .ipa, без временной копии
 * на диск — на больших проектах это экономит десятки гигабайт и минуты.
 */

const fs = require('fs');
const path = require('path');
const { ZipWriter, zipDirectory, readZipDirectory } = require('./zip');
const plist = require('./plist');
const { t } = require('../../shared/i18n');

// Mach-O: 32/64, little/big endian, а также universal (fat) бинарники.
const MACHO_MAGICS = new Set([
  0xfeedface, // MH_MAGIC
  0xcefaedfe, // MH_CIGAM
  0xfeedfacf, // MH_MAGIC_64
  0xcffaedfe, // MH_CIGAM_64
  0xcafebabe, // FAT_MAGIC
  0xbebafeca, // FAT_CIGAM
  0xcafebabf, // FAT_MAGIC_64
  0xbfbafeca, // FAT_CIGAM_64
]);

const FILE_MODE_EXEC = 0o755;
const FILE_MODE_DATA = 0o644;
const DIR_MODE = 0o755;

/** Является ли файл Mach-O (по первым 4 байтам). */
function isMachO(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(4);
    const read = fs.readSync(fd, header, 0, 4, 0);
    if (read < 4) return false;
    return MACHO_MAGICS.has(header.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Права для файла внутри бандла: Mach-O исполняемый, всё остальное — данные. */
function modeForFile(filePath) {
  return isMachO(filePath) ? FILE_MODE_EXEC : FILE_MODE_DATA;
}

function statSafe(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/**
 * Найти .app внутри .xcarchive.
 * Структура архива стабильна: Products/Applications/*.app
 * @returns {{appPath: string, archiveInfo: object|null, swiftSupport: string|null, dsymDir: string|null}}
 */
function resolveAppFromArchive(archivePath) {
  const resolved = path.resolve(archivePath);
  if (!fs.existsSync(resolved)) throw new Error(t('issue.pathNotFound', { path: resolved }));

  const stat = fs.lstatSync(resolved);

  // Уже готовый .app — принимаем напрямую.
  if (stat.isDirectory() && resolved.toLowerCase().endsWith('.app')) {
    return { appPath: resolved, archiveInfo: null, swiftSupport: null, dsymDir: null };
  }
  if (!stat.isDirectory()) {
    throw new Error(t('issue.expectedDirectory', { path: resolved }));
  }

  const applicationsDir = path.join(resolved, 'Products', 'Applications');
  if (!fs.existsSync(applicationsDir)) {
    throw new Error(
      t('issue.noProductsApplications', { path: resolved }),
    );
  }

  const apps = fs
    .readdirSync(applicationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.toLowerCase().endsWith('.app'));

  if (apps.length === 0) throw new Error(t('issue.noAppInProducts', { path: applicationsDir }));

  // Если приложений несколько (watchOS-компаньон), берём основное — то, у которого
  // нет родительского .app (watch-app лежит внутри основного).
  let appName = apps[0].name;
  if (apps.length > 1) {
    const main = apps.find((d) => !d.name.toLowerCase().includes('watch'));
    if (main) appName = main.name;
  }

  const appPath = path.join(applicationsDir, appName);

  let archiveInfo = null;
  const archivePlist = path.join(resolved, 'Info.plist');
  if (fs.existsSync(archivePlist)) {
    try {
      archiveInfo = plist.readPlistFile(archivePlist).value;
    } catch {
      archiveInfo = null;
    }
  }

  const swiftSupportCandidates = [
    path.join(resolved, 'SwiftSupport', 'iphoneos'),
    path.join(resolved, 'SwiftSupport'),
  ];
  const swiftSupport = swiftSupportCandidates.find((p) => fs.existsSync(p)) || null;

  const dsymCandidates = [path.join(resolved, 'dSYMs'), path.join(resolved, 'dSYM')];
  const dsymDir = dsymCandidates.find((p) => fs.existsSync(p)) || null;

  return { appPath, archiveInfo, swiftSupport, dsymDir };
}

/** Прочитать Info.plist приложения и вытащить ключевые поля. */
function inspectBundle(appPath) {
  const infoPlistPath = path.join(appPath, 'Info.plist');
  if (!fs.existsSync(infoPlistPath)) {
    throw new Error(t('issue.noInfoPlist', { path: infoPlistPath }));
  }

  const { format, value: info } = plist.readPlistFile(infoPlistPath);
  if (!info || typeof info !== 'object') throw new Error(t('issue.emptyInfoPlist'));

  const executable = info.CFBundleExecutable;
  const executablePath = executable ? path.join(appPath, executable) : null;

  const issues = [];
  if (!info.CFBundleIdentifier) issues.push(t('issue.missingBundleId'));
  if (!executable) issues.push(t('issue.missingExecutable'));
  if (executablePath && !fs.existsSync(executablePath)) {
    issues.push(t('issue.executableNotFound', { name: executable }));
  } else if (executablePath && !isMachO(executablePath)) {
    issues.push(t('issue.notMachO', { name: executable }));
  }

  const signatureDir = path.join(appPath, '_CodeSignature');
  const provisioning = path.join(appPath, 'embedded.mobileprovision');

  let profileInfo = null;
  if (fs.existsSync(provisioning)) {
    profileInfo = parseProvisioningProfile(provisioning);
  }

  return {
    infoPlistPath,
    plistFormat: format,
    bundleId: info.CFBundleIdentifier || null,
    executable: executable || null,
    executablePath,
    displayName: info.CFBundleDisplayName || info.CFBundleName || null,
    shortVersion: info.CFBundleShortVersionString || null,
    buildVersion: info.CFBundleVersion || null,
    minimumOSVersion: info.MinimumOSVersion || null,
    platform: info.DTPlatformName || null,
    deviceFamily: info.UIDeviceFamily || null,
    isSigned: fs.existsSync(signatureDir),
    hasProvisioningProfile: Boolean(profileInfo),
    profile: profileInfo,
    issues,
  };
}

/**
 * Разобрать embedded.mobileprovision (CMS/PKCS#7 с вложенным plist).
 * Полноценная проверка подписи не нужна — достаточно вытащить plist между
 * маркерами <?xml ... </plist>, как это делает сам Xcode.
 */
function parseProvisioningProfile(profilePath) {
  try {
    const raw = fs.readFileSync(profilePath);
    const start = raw.indexOf(Buffer.from('<?xml'));
    const end = raw.indexOf(Buffer.from('</plist>'));
    if (start === -1 || end === -1) return null;
    const xml = raw.subarray(start, end + '</plist>'.length).toString('utf8');
    const { value } = plist.parseXmlPlist(xml);
    if (!value) return null;

    const expires = value.ExpirationDate ? new Date(value.ExpirationDate) : null;
    const daysLeft = expires ? Math.floor((expires.getTime() - Date.now()) / 86400000) : null;

    return {
      uuid: value.UUID || null,
      name: value.Name || null,
      teamName: value.TeamName || null,
      teamId: (value.TeamIdentifier && value.TeamIdentifier[0]) || null,
      applicationIdentifier: value.Entitlements && value.Entitlements['application-identifier'],
      expirationDate: expires,
      daysLeft,
      expired: daysLeft !== null && daysLeft < 0,
      provisionedDevices: value.ProvisionedDevices ? value.ProvisionedDevices.length : 0,
      isEnterprise: Boolean(value.ProvisionsAllDevices),
      isFreeAccount: Boolean(
        value.Entitlements && value.Entitlements['get-task-allow'] && !value.ProvisionsAllDevices,
      ),
      getTaskAllow: Boolean(value.Entitlements && value.Entitlements['get-task-allow']),
      platforms: value.Platform || [],
    };
  } catch {
    return null;
  }
}

/** Swift-рантайм отличается от пользовательских фреймворков префиксом libswift*. */
function isSwiftRuntime(name) {
  return /^libswift[A-Za-z0-9_]*\.dylib$/.test(name);
}

/**
 * Собрать .ipa.
 *
 * @param {object} options
 * @param {string} options.appPath       путь к .app (или .xcarchive — разберётся сам)
 * @param {string} options.outputPath    куда положить .ipa
 * @param {'development'|'appstore'} [options.mode]
 *        development — для установки на устройство (симптом: Swift-библиотеки остаются внутри .app).
 *        appstore    — для отправки в App Store (Swift-библиотеки выносятся в SwiftSupport/).
 * @param {string|null} [options.swiftSupportPath]
 * @param {string|null} [options.dsymDir]
 * @param {boolean} [options.includeSymbols]
 * @param {object|null} [options.iTunesMetadata]
 * @param {(p: {phase: string, current: number, total: number, file: string}) => void} [options.onProgress]
 */
async function buildIpa(options) {
  const {
    outputPath,
    mode = 'development',
    swiftSupportPath = null,
    dsymDir = null,
    includeSymbols = false,
    iTunesMetadata = null,
    onProgress = null,
  } = options;

  if (!outputPath) throw new Error(t('issue.noOutputPath'));

  // Разрешаем передать как .app, так и .xcarchive.
  const resolved = resolveAppFromArchive(options.appPath || options.archivePath);
  const appPath = resolved.appPath;
  const appName = path.basename(appPath);
  const swiftDir = swiftSupportPath || resolved.swiftSupport;
  // dSYM ищем в архиве, если путь не задан явно: иначе символы молча теряются.
  const symbolsDir = dsymDir || resolved.dsymDir;

  const bundle = inspectBundle(appPath);

  // Предварительный проход: собираем план упаковки и считаем объём для прогресса.
  const plan = [];
  let totalFiles = 0;
  let totalBytes = 0;

  const walkDir = (dir, zipPrefix) => {
    plan.push({ kind: 'dir', zipPath: zipPrefix, sourcePath: dir });
    totalFiles += 1;
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const childFull = path.join(dir, dirent.name);
      const childZip = `${zipPrefix}/${dirent.name}`;
      const childStat = statSafe(childFull);
      if (!childStat) continue;

      if (childStat.isSymbolicLink()) {
        plan.push({ kind: 'symlink', zipPath: childZip, target: fs.readlinkSync(childFull) });
        totalFiles += 1;
      } else if (childStat.isDirectory()) {
        walkDir(childFull, childZip);
      } else if (childStat.isFile()) {
        totalFiles += 1;
        totalBytes += childStat.size;
        plan.push({
          kind: 'file',
          zipPath: childZip,
          sourcePath: childFull,
          size: childStat.size,
          mode: modeForFile(childFull),
        });
      }
    }
  };

  const rootStat = statSafe(appPath);
  if (!rootStat || !rootStat.isDirectory()) throw new Error(t('issue.appDirNotFound', { path: appPath }));

  // Корень самого .app — отдельная запись Payload/MyApp.app/
  plan.push({ kind: 'dir', zipPath: `Payload/${appName}`, sourcePath: appPath });
  totalFiles += 1;

  const skipSwift = mode === 'appstore';
  for (const dirent of fs.readdirSync(appPath, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const childFull = path.join(appPath, dirent.name);
    const childZip = `Payload/${appName}/${dirent.name}`;
    const childStat = statSafe(childFull);
    if (!childStat) continue;

    if (childStat.isSymbolicLink()) {
      plan.push({ kind: 'symlink', zipPath: childZip, target: fs.readlinkSync(childFull) });
      totalFiles += 1;
    } else if (childStat.isDirectory()) {
      if (skipSwift && dirent.name === 'Frameworks') {
        // Frameworks обрабатываем отдельно: часть файлов уедет в SwiftSupport.
        plan.push({ kind: 'dir', zipPath: childZip, sourcePath: childFull });
        for (const fw of fs.readdirSync(childFull, { withFileTypes: true })) {
          const fwFull = path.join(childFull, fw.name);
          if (fw.isFile() && isSwiftRuntime(fw.name)) continue; // -> SwiftSupport
          if (fw.isSymbolicLink()) {
            plan.push({ kind: 'symlink', zipPath: `${childZip}/${fw.name}`, target: fs.readlinkSync(fwFull) });
            totalFiles += 1;
          } else if (fw.isDirectory()) {
            walkDir(fwFull, `${childZip}/${fw.name}`);
          } else if (fw.isFile()) {
            const st = statSafe(fwFull);
            totalFiles += 1;
            totalBytes += st.size;
            plan.push({
              kind: 'file',
              zipPath: `${childZip}/${fw.name}`,
              sourcePath: fwFull,
              size: st.size,
              mode: modeForFile(fwFull),
            });
          }
        }
      } else {
        walkDir(childFull, childZip);
      }
    } else if (childStat.isFile()) {
      totalFiles += 1;
      totalBytes += childStat.size;
      plan.push({
        kind: 'file',
        zipPath: childZip,
        sourcePath: childFull,
        size: childStat.size,
        mode: modeForFile(childFull),
      });
    }
  }

  // SwiftSupport (только appstore): библиотеки берём из архива, а не из бандла.
  if (skipSwift && swiftDir && fs.existsSync(swiftDir)) {
    plan.push({ kind: 'dir', zipPath: 'SwiftSupport', sourcePath: swiftDir });
    plan.push({ kind: 'dir', zipPath: 'SwiftSupport/iphoneos', sourcePath: swiftDir });
    totalFiles += 2;
    for (const dirent of fs.readdirSync(swiftDir, { withFileTypes: true })) {
      if (!dirent.isFile()) continue;
      const full = path.join(swiftDir, dirent.name);
      const st = statSafe(full);
      totalFiles += 1;
      totalBytes += st.size;
      plan.push({
        kind: 'file',
        zipPath: `SwiftSupport/iphoneos/${dirent.name}`,
        sourcePath: full,
        size: st.size,
        mode: FILE_MODE_EXEC,
      });
    }
  }

  // dSYM для символизации крашей — по желанию.
  if (includeSymbols && symbolsDir && fs.existsSync(symbolsDir)) {
    const symsPlan = [];
    const collectDsym = (dir, zipPrefix) => {
      symsPlan.push({ kind: 'dir', zipPath: zipPrefix, sourcePath: dir });
      for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, dirent.name);
        const zip = `${zipPrefix}/${dirent.name}`;
        const st = statSafe(full);
        if (st.isSymbolicLink()) {
          symsPlan.push({ kind: 'symlink', zipPath: zip, target: fs.readlinkSync(full) });
        } else if (st.isDirectory()) {
          collectDsym(full, zip);
        } else if (st.isFile()) {
          symsPlan.push({
            kind: 'file',
            zipPath: zip,
            sourcePath: full,
            size: st.size,
            mode: FILE_MODE_DATA,
          });
        }
      }
    };
    for (const d of fs.readdirSync(symbolsDir, { withFileTypes: true })) {
      if (d.isDirectory()) collectDsym(path.join(symbolsDir, d.name), `Symbols/${d.name}`);
    }
    plan.push(...symsPlan);
  }

  // iTunesMetadata.plist нужен для OTA/сторонних установщиков.
  if (iTunesMetadata) {
    plan.push({ kind: 'buffer', zipPath: 'iTunesMetadata.plist', data: Buffer.from(plist.toXmlPlist(iTunesMetadata), 'utf8') });
    totalFiles += 1;
    totalBytes += 128;
  }

  // --- запись архива ---
  const outputDir = path.dirname(path.resolve(outputPath));
  fs.mkdirSync(outputDir, { recursive: true });
  const tmpPath = `${outputPath}.part`;
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

  const writer = new ZipWriter(tmpPath, { level: 6 });
  let processedBytes = 0;
  let processedFiles = 0;

  try {
    // Payload/ как явная запись каталога.
    writer.addDirectory('Payload', DIR_MODE);

    for (const item of plan) {
      if (item.kind === 'dir') {
        writer.addDirectory(item.zipPath, DIR_MODE, statSafe(item.sourcePath)?.mtime || new Date());
        processedFiles += 1;
      } else if (item.kind === 'symlink') {
        writer.addSymlink(item.zipPath, item.target);
        processedFiles += 1;
      } else if (item.kind === 'buffer') {
        writer.addBuffer(item.zipPath, item.data);
        processedFiles += 1;
      } else if (item.kind === 'file') {
        await writer.addFileFromPath(
          item.zipPath,
          item.sourcePath,
          item.mode,
          statSafe(item.sourcePath)?.mtime || new Date(),
        );
        processedBytes += item.size;
        processedFiles += 1;
      }

      if (onProgress && (processedFiles % 25 === 0 || item.kind === 'file')) {
        onProgress({
          phase: 'pack',
          current: processedBytes,
          total: totalBytes,
          files: processedFiles,
          totalFiles,
          file: item.zipPath,
        });
      }
    }

    const result = writer.close();
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    fs.renameSync(tmpPath, outputPath);

    const ipaStat = fs.statSync(outputPath);
    return {
      outputPath,
      appName,
      bundle,
      mode,
      entries: result.entries,
      totalFiles,
      uncompressedBytes: totalBytes,
      ipaBytes: ipaStat.size,
      swiftDylibsMoved: skipSwift,
      symbolsIncluded: Boolean(includeSymbols && symbolsDir),
      iTunesMetadataIncluded: Boolean(iTunesMetadata),
    };
  } catch (err) {
    try {
      if (writer && !writer.closed) fs.closeSync(writer.fd);
    } catch {
      /* уже закрыт */
    }
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* не критично */
      }
    }
    throw err;
  }
}

/**
 * Проверить готовый .ipa: структура, права на исполняемый файл, подпись.
 * Возвращает отчёт, чтобы UI показал проблемы до установки на устройство.
 */
function verifyIpa(ipaPath) {
  const entries = readZipDirectory(ipaPath);
  const issues = [];
  const notes = [];

  const payloadRoots = entries.filter((e) => /^Payload\/[^/]+\/$/.test(e.name));
  if (payloadRoots.length === 0) {
    issues.push(t('issue.noPayload'));
  } else if (payloadRoots.length > 1) {
    issues.push(`В Payload несколько приложений (${payloadRoots.length}) — установщик возьмёт только одно`);
  }

  const appRoot = payloadRoots[0] ? payloadRoots[0].name.replace(/\/$/, '') : null;

  entries
    .filter((e) => e.name.startsWith('Payload/') && !e.name.endsWith('/'))
    .forEach((e) => {
      if (e.uncompressedSize === 0 && !e.isSymlink) notes.push(t('issue.emptyFile', { name: e.name }));
    });

  if (appRoot) {
    const executableEntries = entries.filter(
      (e) => !e.name.endsWith('/') && !e.isSymlink && (e.mode & 0o111) !== 0,
    );
    if (executableEntries.length === 0) {
      issues.push(t('issue.nonExecutable'));
    }

    const infoEntry = entries.find((e) => e.name === `${appRoot}/Info.plist`);
    if (!infoEntry) issues.push(t('issue.noInfoPlistShort'));

    const signature = entries.find((e) => e.name.startsWith(`${appRoot}/_CodeSignature/`));
    if (!signature) {
      issues.push(t('issue.notSigned'));
    }

    const provisioning = entries.find((e) => e.name === `${appRoot}/embedded.mobileprovision`);
    if (!provisioning) {
      issues.push(t('issue.noProvisioning'));
    } else {
      notes.push(t('issue.provisioningPresent'));
    }
  }

  if (entries.some((e) => e.name.startsWith('SwiftSupport/'))) {
    notes.push(t('issue.swiftSupportPresent'));
  }

  return {
    path: ipaPath,
    ok: issues.length === 0,
    totalEntries: entries.length,
    appRoot,
    issues,
    notes,
    sizeBytes: fs.statSync(ipaPath).size,
    entries,
  };
}

/** Быстрый разбор .xcarchive без упаковки — для окна «Информация о сборке». */
/**
 * Собрать .xcarchive из готового .app.
 *
 * Порядок как в Xcode: сначала архив, затем из него .ipa. Архив остаётся на
 * диске — из него можно собрать .ipa повторно, уже с другой подписью.
 *
 * @param {{appPath: string, outputPath?: string, name?: string, scheme?: string,
 *          dsymPath?: string, swiftSupportPath?: string, onOutput?: Function}} options
 */
function buildArchive(options) {
  const log = options.onOutput || (() => {});

  if (!options.appPath || !fs.existsSync(options.appPath)) {
    throw new Error(`не найдено приложение: ${options.appPath}`);
  }

  const appName = options.name || path.basename(options.appPath, '.app');
  const archivePath =
    options.outputPath || path.join(path.dirname(options.appPath), `${appName}.xcarchive`);

  // Архив собираем с нуля: обломки прошлой сборки только мешают.
  fs.rmSync(archivePath, { recursive: true, force: true });

  const productsDir = path.join(archivePath, 'Products', 'Applications');
  fs.mkdirSync(productsDir, { recursive: true });

  log(`Упаковываю ${appName} в архив…\n`);
  copyDirectory(options.appPath, path.join(productsDir, path.basename(options.appPath)));

  // --- символы отладки ---
  let hasDsym = false;
  const dsymDir = path.join(archivePath, 'dSYMs');
  fs.mkdirSync(dsymDir, { recursive: true });

  if (options.dsymPath && fs.existsSync(options.dsymPath)) {
    copyDirectory(options.dsymPath, path.join(dsymDir, path.basename(options.dsymPath)));
    hasDsym = true;
    log(`  символы: ${path.basename(options.dsymPath)}\n`);
  }

  // --- библиотеки Swift ---
  let hasSwift = false;
  if (options.swiftSupportPath && fs.existsSync(options.swiftSupportPath)) {
    const swiftDir = path.join(archivePath, 'SwiftSupport');
    fs.mkdirSync(swiftDir, { recursive: true });

    for (const entry of fs.readdirSync(options.swiftSupportPath, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      fs.copyFileSync(
        path.join(options.swiftSupportPath, entry.name),
        path.join(swiftDir, entry.name),
      );
      hasSwift = true;
    }
  }

  // --- описание архива ---
  const appInArchive = path.join(productsDir, path.basename(options.appPath));
  const bundle = inspectBundle(appInArchive);

  plist.writeXmlPlistFile(path.join(archivePath, 'Info.plist'), {
    ArchiveVersion: 2,
    Name: appName,
    SchemeName: options.scheme || appName,
    CreationDate: new Date(),
    ApplicationProperties: {
      ApplicationPath: `Applications/${path.basename(options.appPath)}`,
      ArchiveVersion: 2,
      CFBundleIdentifier: bundle.bundleId || '',
      CFBundleShortVersionString: bundle.shortVersion || '',
      CFBundleVersion: bundle.version || '',
    },
  });

  log(`  архив: ${archivePath}\n`);

  return { ok: true, archivePath, appPath: appInArchive, dsym: hasDsym, swift: hasSwift };
}

/** Скопировать каталог с сохранением символических ссылок. */
function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);

    if (entry.isSymbolicLink()) {
      // Внутри .framework ссылки Versions/Current -> A обязательны.
      const target = fs.readlinkSync(from);
      try {
        fs.symlinkSync(target, to);
      } catch {
        // Windows без прав на ссылки: копируем то, на что она указывает.
        try {
          const resolved = path.resolve(path.dirname(from), target);
          if (fs.statSync(resolved).isDirectory()) copyDirectory(resolved, to);
          else fs.copyFileSync(resolved, to);
        } catch {
          /* пропускаем нечитаемое */
        }
      }
      continue;
    }

    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

function inspectArchive(archivePath) {
  const { appPath, archiveInfo, swiftSupport, dsymDir } = resolveAppFromArchive(archivePath);
  const bundle = inspectBundle(appPath);

  const archiveSummary = archiveInfo
    ? {
        name: archiveInfo.Name || null,
        scheme: archiveInfo.SchemeName || null,
        creationDate: archiveInfo.CreationDate || null,
        version: archiveInfo.ArchiveVersion || null,
        applicationProperties: archiveInfo.ApplicationProperties || null,
      }
    : null;

  let swiftDylibs = [];
  if (swiftSupport && fs.existsSync(swiftSupport)) {
    swiftDylibs = fs
      .readdirSync(swiftSupport, { withFileTypes: true })
      .filter((d) => d.isFile() && isSwiftRuntime(d.name))
      .map((d) => d.name);
  }

  let dsyms = [];
  if (dsymDir && fs.existsSync(dsymDir)) {
    dsyms = fs.readdirSync(dsymDir, { withFileTypes: true }).map((d) => d.name);
  }

  return { appPath, bundle, archiveSummary, swiftSupportPath: swiftSupport, swiftDylibs, dsymDir, dsyms };
}

module.exports = {
  buildArchive,
  buildIpa,
  verifyIpa,
  inspectArchive,
  inspectBundle,
  resolveAppFromArchive,
  parseProvisioningProfile,
  isMachO,
  isSwiftRuntime,
  zipDirectory,
  readZipDirectory,
};
