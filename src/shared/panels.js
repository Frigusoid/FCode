'use strict';
/*
 * Размеры панелей: боковая, инспектор и консоль.
 *
 * Логика отделена от DOM, чтобы её можно было проверить тестами: здесь только
 * разбор сохранённых значений, ограничения и вычисление новых размеров.
 * DOM-часть (перетаскивание) живёт в renderer-е.
 */

/** Панели, которые можно тянуть. */
const PANELS = ['sidebar', 'inspector', 'console'];

/** Пределы в пикселях: ниже — панель нечитаема, выше — съедает редактор. */
const LIMITS = {
  sidebar: { min: 180, max: 560, default: 272, axis: 'x' },
  inspector: { min: 220, max: 640, default: 320, axis: 'x' },
  console: { min: 80, max: 520, default: 210, axis: 'y' },
};

const STORAGE_KEY = 'fcode.panels';

/** Размеры по умолчанию. */
function defaultSizes() {
  return PANELS.reduce((sizes, panel) => {
    sizes[panel] = LIMITS[panel].default;
    return sizes;
  }, {});
}

/**
 * Привести размер к допустимому для панели.
 *
 * @param {'sidebar'|'inspector'|'console'} panel
 * @param {number} value
 * @returns {number}
 */
function clampSize(panel, value) {
  const limit = LIMITS[panel];
  if (!limit) return 0;

  const number = Number(value);
  if (!Number.isFinite(number)) return limit.default;

  return Math.min(limit.max, Math.max(limit.min, Math.round(number)));
}

/**
 * Прочитать размеры из хранилища, подставив значения по умолчанию.
 *
 * @param {Storage} storage
 * @returns {{sidebar: number, inspector: number, console: number}}
 */
function readSizes(storage) {
  const sizes = defaultSizes();

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return sizes;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return sizes;

    for (const panel of PANELS) {
      if (parsed[panel] !== undefined) sizes[panel] = clampSize(panel, parsed[panel]);
    }
  } catch {
    /* битые данные — работаем со значениями по умолчанию */
  }

  return sizes;
}

/**
 * Сохранить размеры.
 *
 * @param {Storage} storage
 * @param {object} sizes
 * @returns {object} нормализованные размеры
 */
function writeSizes(storage, sizes) {
  const normalized = defaultSizes();

  for (const panel of PANELS) {
    if (sizes && sizes[panel] !== undefined) normalized[panel] = clampSize(panel, sizes[panel]);
  }

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    /* приватный режим — размеры просто не сохранятся */
  }

  return normalized;
}

/**
 * Пересчитать размер при перетаскивании.
 *
 * @param {'sidebar'|'inspector'|'console'} panel
 * @param {number} startSize размер в начале перетаскивания
 * @param {number} delta сдвиг курсора в пикселях
 * @returns {number}
 */
function sizeAfterDrag(panel, startSize, delta) {
  const limit = LIMITS[panel];
  if (!limit) return 0;

  // Инспектор растёт влево, консоль — вверх: у них дельта идёт с обратным
  // знаком, иначе ручка двигала бы панель в противоположную сторону.
  const inverted = panel === 'inspector' || panel === 'console';
  const signed = inverted ? -delta : delta;

  return clampSize(panel, startSize + signed);
}

/** Сбросить размер панели к значению по умолчанию. */
function resetSize(panel) {
  const limit = LIMITS[panel];
  return limit ? limit.default : 0;
}

module.exports = {
  PANELS,
  LIMITS,
  STORAGE_KEY,
  defaultSizes,
  clampSize,
  readSizes,
  writeSizes,
  sizeAfterDrag,
  resetSize,
};
