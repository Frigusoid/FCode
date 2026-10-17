'use strict';
/*
 * Поиск по всему проекту.
 *
 * Нужен по двум причинам: во-первых, без него работа с большим проектом
 * невозможна, во-вторых, искать нужно быстро и без внешних утилит (ripgrep
 * в Windows может отсутствовать).
 *
 * Обход умышленно простой: читаем файлы, ищем по строкам. Каталоги вроде .git,
 * .build и node_modules пропускаются, двоичные файлы определяются по нулевому
 * байту. Есть потолок на размер файла и общее число совпадений — чтобы поиск
 * по случайному шаблону не съел память.
 */

const fs = require('fs');
const path = require('path');
const { IGNORED_DIRS, isProbablyText } = require('./workspace');

const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4 МиБ — исходники больше не бывают
const MAX_RESULTS = 1000;
const MAX_MATCHES_PER_FILE = 100;
const SNIPPET_CONTEXT = 0;

/** Экранировать строку для использования в регулярном выражении. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Собрать регулярное выражение из запроса и настроек. */
function buildPattern(query, options) {
  let source = options.regex ? query : escapeRegExp(query);
  if (options.wholeWord) source = `\\b${source}\\b`;
  return new RegExp(source, options.caseSensitive ? 'g' : 'gi');
}

/** Похож ли файл на двоичный — по первым килобайтам. */
function looksBinary(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const probe = Buffer.alloc(4096);
    const read = fs.readSync(fd, probe, 0, probe.length, 0);
    for (let i = 0; i < read; i += 1) if (probe[i] === 0) return true;
    return false;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Найти совпадения в проекте.
 *
 * @param {string} rootPath корень проекта
 * @param {{query: string, caseSensitive?: boolean, regex?: boolean, wholeWord?: boolean,
 *          include?: string, maxResults?: number}} options
 */
function searchProject(rootPath, options = {}) {
  const startedAt = Date.now();
  const root = path.resolve(rootPath);

  if (!options.query) {
    return { matches: [], filesScanned: 0, filesMatched: 0, truncated: false, took: 0 };
  }

  let pattern;
  try {
    pattern = buildPattern(options.query, options);
  } catch (error) {
    throw new Error(`Некорректное выражение: ${error.message}`);
  }

  const includePattern = options.include ? buildPattern(options.include, { regex: false, caseSensitive: false }) : null;
  const limit = Math.min(options.maxResults || MAX_RESULTS, MAX_RESULTS);

  const matches = [];
  let filesScanned = 0;
  let filesMatched = 0;
  let truncated = false;

  const walk = (dir) => {
    if (truncated) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.swiftpm') continue;
        walk(full);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!isProbablyText(entry.name)) continue;
      if (includePattern && !includePattern.test(entry.name)) continue;

      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_SIZE) continue;
      if (looksBinary(full)) continue;

      filesScanned += 1;

      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }

      const lines = text.split(/\r?\n/);
      let fileMatches = 0;

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        pattern.lastIndex = 0;
        if (!pattern.test(line)) continue;

        // Все вхождения в строке — чтобы подсветить их в результатах.
        const columns = [];
        pattern.lastIndex = 0;
        let hit;
        while ((hit = pattern.exec(line)) !== null) {
          columns.push({ start: hit.index, end: hit.index + hit[0].length });
          if (hit[0].length === 0) pattern.lastIndex += 1;
          if (columns.length > 20) break;
        }

        matches.push({
          path: full,
          relative: path.relative(root, full).replace(/\\/g, '/'),
          line: index,
          text: line.length > 300 ? `${line.slice(0, 300)}…` : line,
          columns,
          before: SNIPPET_CONTEXT ? lines[index - 1] || '' : '',
          after: SNIPPET_CONTEXT ? lines[index + 1] || '' : '',
        });

        fileMatches += 1;
        if (fileMatches >= MAX_MATCHES_PER_FILE) break;
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
      }

      if (fileMatches > 0) filesMatched += 1;
      if (matches.length >= limit) truncated = true;
    }
  };

  walk(root);

  return {
    matches,
    filesScanned,
    filesMatched,
    truncated,
    took: Date.now() - startedAt,
  };
}

/**
 * Заменить найденное во всех файлах.
 * Возвращает список изменённых файлов; ошибки по отдельным файлам не прерывают
 * операцию целиком, а попадают в отчёт.
 */
function replaceInProject(rootPath, options = {}) {
  const root = path.resolve(rootPath);
  const found = searchProject(root, options);
  const replacement = options.replacement == null ? '' : String(options.replacement);

  const touched = [];
  const failed = [];

  const byFile = new Map();
  for (const match of found.matches) {
    if (!byFile.has(match.path)) byFile.set(match.path, []);
    byFile.get(match.path).push(match);
  }

  const pattern = buildPattern(options.query, options);

  for (const [filePath, list] of byFile) {
    try {
      const original = fs.readFileSync(filePath, 'utf8');
      const lines = original.split(/\r?\n/);
      let changes = 0;

      for (const match of list) {
        const line = lines[match.line];
        if (line === undefined) continue;
        pattern.lastIndex = 0;
        const updated = line.replace(pattern, replacement);
        if (updated !== line) {
          lines[match.line] = updated;
          changes += 1;
        }
      }

      if (changes > 0) {
        // Сохраняем исходный перевод строки, иначе diff получится шумным.
        const newline = original.includes('\r\n') ? '\r\n' : '\n';
        fs.writeFileSync(filePath, lines.join(newline), 'utf8');
        touched.push({ path: filePath, relative: path.relative(root, filePath).replace(/\\/g, '/'), changes });
      }
    } catch (error) {
      failed.push({ path: filePath, error: error.message });
    }
  }

  return { touched, failed, totalFiles: touched.length };
}

module.exports = { searchProject, replaceInProject, escapeRegExp, buildPattern };
