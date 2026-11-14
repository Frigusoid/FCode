/*
 * Цветовые схемы интерфейса.
 *
 * Палитра задана переменными CSS в :root, поэтому тема — это набор
 * переопределений на body[data-theme]. Такой способ не требует пересборки
 * стилей и работает мгновенно: меняется один атрибут.
 *
 * Выбор запоминается в localStorage: тема не должна спрашивать себя заново
 * после каждого запуска.
 */

const STORAGE_KEY = 'fcode.theme';

/** Доступные темы: значение и подпись для интерфейса. */
export const THEMES = [
  { id: 'purple', label: 'Purple', labelRu: 'Фиолетовая', swatch: '#a855f7' },
  { id: 'green', label: 'Green', labelRu: 'Зелёная', swatch: '#22c55e' },
  { id: 'blue', label: 'Blue', labelRu: 'Голубая', swatch: '#3b82f6' },
  { id: 'red', label: 'Red', labelRu: 'Красная', swatch: '#ef4444' },
];

const KNOWN = new Set(THEMES.map((theme) => theme.id));

/** Текущая тема из хранилища (по умолчанию фиолетовая). */
export function getTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && KNOWN.has(stored) ? stored : 'purple';
  } catch {
    return 'purple';
  }
}

/**
 * Применить тему к странице.
 *
 * @param {string} [id] идентификатор темы; без аргумента берётся сохранённая
 * @returns {string} применённая тема
 */
export function applyTheme(id) {
  const theme = id && KNOWN.has(id) ? id : getTheme();
  document.body.dataset.theme = theme;
  return theme;
}

/** Запомнить и применить тему. */
export function storeTheme(id) {
  const theme = KNOWN.has(id) ? id : 'purple';
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* приватный режим — тема просто не сохранится */
  }
  applyTheme(theme);
  return theme;
}
