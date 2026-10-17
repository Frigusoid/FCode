'use strict';
/*
 * Рабочее пространство: дерево файлов проекта, чтение/запись, определение
 * Xcode-проектов. Всё, что нужно навигатору слева.
 */

const fs = require('fs');
const path = require('path');
const { t } = require('../../shared/i18n');

// Каталоги, которые не имеет смысла показывать в навигаторе.
const IGNORED_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.build',
  'build',
  'DerivedData',
  'Pods', // показываем только если открыт .xcworkspace — решается отдельно
  '.fcode',
  '__pycache__',
  '.idea',
  '.vscode',
]);

const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.gitignore.local']);

const MAX_ENTRIES_PER_DIR = 2000;
const MAX_DEPTH = 12;

/** Язык по расширению — используется и подсветкой, и иконками. */
function languageForFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const base = path.basename(fileName).toLowerCase();

  if (base === 'podfile' || base === 'fastfile' || base === 'appfile') return 'ruby';
  if (base === 'makefile') return 'makefile';

  switch (ext) {
    case '.swift':
      return 'swift';
    case '.m':
    case '.mm':
      return 'objectivec';
    case '.h':
    case '.hpp':
      return 'objectivec';
    case '.c':
      return 'c';
    case '.cpp':
    case '.cc':
    case '.cxx':
      return 'cpp';
    case '.plist':
    case '.entitlements':
    case '.pbxproj':
    case '.xcconfig':
    case '.storyboard':
    case '.xib':
      return 'xml';
    case '.json':
      return 'json';
    case '.md':
      return 'markdown';
    case '.sh':
    case '.command':
      return 'shell';
    case '.py':
      return 'python';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.ts':
      return 'typescript';
    case '.html':
    case '.htm':
      return 'html';
    case '.css':
      return 'css';
    case '.yml':
    case '.yaml':
      return 'yaml';
    case '.strings':
    case '.stringsdict':
      return 'strings';
    case '.metal':
      return 'cpp';
    default:
      return 'text';
  }
}

/** Является ли файл текстовым (по расширению), чтобы не открывать бинарь в редакторе. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.pdf', '.zip', '.ipa',
  '.xcarchive', '.car', '.dylib', '.a', '.o', '.framework', '.mobileprovision',
  '.p12', '.cer', '.mobileprovision', '.mp3', '.mp4', '.mov', '.ttf', '.otf',
  '.woff', '.woff2', '.sqlite', '.db', '.bin', '.dat', '.xcuserstate',
]);

function isProbablyText(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return false;
  if (['Info.plist', 'CodeResources', 'embedded.mobileprovision'].includes(fileName)) {
    return fileName !== 'embedded.mobileprovision';
  }
  return true;
}

/**
 * Построить дерево каталога.
 * @param {string} rootPath
 * @param {{includePods?: boolean, maxDepth?: number}} [options]
 */
function buildTree(rootPath, options = {}) {
  const resolvedRoot = path.resolve(rootPath);
  const stat = fs.statSync(resolvedRoot);
  if (!stat.isDirectory()) throw new Error(t('main.notADirectory', { path: resolvedRoot }));

  const ignored = new Set(IGNORED_DIRS);
  if (options.includePods) ignored.delete('Pods');

  const maxDepth = options.maxDepth || MAX_DEPTH;

  const walk = (dir, depth, relative) => {
    const children = [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return children;
    }

    entries.sort((a, b) => {
      // Каталоги выше файлов, дальше по алфавиту без учёта регистра.
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' });
    });

    let shown = 0;
    for (const entry of entries) {
      if (shown >= MAX_ENTRIES_PER_DIR) {
        children.push({
          name: t('tree.truncated', { count: entries.length - shown }),
          type: 'truncated',
          path: path.join(dir, '__truncated__'),
        });
        break;
      }
      if (entry.name.startsWith('.') && entry.name !== '.gitignore' && entry.name !== '.swiftlint.yml') {
        if (entry.isDirectory() || IGNORED_FILES.has(entry.name)) continue;
      }
      if (entry.isDirectory() && ignored.has(entry.name)) continue;
      if (entry.isFile() && IGNORED_FILES.has(entry.name)) continue;

      const full = path.join(dir, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink()) {
        children.push({ name: entry.name, type: 'symlink', path: full, relative: rel });
        shown += 1;
        continue;
      }
      if (entry.isDirectory()) {
        const isBundle = /\.(xcodeproj|xcworkspace|xcarchive|app|framework|bundle|appex|dSYM)$/i.test(entry.name);
        children.push({
          name: entry.name,
          type: 'dir',
          bundle: isBundle,
          path: full,
          relative: rel,
          children: depth < maxDepth ? walk(full, depth + 1, rel) : [],
        });
        shown += 1;
        continue;
      }
      if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* файл мог исчезнуть */
        }
        children.push({
          name: entry.name,
          type: 'file',
          path: full,
          relative: rel,
          size,
          language: languageForFile(entry.name),
          editable: isProbablyText(entry.name),
        });
        shown += 1;
      }
    }
    return children;
  };

  return {
    name: path.basename(resolvedRoot),
    type: 'dir',
    path: resolvedRoot,
    relative: '',
    children: walk(resolvedRoot, 0, ''),
  };
}

/**
 * Прочитать имя пакета и Bundle ID из манифеста SwiftPM.
 * Имя нужно, чтобы показывать схему: у xtool-проекта нет .xcodeproj.
 */
function readPackageInfo(manifestPath) {
  try {
    const text = fs.readFileSync(manifestPath, 'utf8');
    const match = /Package\s*\(\s*[\s\S]{0,200}?name:\s*"([^"]+)"/.exec(text);
    const name = match ? match[1] : path.basename(path.dirname(manifestPath));

    let bundleId = null;
    const ymlPath = path.join(path.dirname(manifestPath), 'xtool.yml');
    if (fs.existsSync(ymlPath)) {
      const yml = fs.readFileSync(ymlPath, 'utf8');
      const bundle = /bundleID:\s*(\S+)/.exec(yml);
      if (bundle) bundleId = bundle[1];
    }

    return { name, bundleId };
  } catch {
    return null;
  }
}

/**
 * Найти Xcode-проекты, пакеты и xtool-проекты в корне рабочего пространства.
 *
 * @param {string} rootPath папка, выбранная пользователем
 * @param {{allowElevate?: boolean}} options allowElevate: false запрещает подъём
 *   на уровень выше. Подъём делается ровно на один уровень: без этого поиск
 *   уходил бы вверх до корня диска и мог найти чужой пакет в соседней папке.
 */
function detectProjects(rootPath, options = {}) {
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root)) {
    return { projects: [], workspaces: [], swiftPackages: [], xtoolProjects: [], suggestions: [] };
  }

  const projects = [];
  const workspaces = [];
  const swiftPackages = [];
  const xtoolProjects = [];
  const suggestions = [];

  const scan = (dir, depth) => {
    if (depth > 2) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.xcodeproj')) projects.push(full);
        else if (entry.name.endsWith('.xcworkspace')) workspaces.push(full);
        else scan(full, depth + 1);
      } else if (entry.name === 'Package.swift') {
        swiftPackages.push(full);

        const info = readPackageInfo(full);
        if (info) {
          // xtool.yml рядом означает, что это проект xtool — его и собираем.
          const isXtool = fs.existsSync(path.join(dir, 'xtool.yml'));
          const record = {
            path: dir,
            name: info.name,
            bundleId: info.bundleId,
            manifest: full,
            xtool: isXtool,
          };
          if (isXtool) xtoolProjects.push(record);
          else {
            suggestions.push({ kind: 'swiftpm', path: full, note: t('workspace.packageNote') });
          }
        }
      }
    }
  };

  scan(root, 0);

  // Если в выбранной папке ничего нет, проверяем родительскую: люди часто
  // открывают папку с исходниками («Pocket Poster»), тогда как сам проект
  // («Pocket Poster.xcodeproj») лежит рядом с ней, уровнем выше.
  //
  // Поднимаемся ровно на один уровень и без дальнейшего подъёма: иначе поиск
  // ушёл бы вверх до корня диска и мог найти посторонний пакет.
  if (
    options.allowElevate !== false &&
    projects.length === 0 &&
    workspaces.length === 0 &&
    swiftPackages.length === 0 &&
    xtoolProjects.length === 0
  ) {
    const parent = path.dirname(root);
    if (parent && parent !== root) {
      const upward = detectProjects(parent, { allowElevate: false });
      const hasSomething =
        upward.projects.length > 0 ||
        upward.workspaces.length > 0 ||
        upward.xtoolProjects.length > 0;

      if (hasSomething) {
        // Возвращаем найденное наверху, но помечаем, что корень пришлось
        // поднять: интерфейс покажет это отдельной строкой, чтобы не было
        // ощущения, будто открылась не та папка.
        return { ...upward, elevatedFrom: root, resolvedRoot: parent };
      }
    }
  }

  if (workspaces.length > 0 && projects.length > 0) {
    suggestions.push({
      kind: 'workspace',
      path: workspaces[0],
      note: t('workspace.workspaceNote'),
    });
  }
  if (xtoolProjects.length > 0) {
    suggestions.push({
      kind: 'xtool',
      path: xtoolProjects[0].path,
      note: t('workspace.xtoolNote', { name: xtoolProjects[0].name }),
    });
  }

  if (
    projects.length === 0 &&
    workspaces.length === 0 &&
    swiftPackages.length === 0 &&
    xtoolProjects.length === 0
  ) {
    suggestions.push({
      kind: 'none',
      path: root,
      note: t('workspace.noneNote'),
    });
  }

  return { projects, workspaces, swiftPackages, xtoolProjects, suggestions };
}

function readTextFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  // Отсекаем то, что редактору показывать нельзя.
  if (buffer.includes(0)) {
    throw new Error(t('workspace.binaryFile'));
  }
  // UTF-8 BOM ломает подсветку первой строки, поэтому срезаем.
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, bytes: buffer.length, path: filePath };
}

function writeTextFile(filePath, text) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
  return { path: filePath, bytes: Buffer.byteLength(text, 'utf8') };
}

function createFile(filePath) {
  if (fs.existsSync(filePath)) throw new Error(t('workspace.fileExists', { path: filePath }));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '', 'utf8');
  return filePath;
}

function createDirectory(dirPath) {
  if (fs.existsSync(dirPath)) throw new Error(t('workspace.dirExists', { path: dirPath }));
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function renameEntry(from, to) {
  if (!fs.existsSync(from)) throw new Error(t('workspace.notFound', { path: from }));
  if (fs.existsSync(to)) throw new Error(t('workspace.alreadyExists', { path: to }));
  fs.renameSync(from, to);
  return to;
}

function deleteEntry(target) {
  if (!fs.existsSync(target)) throw new Error(t('workspace.notFound', { path: target }));
  fs.rmSync(target, { recursive: true, force: true });
  return target;
}

module.exports = {
  buildTree,
  detectProjects,
  readPackageInfo,
  readTextFile,
  writeTextFile,
  createFile,
  createDirectory,
  renameEntry,
  deleteEntry,
  languageForFile,
  isProbablyText,
  IGNORED_DIRS,
};
