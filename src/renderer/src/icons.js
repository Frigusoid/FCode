/*
 * Иконки интерфейса.
 *
 * Приложение рассчитано на PNG-файлы в src/renderer/icons/. Пока файла нет,
 * показывается текстовый запасной вариант — интерфейс не ломается и не показывает
 * «битую картинку». Как только PNG появляется на месте, он подхватывается сам,
 * перезапуск не нужен (достаточно перезагрузить окно).
 *
 * Разметка: <span class="ico" data-icon="open" data-fallback="📂"></span>
 */

/** Что за иконки нужны и чем заменяются, пока их нет. */
export const ICONS = {
  // Панель инструментов
  open: { fallback: '📂', label: 'Открыть папку проекта' },
  'new-project': { fallback: '＋', label: 'Создать проект' },
  linux: { fallback: '🐧', label: 'Сборка в Linux' },
  archive: { fallback: '🗄', label: 'Выбрать .xcarchive' },
  build: { fallback: '▶', label: 'Собрать .ipa' },
  verify: { fallback: '✓', label: 'Проверить' },
  convert: { fallback: '⇄', label: 'Конвертировать проект Xcode' },
  icon: { fallback: '◈', label: 'Иконка приложения' },
  preview: { fallback: '◫', label: 'Предпросмотр вёрстки' },
  xcode: { fallback: '⌘', label: 'Создать проект Xcode' },
  settings: { fallback: '⚙', label: 'Окружение' },
  language: { fallback: '⌥', label: 'Языковой сервер Swift' },
  // Перезапуск сервера: стрелка по кругу.
  reload: { fallback: '↻', label: 'Перезапустить языковой сервер' },
  save: { fallback: '💾', label: 'Сохранить файл' },
  'save-all': { fallback: '🗃', label: 'Сохранить все файлы' },
  'folder-open': { fallback: '🗀', label: 'Открыть папку .xcarchive' },

  // Элементы интерфейса
  refresh: { fallback: '⟳', label: 'Обновить' },
  close: { fallback: '✕', label: 'Закрыть' },
  help: { fallback: '?', label: 'Справка' },
  chevron: { fallback: '▶', label: 'Развернуть' },
  folder: { fallback: '▸', label: 'Папка' },
  bundle: { fallback: '◈', label: 'Пакет' },
  symlink: { fallback: '↗', label: 'Символическая ссылка' },

  // Типы файлов
  'file-swift': { fallback: 'S', label: 'Swift' },
  'file-objc': { fallback: 'M', label: 'Objective-C' },
  'file-c': { fallback: 'C', label: 'C' },
  'file-cpp': { fallback: 'C+', label: 'C++' },
  'file-plist': { fallback: 'P', label: 'plist / XML' },
  'file-json': { fallback: '{}', label: 'JSON' },
  'file-js': { fallback: 'JS', label: 'JavaScript' },
  'file-ts': { fallback: 'TS', label: 'TypeScript' },
  'file-python': { fallback: 'Py', label: 'Python' },
  'file-shell': { fallback: '$', label: 'Скрипт оболочки' },
  'file-yaml': { fallback: 'Y', label: 'YAML' },
  'file-ruby': { fallback: 'Rb', label: 'Ruby' },
  'file-css': { fallback: '#', label: 'CSS' },
  'file-html': { fallback: '<>', label: 'HTML' },
  'file-markdown': { fallback: 'M', label: 'Markdown' },
  'file-strings': { fallback: '""', label: 'Локализация' },
  'file-makefile': { fallback: 'Mk', label: 'Makefile' },
  'file-text': { fallback: '·', label: 'Прочий файл' },
};

const mounted = new WeakSet();

/**
 * Подставить картинки вместо запасных символов.
 * Безопасно вызывать повторно — уже обработанные элементы пропускаются.
 */
export function mountIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((node) => {
    if (mounted.has(node)) return;
    mounted.add(node);

    const name = node.dataset.icon;
    const fallback = node.dataset.fallback || (ICONS[name] ? ICONS[name].fallback : '·');

    // Запасной вариант показываем сразу — если PNG нет, ничего не мигнёт.
    node.textContent = fallback;
    node.classList.add('ico-fallback');

    const image = new Image();
    image.className = 'ico-img';
    image.alt = '';
    image.decoding = 'async';

    image.addEventListener('load', () => {
      node.textContent = '';
      node.appendChild(image);
      node.classList.remove('ico-fallback');
      node.classList.add('ico-loaded');
    });

    image.addEventListener('error', () => {
      // Файла нет — остаётся текстовый символ. Никаких «битых картинок».
      image.remove();
    });

    image.src = `icons/${name}.png`;
  });
}

/** Разметка одной иконки — чтобы не собирать data-атрибуты руками. */
export function icon(name, className = '') {
  const fallback = ICONS[name] ? ICONS[name].fallback : '·';
  const classes = className ? `ico ${className}` : 'ico';
  return `<span class="${classes}" data-icon="${name}" data-fallback="${fallback}"></span>`;
}
