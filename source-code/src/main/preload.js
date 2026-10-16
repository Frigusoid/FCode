'use strict';
/*
 * Мост между renderer'ом и главным процессом.
 *
 * Renderer не имеет доступа к Node (contextIsolation: true). Всё, что ему
 * разрешено, перечислено здесь явно. Обработчики главного процесса возвращают
 * {ok, data|error}, а мост превращает это в обычный Promise/исключение —
 * чтобы код интерфейса не был забит проверками.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (!response) throw new Error(`Канал ${channel} не ответил`);
  if (!response.ok) {
    const error = new Error(response.error || 'Неизвестная ошибка');
    error.stack = response.stack || error.stack;
    throw error;
  }
  return response.data;
}

// События, которые главный процесс может присылать в интерфейс.
const INCOMING_EVENTS = new Set([
  'ipa:progress',
  'xtool:output',
  'lsp:log',
  'lsp:diagnostics',
  'lsp:status',
  'swift:diagnostics',
  'files:dropped',
  'archive:ready',
  'auth:output',
  'auth:prompt',
  'auth:done',
  'xtool:step',
  'workspace:changed',
  'menu:save',
  'menu:find',
  'menu:buildIpa',
  'menu:verifyIpa',
  'menu:limitations',
]);

/**
 * Подписаться на событие главного процесса.
 * @returns {() => void} функция отписки
 */
function subscribe(channel, listener) {
  if (!INCOMING_EVENTS.has(channel)) return () => {};
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('fcode', {
  app: {
    info: () => call('app:info'),
    setLanguage: (language) => call('app:setLanguage', language),
  },

  tools: {
    check: () => call('tools:check'),
  },

  project: {
    templates: () => call('project:templates'),
    preview: (options) => call('project:preview', options),
    chooseParent: () => call('project:chooseParent'),
    create: (options) => call('project:create', options),
  },

  workspace: {
    choose: () => call('workspace:choose'),
    load: (dirPath) => call('workspace:load', dirPath),
    refresh: () => call('workspace:refresh'),
  },

  file: {
    read: (filePath) => call('file:read', filePath),
    save: (filePath, text) => call('file:save', filePath, text),
    create: (filePath) => call('file:create', filePath),
    createDir: (dirPath) => call('dir:create', dirPath),
    rename: (from, to) => call('entry:rename', from, to),
    remove: (target) => call('entry:delete', target),
  },

  /**
   * Перетаскивание файлов в окно.
   *
   * Это самый надёжный способ открыть архив: он не зависит от фильтров и
   * особенностей системного диалога. Путь к файлу достаётся через webUtils —
   * напрямую из события браузера его получить нельзя.
   */
  drop: {
    enable: () => {
      window.addEventListener('dragover', (event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      });

      window.addEventListener('drop', (event) => {
        const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
        if (files.length === 0) return;

        event.preventDefault();
        const paths = files
          .map((file) => {
            try {
              return webUtils.getPathForFile(file);
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        if (paths.length > 0) ipcRenderer.send('files:dropped', paths);
      });
    },
    onDrop: (listener) => subscribe('files:dropped', listener),
  },

  archive: {
    choose: () => call('archive:choose'),
    chooseFolder: () => call('archive:chooseFolder'),
    // Открыть по готовому пути: так приходит перетаскивание в окно.
    open: (targetPath) => call('archive:open', targetPath),
    inspect: (archivePath) => call('archive:inspect', archivePath),
  },

  build: {
    // Полный конвейер: исходники -> .xcarchive -> .ipa.
    fromSource: (options) => call('build:fromSource', options),
  },

  ipa: {
    build: (options) => call('ipa:build', options),
    verify: (ipaPath) => call('ipa:verify', ipaPath),
    chooseFile: () => call('ipa:chooseFile'),
    saveDialog: (defaultName) => call('dialog:saveIpa', defaultName),
  },

  zsign: {
    status: () => call('zsign:status'),
    install: () => call('zsign:install'),
    resign: (options) => call('zsign:resign', options),
    chooseP12: () => call('zsign:chooseP12'),
    chooseProvision: () => call('zsign:chooseProvision'),
  },

  xcode: {
    analyze: (projectPath) => call('xcode:analyze', projectPath),
    convert: (options) => call('xcode:convert', options),
    convertFull: (options) => call('xcode:convertFull', options),
    probe: (projectPath) => call('xcode:probe', projectPath),
  },

  about: {
    info: () => call('about:info'),
  },

  requirements: {
    check: (distro) => call('requirements:check', distro),
    guide: (distro) => call('requirements:guide', distro),
  },

  sideloadly: {
    find: () => call('sideloadly:find'),
    download: () => call('sideloadly:download'),
    launch: (options) => call('sideloadly:launch', options),
  },

  sdk: {
    instructions: (options) => call('sdk:instructions', options),
    chooseFolder: () => call('sdk:chooseFolder'),
    install: (options) => call('sdk:install', options),
    // Прямой ссылки на Xcode нет: Apple отдаёт файл после входа в учётную
    // запись. Поэтому ищем уже скачанный файл на диске.
    findDownload: () => call('sdk:findDownload'),
    downloadsFolder: () => call('sdk:downloadsFolder'),
  },

  auth: {
    start: (options) => call('auth:start', options),
    answer: (answer) => call('auth:answer', answer),
    cancel: () => call('auth:cancel'),
    status: (distro) => call('xtool:authStatus', distro),
    logout: (distro, reset2fa) => call('xtool:logout', distro, reset2fa),
    onOutput: (listener) => subscribe('auth:output', listener),
    onPrompt: (listener) => subscribe('auth:prompt', listener),
    onDone: (listener) => subscribe('auth:done', listener),
  },

  developer: {
    list: (subcommand, distro) => call('xtool:ds', subcommand, distro),
    uninstall: (bundleId, distro) => call('xtool:uninstall', bundleId, distro),
    launch: (bundleId, distro) => call('xtool:launch', bundleId, distro),
    sdk: (distro) => call('xtool:sdk', distro),
  },

  search: {
    project: (options) => call('search:project', options),
    replace: (options) => call('search:replace', options),
  },

  swift: {
    build: (options) => call('swift:build', options),
    format: (options) => call('swift:format', options),
    tools: (distro) => call('swift:tools', distro),
  },

  lsp: {
    start: (options) => call('lsp:start', options),
    stop: () => call('lsp:stop'),
    state: () => call('lsp:state'),
    didOpen: (filePath, text) => call('lsp:didOpen', filePath, text),
    didChange: (filePath, text) => call('lsp:didChange', filePath, text),
    didClose: (filePath) => call('lsp:didClose', filePath),
    completion: (filePath, line, character) => call('lsp:completion', filePath, line, character),
    hover: (filePath, line, character) => call('lsp:hover', filePath, line, character),
    definition: (filePath, line, character) => call('lsp:definition', filePath, line, character),
  },

  xtool: {
    check: (distro) => call('xtool:check', distro),
    build: (options) => call('xtool:build', options),
    create: (options) => call('xtool:new', options),
    install: (options) => call('xtool:install', options),
    devices: (distro) => call('xtool:devices', distro),
    run: (command, distro) => call('xtool:run', command, distro),
    terminal: (command, distro) => call('xtool:terminal', command, distro),
    runAll: (options) => call('xtool:autoSetup', options),
    isElevated: () => call('xtool:elevated'),
  },

  shell: {
    reveal: (target) => call('shell:reveal', target),
    open: (target) => call('shell:openPath', target),
  },

  on: subscribe,
});
