'use strict';
/*
 * Работа с инструментами Swift внутри WSL: сборка, разбор ошибок, форматирование.
 *
 * Главное здесь — превратить вывод компилятора в понятные «проблемы», которые
 * интерфейс показывает в той же панели, что и подсказки языкового сервера.
 *
 * Компилятор печатает так:
 *   /mnt/c/proj/Sources/App/ContentView.swift:12:14: error: cannot convert …
 * Нужно разобрать путь, строку и колонку, перевести путь в формат Windows и
 * отдать наверх. Заодно собираются строки-«note», которые относятся к ошибке.
 */

const fs = require('node:fs');
const path = require('path');
const wslExec = require('./wsl-exec');
const mirror = require('./mirror');
const { t } = require('../../shared/i18n');

/**
 * Диагностика компилятора: путь:строка:колонка: вид: текст
 * Встречается и без пути — такие строки пропускаем, привязать их некуда.
 */
const DIAGNOSTIC_LINE = /^(.+?):(\d+):(\d+):\s*(error|warning|note|remark):\s*(.*)$/;
/** Ссылка на файл без колонки — тоже бывает. */
const DIAGNOSTIC_FILE = /^(.+?):(\d+):\s*(error|warning|note):\s*(.*)$/;

/** Путь внутри WSL -> путь Windows. */
function wslPathToWindows(wslPath, distro = 'Ubuntu') {
  const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(wslPath);
  if (match) {
    return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`;
  }
  // Файлы вне /mnt доступны через UNC-путь к дистрибутиву.
  return `\\\\wsl$\\${distro}${wslPath.replace(/\//g, '\\')}`;
}

/**
 * Разобрать вывод компилятора в список диагностик.
 *
 * @param {string} output вывод swift build / xtool
 * @param {{cwd?: string, distro?: string, source?: string}} options
 */
function parseDiagnostics(output, options = {}) {
  const cwd = options.cwd || '';
  const distro = options.distro || 'Ubuntu';
  const source = options.source || 'swift build';

  const diagnostics = [];
  let lastByLocation = new Map();

  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    let match = DIAGNOSTIC_LINE.exec(line);
    if (!match) {
      const short = DIAGNOSTIC_FILE.exec(line);
      if (!short) continue;
      match = [short[0], short[1], short[2], '1', short[3], short[4]];
    }

    const [, rawPath, lineNumber, column, severity, message] = match;
    if (severity === 'remark') continue;

    const absolute = rawPath.startsWith('/')
      ? rawPath
      : path.posix.join(cwd.replace(/\\/g, '/'), rawPath);

    const windowsPath = wslPathToWindows(absolute, distro);
    const index = Number(lineNumber) - 1;
    const character = Number(column) - 1;

    if (severity === 'note') {
      // Примечание относится к последней найденной ошибке — дописываем к ней.
      const previous = lastByLocation.get(`${absolute}:${index}`);
      if (previous) previous.notes = [...(previous.notes || []), message];
      continue;
    }

    const item = {
      path: windowsPath,
      wslPath: absolute,
      line: index,
      character,
      endLine: index,
      endCharacter: character + Math.max(1, message.length > 40 ? 40 : message.length),
      severity: severity === 'error' ? 'error' : 'warning',
      message,
      source,
      notes: [],
    };

    diagnostics.push(item);
    lastByLocation.set(`${absolute}:${index}`, item);
  }

  // SwiftPM печатает одну и ту же ошибку на каждой фазе (модуль, компиляция,
  // линковка), поэтому одинаковые записи схлопываем.
  const unique = new Map();
  for (const item of diagnostics) {
    const key = `${item.path}:${item.line}:${item.character}:${item.severity}:${item.message}`;
    if (!unique.has(key)) unique.set(key, item);
  }

  return [...unique.values()];
}

/**
 * Понять, чем собирать проект.
 *
 * xtool-проект (рядом лежит xtool.yml) собирается только через xtool: он
 * подставляет свой toolset, без которого компилятор не находит стандартную
 * библиотеку Swift для iOS. Обычный SwiftPM-пакет собирается штатно.
 *
 * @param {string} windowsProjectPath путь к папке проекта
 * @returns {{tool: 'xtool'|'swift', command: string, reason: string}}
 */
function pickBuildCommand(windowsProjectPath) {
  const manifest = path.join(windowsProjectPath, 'xtool.yml');
  const isXtool = fs.existsSync(manifest);

  if (isXtool) {
    return {
      tool: 'xtool',
      // --ipa добавляется отдельно, когда нужен готовый файл.
      command: 'xtool dev build',
      reason: 'найден xtool.yml — проект собирается через xtool',
    };
  }

  return {
    tool: 'swift',
    command: 'swift build',
    reason: 'обычный пакет SwiftPM',
  };
}

/**
 * Собрать проект.
 *
 * Команду выбираем сами по виду проекта: xtool-проекты собираются через
 * `xtool dev build`, обычные пакеты — через `swift build`. Если команда
 * задана вызывающим явно, используем её.
 */
async function runBuild(options = {}) {
  const distro = options.distro || 'Ubuntu';
  const windowsProject = options.windowsProjectPath;

  const picked = pickBuildCommand(windowsProject);
  let command = options.command || picked.command;

  // Для xtool-проекта добавляем упаковку в .ipa, если её просят.
  if (!options.command && picked.tool === 'xtool' && options.ipa) {
    command += ' --ipa';
  }

  if (options.onOutput) {
    options.onOutput(`$ ${command}\n`);
  }

  // Собирать в /mnt нельзя: SwiftPM падает на блокировке через 9p.
  // Копируем проект внутрь Linux и работаем там.
  const prepared = await mirror.sync({
    windowsPath: windowsProject,
    distro,
    onOutput: options.onOutput,
  });

  // Путь к зеркалу безопасен (его строим мы), но правило одно для всех:
  // в скрипт он попадает в одинарных кавычках с экранированием апострофа.
  const script = `
set -e
cd '${prepared.mirrorPath.replace(/'/g, "'\\''")}'
${command}
`;

  const result = await wslExec.run({
    distro,
    user: null,
    script,
    onOutput: options.onOutput,
  });

  const diagnostics = parseDiagnostics(result.output, {
    cwd: prepared.mirrorPath,
    distro,
    source: command.split(' ')[0],
  });

  // Пути в зеркале заменяем на исходные пути Windows, иначе ошибки
  // не откроются в редакторе.
  for (const item of diagnostics) {
    item.path = mirror.mirrorToWindows(item.wslPath, prepared.mirrorPath, windowsProject);
  }

  // Сообщения компилятора без привязки к файлу тоже важны: например,
  // «invalid access» или потерянная зависимость. Показываем их отдельно.
  const loose = [];
  for (const rawLine of String(result.output).split(/\r?\n/)) {
    const match = /^(error|warning):\s*(.+)$/.exec(rawLine.trim());
    if (match) loose.push({ severity: match[1] === 'error' ? 'error' : 'warning', message: match[2] });
  }

  return {
    ...result,
    command,
    mirrorPath: prepared.mirrorPath,
    diagnostics,
    loose,
    errors: diagnostics.filter((item) => item.severity === 'error').length + loose.filter((item) => item.severity === 'error').length,
    warnings: diagnostics.filter((item) => item.severity === 'warning').length + loose.filter((item) => item.severity === 'warning').length,
  };
}

/**
 * Отформатировать текст через swift-format.
 *
 * Форматтер есть только внутри WSL и не в PATH, поэтому берём его по известному
 * пути. Текст передаём через временный файл: так не зависим от поддержки stdin.
 */
async function formatDocument(options = {}) {
  const distro = options.distro || 'Ubuntu';
  const text = options.text || '';
  const encoded = Buffer.from(text, 'utf8').toString('base64');

  const script = `
set -e
SF=/usr/libexec/swift/bin/swift-format
if [ ! -x "$SF" ]; then
  SF=$(command -v swift-format || true)
fi
if [ -z "$SF" ]; then
  echo "SWIFT_FORMAT_NOT_FOUND" >&2
  exit 2
fi

TMP=$(mktemp /tmp/fcode-format-XXXXXX.swift)
trap 'rm -f "$TMP"' EXIT
echo '${encoded}' | base64 -d > "$TMP"
"$SF" format "$TMP"
`;

  const result = await wslExec.run({ distro, user: null, script });

  if (!result.ok) {
    const notFound = /SWIFT_FORMAT_NOT_FOUND/.test(result.output);
    return {
      ok: false,
      error: notFound ? t('swift.formatNotFound') : result.output.trim() || t('swift.formatFailed'),
    };
  }

  const formatted = result.output;
  return {
    ok: true,
    formatted,
    changed: formatted.trim() !== text.trim(),
  };
}

/** Доступны ли инструменты Swift в дистрибутиве. */
async function checkTools(distro = 'Ubuntu') {
  const script = `
echo "=== swift ==="
command -v swift >/dev/null 2>&1 && swift --version 2>&1 | head -1 || echo "нет"
echo "=== swift-format ==="
SF=/usr/libexec/swift/bin/swift-format
if [ -x "$SF" ]; then "$SF" --version 2>&1 | head -1; else echo "нет"; fi
echo "=== sourcekit-lsp ==="
command -v sourcekit-lsp >/dev/null 2>&1 && echo "есть" || echo "нет"
`;

  const result = await wslExec.run({ distro, user: null, script });
  const sections = {};
  let current = null;
  for (const line of result.output.split(/\r?\n/)) {
    const marker = /^===\s*(.+?)\s*===$/.exec(line.trim());
    if (marker) {
      current = marker[1];
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }

  const read = (key) => (sections[key] || []).join(' ').trim();
  return {
    swift: read('swift'),
    swiftFormat: read('swift-format'),
    sourcekitLsp: read('sourcekit-lsp'),
  };
}

module.exports = {
  pickBuildCommand,
  parseDiagnostics,
  runBuild,
  formatDocument,
  checkTools,
  wslPathToWindows,
};
