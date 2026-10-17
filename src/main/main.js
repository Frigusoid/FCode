'use strict';
/*
 * Главный процесс Electron: окно, меню и IPC-мост к renderer'у.
 *
 * Весь доступ к файловой системе идёт только отсюда. Renderer работает в
 * изолированном контексте (contextIsolation) и не имеет доступа к Node —
 * это обязательное требование безопасности Electron.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const workspace = require('./modules/workspace');
const packager = require('./modules/packager');
const { extractZip } = require('./modules/zip');
const tools = require('./modules/tools');
const xtool = require('./modules/xtool');
const { LspClient } = require('./modules/lsp');
const interactive = require('./modules/interactive');
const scaffold = require('./modules/scaffold');
const search = require('./modules/search');
const swift = require('./modules/swift');
const requirements = require('./modules/requirements');
const xcode = require('./modules/xcode');
const converter = require('./modules/converter');
const zsign = require('./modules/zsign');
const setup = require('./modules/setup');
const i18n = require('../shared/i18n');
const { t } = i18n;

const APP_NAME = 'Fcode';
const APP_VERSION = require('../../package.json').version;

/** @type {BrowserWindow|null} */
let mainWindow = null;
let currentWorkspacePath = null;
/** @type {import('./modules/lsp').LspClient|null} */
let lspClient = null;

// ------------------------------------------------------------------ окно

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#16121f',
    title: APP_NAME,
    // build/icon.ico собран из FCodeIcon.png скриптом scripts/make-icons.py
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Внешние ссылки открываем в системном браузере, а не внутри приложения.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ------------------------------------------------------- обёртка над IPC

/**
 * Все обработчики возвращают {ok, data} либо {ok, error}.
 * Так renderer никогда не получает необработанное исключение и всегда может
 * показать пользователю внятное сообщение.
 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(event, ...args) };
    } catch (err) {
      return {
        ok: false,
        error: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : null,
      };
    }
  });
}

function registerHandlers() {
  // --- общее ---
  handle('app:info', () => ({
    name: APP_NAME,
    version: APP_VERSION,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    workspace: currentWorkspacePath,
  }));

  handle('tools:check', () => tools.detectAll());

  // Язык интерфейса влияет и на сообщения главного процесса, поэтому
  // интерфейс сообщает о смене языка сюда.
  handle('app:setLanguage', (_event, language) => i18n.setLanguage(language));

  // --- рабочее пространство ---
  handle('workspace:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('menu.openFolder'),
      properties: ['openDirectory'],
      buttonLabel: t('dialog.openFolderButton'),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return loadWorkspace(result.filePaths[0]);
  });

  handle('workspace:load', (_event, dirPath) => loadWorkspace(dirPath));

  handle('workspace:refresh', () => {
    if (!currentWorkspacePath) return null;
    return loadWorkspace(currentWorkspacePath, { keepPath: true });
  });

  // --- файлы ---
  handle('file:read', (_event, filePath) => workspace.readTextFile(filePath));

  handle('file:save', (_event, filePath, text) => workspace.writeTextFile(filePath, text));

  handle('file:create', (_event, filePath) => workspace.createFile(filePath));
  handle('dir:create', (_event, dirPath) => workspace.createDirectory(dirPath));
  handle('entry:rename', (_event, from, to) => workspace.renameEntry(from, to));
  handle('entry:delete', (_event, target) => workspace.deleteEntry(target));

  handle('shell:reveal', (_event, target) => {
    shell.showItemInFolder(path.resolve(target));
    return true;
  });

  /**
   * Открыть ссылку или файл.
   *
   * Ссылку нельзя передавать в shell.openPath: там путь приводится к виду
   * Windows, и адрес превращается в «D:\FCode\https:\github.com\...» — система
   * сообщает, что файл не найден. Проверяем схему и для ссылок открываем браузер.
   */
  handle('shell:openPath', async (_event, target) => {
    if (!target) return false;

    const text = String(target);

    if (/^https?:\/\//i.test(text) || /^mailto:/i.test(text)) {
      await shell.openExternal(text);
      return true;
    }

    const error = await shell.openPath(path.resolve(text));
    if (error) throw new Error(error);
    return true;
  });

  // --- архивы и .ipa ---
  /**
   * Выбрать архив в системном диалоге.
   *
   * Фильтров здесь намеренно нет. .xcarchive в Windows — обычная папка, а
   * фильтр «только zip» не даёт её выбрать. Без фильтра видно и папки, и файлы,
   * поэтому открывается и распакованный архив, и скачанный zip, и готовый .app.
   */
  handle('archive:choose', async () => {
    // Именно файл, а не папка: чаще всего архив скачан одним .zip.
    // Раньше здесь стоял openDirectory, и выбрать файл было нельзя.
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('dialog.chooseArchiveTitle'),
      properties: ['openFile'],
      filters: [
        { name: t('dialog.archiveFilter'), extensions: ['zip', 'ipa'] },
        { name: t('dialog.allFiles'), extensions: ['*'] },
      ],
      buttonLabel: t('dialog.chooseArchiveButton'),
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    return openArchive(result.filePaths[0]);
  });

  // Распакованный .xcarchive — это папка, для него отдельное действие.
  handle('archive:chooseFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('dialog.chooseArchiveFolderTitle'),
      properties: ['openDirectory'],
      buttonLabel: t('dialog.chooseArchiveButton'),
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    return openArchive(result.filePaths[0]);
  });

  // Открыть архив по уже известному пути: перетаскиванием или из строки ввода.
  handle('archive:open', (_event, targetPath) => openArchive(targetPath));

  // Разбор содержимого без распаковки — если путь уже указывает на каталог.
  handle('archive:inspect', (_event, archivePath) => packager.inspectArchive(archivePath));

  handle('ipa:build', async (_event, options) => {
    if (!options || !options.archivePath) throw new Error(t('main.noArchivePath'));

    const outputPath =
      options.outputPath ||
      path.join(
        path.dirname(options.archivePath),
        `${path.basename(options.archivePath).replace(/\.xcarchive$/i, '')}.ipa`,
      );

    send('ipa:progress', { phase: 'start', outputPath });

    const result = await packager.buildIpa({
      appPath: options.archivePath,
      outputPath,
      mode: options.mode === 'appstore' ? 'appstore' : 'development',
      includeSymbols: Boolean(options.includeSymbols),
      onProgress: (progress) => send('ipa:progress', progress),
    });

    send('ipa:progress', { phase: 'done', outputPath });
    return result;
  });

  /**
   * Полный конвейер: исходники -> .xcarchive -> .ipa.
   *
   * Так же, как в Xcode: сначала собирается архив со всеми символами, и уже из
   * него делается .ipa. Архив остаётся на диске — из него можно собрать .ipa
   * повторно, например после смены подписи.
   */
  handle('build:fromSource', async (_event, options) => {
    const settings = options || {};
    if (!currentWorkspacePath) throw new Error(t('main.noWorkspace'));

    const projectName = path.basename(currentWorkspacePath);
    const outputDir = settings.outputDir || path.join(currentWorkspacePath, 'build');

    // --- шаг 1: сборка приложения ---
    send('xtool:output', { stream: 'meta', text: `${t('pipeline.building')}\n` });

    const built = await xtool.build({
      projectPath: currentWorkspacePath,
      distro: settings.distro,
      mode: 'build',
      configuration: settings.configuration === 'release' ? 'release' : 'debug',
      ipa: false,
      onOutput: (text) => send('xtool:output', { stream: 'build', text }),
    });

    if (!built.ok) return { ok: false, stage: 'build', code: built.code };

    // xtool собирает .app внутри зеркала — находим его.
    const appPath = await xtool.findBuiltApp({
      mirrorPath: built.mirrorPath,
      distro: settings.distro,
    });

    if (!appPath) throw new Error(t('pipeline.noApp'));

    send('xtool:output', { stream: 'build', text: `${t('pipeline.appFound', { path: appPath })}\n` });

    // --- шаг 2: переносим .app в папку проекта ---
    fs.mkdirSync(outputDir, { recursive: true });
    const localApp = await xtool.copyFromWsl({
      wslPath: appPath,
      windowsDir: outputDir,
      distro: settings.distro,
    });

    // --- шаг 3: собираем .xcarchive ---
    const archive = packager.buildArchive({
      appPath: localApp,
      outputPath: path.join(outputDir, `${projectName}.xcarchive`),
      name: projectName,
      scheme: projectName,
      onOutput: (text) => send('xtool:output', { stream: 'build', text }),
    });

    send('archive:ready', { path: archive.archivePath });

    // --- шаг 4: упаковываем .ipa из архива ---
    send('xtool:output', { stream: 'meta', text: `${t('pipeline.packing')}\n` });
    send('ipa:progress', { phase: 'start' });

    const ipaPath = path.join(outputDir, `${projectName}.ipa`);

    const ipa = await packager.buildIpa({
      appPath: archive.archivePath,
      outputPath: ipaPath,
      mode: settings.mode === 'appstore' ? 'appstore' : 'development',
      onProgress: (progress) => send('ipa:progress', progress),
    });

    send('ipa:progress', { phase: 'done', outputPath: ipaPath });

    return {
      ok: true,
      stage: 'done',
      archivePath: archive.archivePath,
      ipaPath: ipa.outputPath || ipaPath,
      appPath: localApp,
      bundle: archive.bundle || null,
    };
  });

  handle('ipa:verify', (_event, ipaPath) => {
    const report = packager.verifyIpa(ipaPath);
    // Полный список записей renderer'у не нужен — он тяжёлый.
    const { entries, ...summary } = report;
    return summary;
  });

  handle('ipa:chooseFile', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('dialog.chooseIpaTitle'),
      filters: [{ name: t('dialog.archiveFilter'), extensions: ['ipa'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const ipaPath = result.filePaths[0];
    const report = packager.verifyIpa(ipaPath);
    const { entries, ...summary } = report;
    return { path: ipaPath, report: summary };
  });

  handle('dialog:saveIpa', async (_event, defaultName) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: t('dialog.saveIpaTitle'),
      defaultPath: defaultName || 'App.ipa',
      filters: [{ name: t('dialog.archiveFilter'), extensions: ['ipa'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  // --- автоматическая установка всего необходимого ---
  handle('xtool:autoSetup', async (_event, options) => {
    send('xtool:output', { stream: 'meta', text: `${t('linux.autoStarted')}\n` });
    send('xtool:output', { stream: 'meta', text: `${t('linux.elevateNote')}\n` });

    return setup.autoSetup({
      distro: options ? options.distro : undefined,
      onOutput: (text) => send('xtool:output', { stream: 'build', text }),
      onStep: (step) => send('xtool:step', step),
    });
  });

  handle('xtool:elevated', () => setup.isElevated());

  // --- подпись через zsign ---
  handle('zsign:status', () =>
    zsign.check(app.getPath('userData')),
  );

  handle('zsign:install', async () => {
    const result = await zsign.install({
      userDataPath: app.getPath('userData'),
      onOutput: (text) => send('xtool:output', { stream: 'build', text }),
    });
    return result;
  });

  handle('zsign:resign', async (_event, options) => {
    const settings = options || {};
    const result = await zsign.resign({
      ...settings,
      userDataPath: app.getPath('userData'),
      onOutput: (text) => send('xtool:output', { stream: 'build', text }),
    });
    return result;
  });

  handle('zsign:chooseP12', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('zsign.chooseP12'),
      properties: ['openFile'],
      filters: [{ name: t('zsign.p12Filter'), extensions: ['p12', 'pfx'] }],
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  handle('zsign:chooseProvision', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('zsign.chooseProvision'),
      properties: ['openFile'],
      filters: [{ name: t('zsign.provisionFilter'), extensions: ['mobileprovision'] }],
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  // --- скачивание iOS SDK ---

  /**
   * Найти уже скачанный Xcode.xip.
   *
   * Прямой ссылки на Xcode не существует: Apple отдаёт файл только после входа
   * в учётную запись. Поэтому Fcode открывает страницу загрузки, а затем сам
   * ищет файл в папке «Загрузки» — вводить путь руками не нужно.
   */
  handle('sdk:findDownload', () => {
    // Папку приложения тоже смотрим: пользователи часто качают Xcode прямо
    // рядом с проектом, а не в «Загрузки».
    const candidates = [
      path.join(app.getPath('downloads')),
      app.getPath('home'),
      path.join(app.getPath('home'), 'Desktop'),
      path.join(app.getPath('temp'), 'fcode-sdk'),
      process.cwd(),
      app.isPackaged ? path.dirname(app.getPath('exe')) : process.cwd(),
    ].filter((dir, index, all) => dir && all.indexOf(dir) === index);

    const found = [];
    for (const dir of candidates) {
      if (!fs.existsSync(dir)) continue;

      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/^xcode.*\.xip$/i.test(entry.name)) continue;

        const full = path.join(dir, entry.name);
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* файл мог исчезнуть */
        }

        found.push({ path: full, name: entry.name, size });
      }
    }

    // Свежие файлы первыми: скорее всего нужен последний скачанный.
    found.sort((a, b) => b.size - a.size);
    return found;
  });

  handle('sdk:downloadsFolder', () => app.getPath('downloads'));

  // --- проекты Xcode ---
  handle('xcode:analyze', (_event, projectPath) => {
    const target = projectPath || currentWorkspacePath;
    if (!target) throw new Error(t('main.noWorkspace'));
    return xcode.analyzeProject(target);
  });

  handle('xcode:convert', (_event, options) => {
    const settings = options || {};
    const target = settings.projectPath || currentWorkspacePath;
    if (!target) throw new Error(t('main.noWorkspace'));
    return xcode.convertProject(target, settings);
  });

  // Полная конвертация: раскладывает исходники и ресурсы в Sources/, переносит
  // вложенные пакеты, снимает то, на чём сборка заведомо спотыкается.
  // Отдельно от xcode:convert, который только собирает текст манифеста.
  handle('xcode:convertFull', (_event, options) => {
    const settings = options || {};
    const target = settings.projectPath || currentWorkspacePath;
    if (!target) throw new Error(t('main.noWorkspace'));
    return converter.convert(target, settings);
  });

  // Можно ли собрать эту папку и что для этого нужно сделать.
  handle('xcode:probe', (_event, projectPath) => {
    const target = projectPath || currentWorkspacePath;
    if (!target) return { kind: 'none' };
    if (converter.isConverted(target)) return { kind: 'swiftpm' };
    if (converter.isXcodeProject(target)) {
      return { kind: 'xcode', needsConversion: true };
    }
    return { kind: 'plain' };
  });

/**
 * Сведения о программе.
 *
 * Собираются в главном процессе: версию знает Electron, а список сторонних
 * библиотек должен быть в одном месте, а не разбросан по интерфейсу.
 */
function aboutInfo() {
  const pkg = require("../../package.json");

  return {
    name: pkg.productName || pkg.name,
    version: pkg.version,
    author: pkg.author,
    license: pkg.license,
    description: pkg.description,
    // Ссылка на исходники: её показывают окна «О программе» и настройки.
    repository: 'https://github.com/Frigusoid/FCode',
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,

    // Библиотеки других авторов. Без первых двух собрать приложение под iOS
    // на Windows было бы невозможно, поэтому они идут первыми.
    credits: [
      {
        name: "xtool",
        author: "xtool-org",
        license: "MIT",
        role: "Собирает, подписывает и ставит приложение: замена Xcode на Linux.",
        url: "https://github.com/xtool-org/xtool",
      },
      {
        name: "Swift",
        author: "Apple Inc.",
        license: "Apache 2.0",
        role: "Компилятор языка и стандартная библиотека.",
        url: "https://swift.org",
      },
      {
        name: "CodeMirror 6",
        author: "Marijn Haverbeke и участники",
        license: "MIT",
        role: "Редактор кода с подсветкой и автодополнением.",
        url: "https://codemirror.net",
      },
      {
        name: "Electron",
        author: "OpenJS Foundation",
        license: "MIT",
        role: "Окно приложения и связь с системой.",
        url: "https://electronjs.org",
      },
      {
        name: "esbuild",
        author: "Evan Wallace",
        license: "MIT",
        role: "Сборка интерфейса.",
        url: "https://esbuild.github.io",
      },
      {
        name: "zsign",
        author: "zhlynn",
        license: "MIT",
        role: "Переподпись .ipa на Windows, когда нужен свой сертификат.",
        url: "https://github.com/zhlynn/zsign",
      },
      {
        name: "sourcekit-lsp",
        author: "Apple Inc.",
        license: "Apache 2.0",
        role: "Подсказки, переходы и ошибки прямо в редакторе.",
        url: "https://github.com/swiftlang/sourcekit-lsp",
      },
      {
        name: "Sideloadly",
        author: "Sideloadly",
        license: "свободная",
        role: "Установка готового .ipa на iPhone.",
        url: "https://sideloadly.io",
      },
    ],
  };
}

  // --- требования и iOS SDK ---
  handle('about:info', () => aboutInfo());

  handle('requirements:check', (_event, distroName) => requirements.check({ distro: distroName }));

  // Пошаговое руководство: что скачать и поставить на новом компьютере.
  handle('requirements:guide', (_event, distroName) =>
    requirements.setupGuide({ distro: distroName }),
  );

  // Sideloadly нужен только для установки на iPhone — для сборки не требуется.
  handle('sideloadly:find', () => requirements.findSideloadly());

  handle('sideloadly:download', () => {
    shell.openExternal('https://sideloadly.io');
    return { opened: true };
  });

  // Открыть Sideloadly с готовым .ipa: дальше пользователь вводит Apple ID.
  handle('sideloadly:launch', (_event, options) =>
    requirements.launchSideloadly(options || {}),
  );

  // Показать готовый .ipa в проводнике.
  handle('shell:revealPath', (_event, targetPath) => {
    if (targetPath && fs.existsSync(targetPath)) shell.showItemInFolder(targetPath);
    return true;
  });

  handle('sdk:instructions', (_event, options) => requirements.sdkInstructions(options || {}));

  handle('sdk:chooseFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('sdk.chooseFolderTitle'),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: t('sdk.chooseFolderButton'),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Дописать triple системы в info.json бандла SDK. Без этого на новой машине
  // сборка падает с «No Swift SDK found», хотя `swift sdk list` показывает darwin.
  handle('requirements:fixSdkHost', async (_event, options) => {
    const settings = options || {};
    return requirements.repairSdkHostTriple({
      distro: settings.distro,
      onOutput: (text) => send('xtool:output', { stream: 'build', text }),
    });
  });

  // Что именно скармливать xtool sdk install: .xip, Xcode.app или папку с ними.
  // Без этого интерфейс приписывал «\Xcode.app» к любой выбранной папке.
  handle('sdk:resolveSource', (_event, selected) => requirements.resolveSdkSource(selected));

  // Выбор самого архива Xcode: .xip или папки Xcode.app.
  // Отдельно от chooseFolder, потому что пользователю нужно указать файл,
  // а не папку — раньше вставить путь к скачанному .xip было некуда.
  handle('sdk:chooseFile', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('sdk.pickTitle'),
      // Можно выбрать и файл .xip, и папку с уже распакованным Xcode.app.
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Xcode', extensions: ['xip'] }],
      buttonLabel: t('sdk.choose'),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  handle('sdk:install', async (_event, options) => {
    const settings = options || {};
    if (!settings.path) throw new Error(t('sdk.needPath'));

    send('xtool:output', { stream: 'meta', text: `${t('sdk.installing')}\n` });

    const result = await requirements.installSdk(settings.path, {
      distro: settings.distro,
      slim: settings.slim !== false,
      onOutput: (text) => send('xtool:output', { stream: 'build', text }),
    });

    return { ok: result.ok, code: result.code };
  });

  // --- сборка без Xcode: xtool в подсистеме Linux ---
  handle('xtool:check', (_event, distro) => xtool.checkEnvironment(distro));

  handle('xtool:build', async (_event, options) => {
    if (!options || !options.projectPath) throw new Error(t('main.noProjectPath'));
    send('xtool:output', {
      stream: 'meta',
      text: t('main.xtoolStarting', { distro: options.distro || xtool.DEFAULT_DISTRO }),
    });
    const result = await xtool.build({
      projectPath: options.projectPath,
      distro: options.distro,
      action: options.action,
      onOutput: (text) => send('xtool:output', { stream: 'build', text }),
    });
    return { ok: result.ok, code: result.code, command: result.command };
  });

  handle('xtool:new', async (_event, options) => {
    if (!options || !options.projectPath) throw new Error(t('main.noProjectPath'));
    const result = await xtool.createProject({
      projectPath: options.projectPath,
      name: options.name,
      distro: options.distro,
      onOutput: (text) => send('xtool:output', { stream: 'build', text }),
    });
    return { ok: result.ok, code: result.code, command: result.command };
  });

  handle('xtool:install', async (_event, options) => {
    if (!options || !options.ipaPath) throw new Error(t('main.noIpaPath'));
    const result = await xtool.installIpa({
      ipaPath: options.ipaPath,
      distro: options.distro,
      onOutput: (text) => send('xtool:output', { stream: 'build', text }),
    });
    return { ok: result.ok, code: result.code, command: result.command };
  });

  handle('xtool:devices', (_event, distro) => xtool.listDevices(distro));
  handle('xtool:authStatus', (_event, distro) => xtool.authStatus(distro));
  handle('xtool:logout', (_event, distro, reset2fa) => xtool.logout(distro, Boolean(reset2fa)));
  handle('xtool:ds', (_event, subcommand, distro) => xtool.developerServices(subcommand, distro));
  handle('xtool:uninstall', (_event, bundleId, distro) => xtool.uninstallApp(bundleId, distro));
  handle('xtool:launch', (_event, bundleId, distro) => xtool.launchApp(bundleId, distro));
  handle('xtool:sdk', (_event, distro) => xtool.sdkList(distro));

  // --- вход в Apple ID своим окном ---
  handle('auth:start', (_event, options) => {
    const settings = options || {};
    const distroName = settings.distro || xtool.DEFAULT_DISTRO;

    let command;
    if (settings.mode === 'key') {
      // Ключ App Store Connect: xtool спросит Key ID, Issuer ID и путь к файлу.
      command = 'xtool auth login --mode key';
    } else {
      command =
        `xtool auth login --mode password ` +
        `--username ${xtool.shellQuote(settings.username || '')} ` +
        `--password ${xtool.shellQuote(settings.password || '')}`;
    }

    interactive.closeSession('apple');
    const session = interactive.createSession('apple', {
      distro: distroName,
      command,
      onOutput: (text) => send('auth:output', text),
      onPrompt: (prompt) => send('auth:prompt', prompt),
      onDone: (result) => {
        send('auth:done', result);
        interactive.closeSession('apple');
      },
    });

    session.start();
    return { started: true };
  });

  handle('auth:answer', (_event, answer) => {
    const session = interactive.getSession('apple');
    if (!session) throw new Error(t('auth.noSession'));
    return session.send(String(answer == null ? '' : answer));
  });

  handle('auth:cancel', () => {
    interactive.closeSession('apple');
    return true;
  });

  // Универсальная интерактивная команда — пригодится и для xtool setup.
  handle('xtool:interactive', (_event, options) => {
    const settings = options || {};
    if (!settings.command) throw new Error(t('main.emptyCommand'));

    interactive.closeSession(settings.id || 'generic');
    const session = interactive.createSession(settings.id || 'generic', {
      distro: settings.distro || xtool.DEFAULT_DISTRO,
      command: settings.command,
      onOutput: (text) => send('auth:output', text),
      onPrompt: (prompt) => send('auth:prompt', prompt),
      onDone: (result) => send('auth:done', result),
    });
    session.start();
    return { started: true };
  });

  handle('xtool:run', async (_event, command, distro) => {
    if (!command) throw new Error(t('main.emptyCommand'));
    send('xtool:output', { stream: 'meta', text: `$ ${command}\n` });
    const result = await xtool.runRaw(command, {
      distro,
      onOutput: (text) => send('xtool:output', { stream: 'build', text }),
    });
    return { ok: result.ok, code: result.code };
  });

  // --- поиск по проекту ---
  handle('search:project', (_event, options) => {
    if (!currentWorkspacePath) throw new Error(t('search.needProject'));
    return search.searchProject(currentWorkspacePath, options || {});
  });

  handle('search:replace', (_event, options) => {
    if (!currentWorkspacePath) throw new Error(t('search.needProject'));
    const result = search.replaceInProject(currentWorkspacePath, options || {});
    // Дерево могло измениться — обновляем навигатор.
    if (result.totalFiles > 0) loadWorkspace(currentWorkspacePath, { keepPath: true });
    return result;
  });

  // --- сборка Swift и разбор ошибок компилятора ---
  handle('swift:build', async (_event, options) => {
    if (!currentWorkspacePath) throw new Error(t('search.needProject'));

    // Команду выбираем по виду проекта: xtool-проекты собираются через
    // `xtool dev build`, иначе компилятор не находит стандартную библиотеку
    // Swift для iOS — SDK подключается только через xtool.
    const picked = swift.pickBuildCommand(currentWorkspacePath);
    const command = (options && options.command) || picked.command;

    send('xtool:output', { stream: 'meta', text: `$ ${command}\n` });
    send('xtool:output', { stream: 'meta', text: `${picked.reason}\n` });
    send('xtool:output', { stream: 'build', text: `${t('build.mirroring')}\n` });

    const result = await swift.runBuild({
      distro: options ? options.distro : undefined,
      windowsProjectPath: currentWorkspacePath,
      command,
      onOutput: (text) => send('xtool:output', { stream: 'build', text }),
    });

    send('swift:diagnostics', { diagnostics: result.diagnostics, loose: result.loose });
    return {
      ok: result.ok,
      code: result.code,
      errors: result.errors,
      warnings: result.warnings,
      command,
      tool: picked.tool,
      mirrorPath: result.mirrorPath,
    };
  });

  // --- форматирование через swift-format ---
  handle('swift:format', async (_event, options) => {
    if (!options || !options.text) throw new Error(t('swift.nothingToFormat'));
    return swift.formatDocument({
      distro: options.distro,
      text: options.text,
    });
  });

  handle('swift:tools', (_event, distroName) => swift.checkTools(distroName));

  // --- языковой сервер Swift (sourcekit-lsp) ---
  handle('lsp:start', async (_event, options) => {
    if (!currentWorkspacePath) throw new Error(t('lsp.unavailable'));

    if (lspClient) {
      lspClient.stop();
      lspClient = null;
    }

    lspClient = new LspClient({
      distro: options ? options.distro : undefined,
      projectPath: currentWorkspacePath,
      onLog: (text) => send('lsp:log', text),
      onDiagnostics: (payload) => send('lsp:diagnostics', payload),
      onStatus: (status) => send('lsp:status', status),
    });

    await lspClient.start();
    return { running: lspClient.open, project: currentWorkspacePath };
  });

  handle('lsp:stop', () => {
    if (lspClient) {
      lspClient.stop();
      lspClient = null;
    }
    return true;
  });

  handle('lsp:state', () => ({
    running: Boolean(lspClient && lspClient.open),
    project: currentWorkspacePath,
  }));

  handle('lsp:didOpen', (_event, filePath, text) => {
    if (lspClient) lspClient.openDocument(filePath, text);
    return true;
  });

  handle('lsp:didChange', (_event, filePath, text) => {
    if (lspClient) lspClient.changeDocument(filePath, text);
    return true;
  });

  handle('lsp:didClose', (_event, filePath) => {
    if (lspClient) lspClient.closeDocument(filePath);
    return true;
  });

  handle('lsp:completion', (_event, filePath, line, character) =>
    lspClient ? lspClient.completion(filePath, line, character) : [],
  );

  handle('lsp:hover', (_event, filePath, line, character) =>
    lspClient ? lspClient.hover(filePath, line, character) : null,
  );

  handle('lsp:definition', (_event, filePath, line, character) =>
    lspClient ? lspClient.definition(filePath, line, character) : null,
  );

  // --- создание проектов ---
  handle('project:templates', () => scaffold.listTemplates());

  handle('project:preview', (_event, options) => scaffold.previewProject(options || {}));

  handle('project:chooseParent', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('dialog.chooseParentTitle'),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: t('dialog.chooseParentButton'),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  handle('project:create', async (_event, options) => {
    const created = scaffold.createProject(options || {});
    // keepPath: не шлём событие, renderer применит рабочее пространство сам,
    // иначе оно применится дважды.
    const payload = loadWorkspace(created.path, { keepPath: true });
    return { ...created, workspace: payload };
  });

  // Шаги с sudo нельзя выполнять в фоне: sudo требует терминал для ввода пароля.
  // Поэтому открываем настоящее окно консоли WSL.
  handle('xtool:terminal', async (_event, command, distro) => {
    const target = distro || xtool.DEFAULT_DISTRO;
    const args = ['-d', target];
    if (command) {
      args.push('--', 'bash', '-lc', `${command}; echo; echo "--- готово, нажмите Enter ---"; read _`);
    }
    const child = spawn('cmd.exe', ['/c', 'start', '', 'wsl.exe', ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return true;
  });
}

/**
 * Открыть архив: распаковать zip при необходимости и разобрать содержимое.
 * @param {string} targetPath путь к .xcarchive, .app, .ipa или zip с ними
 */
async function openArchive(targetPath) {
  const chosen = await resolveArchivePath(targetPath);
  const info = packager.inspectArchive(chosen.archivePath);

  return {
    ...info,
    path: chosen.archivePath,
    source: chosen.source,
    extracted: chosen.extracted,
    original: path.resolve(targetPath),
  };
}

/**
 * Привести выбранный путь к каталогу .xcarchive.
 *
 * Пользователь может выбрать как сам каталог архива, так и zip-файл с ним —
 * второй вариант встречается чаще, потому что архив удобно передавать одним
 * файлом. Zip распаковывается во временную папку и используется повторно.
 *
 * @returns {Promise<{archivePath: string, source: string, extracted: boolean}>}
 */
async function resolveArchivePath(chosenPath) {
  const resolved = path.resolve(chosenPath);
  const stat = fs.statSync(resolved);

  if (stat.isDirectory()) {
    return { archivePath: resolved, source: 'directory', extracted: false };
  }

  // Готовый .ipa — это тоже zip, кладём его в ту же временную папку.
  if (!/\.zip$/i.test(resolved)) {
    throw new Error(t('archive.needZipOrDir', { path: resolved }));
  }

  // Имя папки берём из имени файла, чтобы разные архивы не смешивались.
  const stamp = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 8);
  const baseName = path.basename(resolved, path.extname(resolved));
  const destination = path.join(
    app.getPath('temp'),
    'fcode-archives',
    `${baseName.replace(/[^\w\u0400-\u04ff.-]+/g, '_')}-${stamp}`,
  );

  const marker = path.join(destination, '.fcode-extracted');
  if (fs.existsSync(marker)) {
    const cached = findArchiveDir(destination);
    if (cached) return { archivePath: cached, source: 'zip-cache', extracted: false };
  }

  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });

  send('xtool:output', { stream: 'meta', text: `${t('archive.extracting', { name: path.basename(resolved) })}\n` });
  const stats = extractZip(resolved, destination);
  fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
  send('xtool:output', {
    stream: 'build',
    text: `${t('archive.extracted', { files: stats.files, dirs: stats.directories, links: stats.symlinks })}\n`,
  });

  const archivePath = findArchiveDir(destination);
  if (!archivePath) throw new Error(t('archive.noXcarchiveInZip', { path: resolved }));

  return { archivePath, source: 'zip', extracted: true };
}

/** Найти .xcarchive внутри распакованного каталога. */
function findArchiveDir(root, depth = 0) {
  if (depth > 3) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name.toLowerCase().endsWith('.xcarchive')) return full;
    const found = findArchiveDir(full, depth + 1);
    if (found) return found;
  }
  return null;
}

function loadWorkspace(dirPath, options = {}) {
  let resolved = path.resolve(dirPath);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(t('main.notADirectory', { path: resolved }));

  // Пользователь часто открывает папку с исходниками, хотя .xcodeproj лежит
  // рядом с ней, уровнем выше. Тогда поднимаемся наверх: без этого проект
  // выглядит как обычная папка, и кнопка сборки молча ничего не делает.
  let elevatedFrom = null;
  const probe = workspace.detectProjects(resolved);
  if (probe.elevatedFrom) {
    elevatedFrom = probe.elevatedFrom;
    // Подъём может быть не на один уровень: берём папку, где проект реально
    // лежит, а не просто родительскую.
    resolved = probe.resolvedRoot || path.dirname(resolved);
  }

  if (currentWorkspacePath && currentWorkspacePath !== resolved && lspClient) {
    lspClient.stop();
    lspClient = null;
    send('lsp:status', { state: 'stopped', code: 0 });
  }

  currentWorkspacePath = resolved;

  const tree = workspace.buildTree(resolved);
  const detected = workspace.detectProjects(resolved);

  const payload = {
    path: resolved,
    name: path.basename(resolved),
    tree,
    ...detected,
    // Не null, если папку пришлось поднять на уровень выше: интерфейс объяснит,
    // почему открылась не та папка, которую выбирали.
    elevatedFrom,
  };

  if (!options.keepPath) send('workspace:changed', payload);
  return payload;
}

// ------------------------------------------------------------------ меню

function buildMenu() {
  const template = [
    {
      label: t('menu.file'),
      submenu: [
        {
          label: t('menu.openFolder'),
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ['openDirectory'],
              title: t('menu.openFolder'),
            });
            if (!result.canceled && result.filePaths[0]) loadWorkspace(result.filePaths[0]);
          },
        },
        {
          label: t('menu.save'),
          accelerator: 'CmdOrCtrl+S',
          click: () => send('menu:save'),
        },
        { type: 'separator' },
        { role: 'quit', label: t('menu.exit') },
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') },
        { type: 'separator' },
        {
          label: t('menu.find'),
          accelerator: 'CmdOrCtrl+F',
          click: () => send('menu:find'),
        },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { role: 'reload', label: t('menu.reload') },
        { role: 'toggleDevTools', label: t('menu.devtools') },
        { type: 'separator' },
        { role: 'resetZoom', label: t('menu.actualSize') },
        { role: 'zoomIn', label: t('menu.zoomIn') },
        { role: 'zoomOut', label: t('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.fullscreen') },
      ],
    },
    {
      label: t('menu.build'),
      submenu: [
        {
          label: t('menu.packIpa'),
          accelerator: 'CmdOrCtrl+B',
          click: () => send('menu:buildIpa'),
        },
        {
          label: t('menu.verifyIpa'),
          accelerator: 'CmdOrCtrl+Shift+V',
          click: () => send('menu:verifyIpa'),
        },
      ],
    },
    {
      label: t('menu.help'),
      submenu: [
        {
          label: t('menu.limitations'),
          click: () => send('menu:limitations'),
        },
        {
          label: t('menu.github'),
          click: () => shell.openExternal('https://github.com/'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------ старт

// Один экземпляр: иначе два окна будут конфликтовать за одни и те же файлы.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  /*
   * Страховка от падения всего приложения из-за оборванного канала.
   *
   * Внешние программы (sourcekit-lsp, xtool, команды в подсистеме Linux) могут
   * завершиться в любой момент — например, когда перезапускают WSL. Запись в
   * их входной поток даёт EPIPE, и без обработки это показывает пользователю
   * «JavaScript error occurred in the main process» и закрывает программу.
   *
   * Оборванный канал — не повод терять несохранённые файлы: пишем в журнал и
   * продолжаем работу.
   */
  const ignorable = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);

  process.on('uncaughtException', (error) => {
    if (ignorable.has(error && error.code)) {
      try {
        send('xtool:output', { stream: 'build', text: `${t('main.pipeClosed')}\n` });
      } catch {
        /* окно могло быть уже закрыто */
      }
      return;
    }

    // Всё остальное показываем, но не завершаем процесс молча.
    console.error('[Fcode] необработанная ошибка:', error);
    try {
      send('xtool:output', { stream: 'build', text: `${t('main.unexpected', { error: error.message })}\n` });
    } catch {
      /* окна может не быть */
    }
  });

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error('[Fcode] необработанный отказ:', message);
  });

  app.whenReady().then(() => {
    // Без этого Windows показывает в панели задач значок electron.exe,
    // а не иконку FCode.
    app.setAppUserModelId('com.fcode.app');

    registerHandlers();
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    if (lspClient) {
      lspClient.stop();
      lspClient = null;
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
