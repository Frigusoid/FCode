'use strict';
/*
 * Масштаб текста в редакторе кода.
 *
 * Ctrl + колесо мыши меняет размер шрифта, как в Visual Studio и VS Code.
 * Арифметика вынесена сюда, чтобы её можно было проверить без браузера:
 * ограничения, шаг и сохранение выбранного значения.
 */

/** Ниже 9 px текст уже не читается, выше 28 — в строку влезает по 20 символов. */
const MIN_ZOOM = 9;
const MAX_ZOOM = 28;
const DEFAULT_ZOOM = 13;
const ZOOM_STEP = 1;

const STORAGE_KEY = 'fcode.editorZoom';

/**
 * Привести масштаб к допустимому.
 *
 * @param {number} value
 * @returns {number}
 */
function clampZoom(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_ZOOM;

  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(number)));
}

/**
 * Следующее значение при прокрутке колеса.
 *
 * @param {number} current
 * @param {number} direction -1 вверх (уменьшить), +1 вниз (увеличить)
 * @returns {number}
 */
function nextZoom(current, direction) {
  // direction: +1 — крупнее, -1 — мельче. Колесо вверх даёт -1.
  const delta = direction < 0 ? -ZOOM_STEP : ZOOM_STEP;
  return clampZoom(clampZoom(current) + delta);
}

/** Прочитать сохранённый масштаб. */
function readZoom(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_ZOOM;

    return clampZoom(raw);
  } catch {
    return DEFAULT_ZOOM;
  }
}

/** Сохранить масштаб; возвращает нормализованное значение. */
function writeZoom(storage, value) {
  const zoom = clampZoom(value);

  try {
    storage.setItem(STORAGE_KEY, String(zoom));
  } catch {
    /* приватный режим — масштаб не сохранится */
  }

  return zoom;
}

module.exports = {
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_ZOOM,
  ZOOM_STEP,
  STORAGE_KEY,
  clampZoom,
  nextZoom,
  readZoom,
  writeZoom,
};
