/*
 * Локализация интерфейса.
 *
 * Сам словарь и функция перевода живут в src/shared — тот же файл использует
 * главный процесс, поэтому строки не могут разойтись. Здесь добавляется то, что
 * нужно только браузеру: хранение выбора языка и перевод статичной разметки.
 */

import shared from '../../shared/i18n.js';

export const t = shared.t;
export const setLanguage = shared.setLanguage;
export const getLanguage = shared.getLanguage;
export const onLanguageChange = shared.onLanguageChange;
export const SUPPORTED = shared.SUPPORTED;

const STORAGE_KEY = 'fcode.language';

/** Язык по умолчанию — английский. */
export function loadStoredLanguage() {
  try {
    return localStorage.getItem(STORAGE_KEY) || shared.FALLBACK;
  } catch {
    return shared.FALLBACK;
  }
}

export function storeLanguage(language) {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    /* приватный режим — просто не запоминаем */
  }
}

/**
 * Перевести статичную разметку.
 * data-i18n       — подставить текст
 * data-i18n-html  — подставить HTML (для строк с оформлением)
 * data-i18n-title — подставить всплывающую подсказку
 */
export function applyStaticTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-html]').forEach((node) => {
    node.innerHTML = t(node.dataset.i18nHtml);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((node) => {
    node.title = t(node.dataset.i18nTitle);
  });
  document.documentElement.lang = getLanguage();
}
