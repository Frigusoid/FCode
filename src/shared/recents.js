'use strict';
/*
 * Список недавних проектов для стартового экрана.
 *
 * Хранится в localStorage: этого достаточно, чтобы список пережил перезапуск,
 * и не нужно трогать файлы настроек приложения. Логика вынесена сюда, чтобы её
 * можно было проверить тестами без браузера.
 */

/** Больше шести проектов на стартовом экране не помещается. */
const RECENT_LIMIT = 6;

/** Ключ хранилища. */
const RECENT_KEY = 'fcode.recent';

/**
 * Привести путь к сравнимому виду: Windows не различает регистр и слэши.
 *
 * @param {string} filePath
 * @returns {string}
 */
function normalizePath(filePath) {
  return String(filePath || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

/**
 * Добавить проект в начало списка.
 *
 * Повторное открытие того же проекта не создаёт дубликат, а поднимает его
 * наверх. Лишние записи отбрасываются.
 *
 * @param {Array<{path: string, name: string}>} list текущий список
 * @param {{path: string, name?: string}} project
 * @param {number} [limit]
 * @returns {Array<{path: string, name: string}>}
 */
function addRecent(list, project, limit = RECENT_LIMIT) {
  const items = Array.isArray(list) ? list : [];
  const path = String((project && project.path) || '').trim();

  if (!path) return items.slice();

  const name = String((project && project.name) || '').trim() || path.split(/[\\/]/).filter(Boolean).pop();
  const normalized = normalizePath(path);

  const rest = items.filter((item) => item && item.path && normalizePath(item.path) !== normalized);

  return [{ path, name }, ...rest].slice(0, limit);
}

/**
 * Прочитать список из хранилища; битые данные считаем пустым списком.
 *
 * @param {Storage} storage
 * @param {string} [key]
 * @returns {Array<{path: string, name: string}>}
 */
function readRecents(storage, key = RECENT_KEY) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item) => item && typeof item.path === 'string' && item.path.trim())
      .map((item) => ({
        path: item.path,
        name: String(item.name || '').trim() || item.path.split(/[\\/]/).filter(Boolean).pop(),
      }))
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Записать список в хранилище (ошибки приватного режима игнорируем).
 *
 * @param {Storage} storage
 * @param {Array} list
 * @param {string} [key]
 */
function writeRecents(storage, list, key = RECENT_KEY) {
  try {
    storage.setItem(key, JSON.stringify(Array.isArray(list) ? list.slice(0, RECENT_LIMIT) : []));
  } catch {
    /* в приватном режиме список просто не сохранится */
  }
}

/**
 * Убрать проект из списка (папку удалили или она больше не открывается).
 *
 * @param {Array<{path: string, name: string}>} list
 * @param {string} projectPath
 * @returns {Array<{path: string, name: string}>}
 */
function removeRecent(list, projectPath) {
  const items = Array.isArray(list) ? list : [];
  const normalized = normalizePath(projectPath);
  return items.filter((item) => item && item.path && normalizePath(item.path) !== normalized);
}

module.exports = {
  RECENT_LIMIT,
  RECENT_KEY,
  addRecent,
  removeRecent,
  normalizePath,
  readRecents,
  writeRecents,
};
