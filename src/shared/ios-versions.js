'use strict';
/*
 * Версии iOS, под которые реально собирает наш тулчейн.
 *
 * Проверено на этом SDK (iPhoneOS 18.5, Swift 6.1.3):
 *   iOS 12 и ниже — «IR generation failure: Cannot read legacy layout file»,
 *   то есть в поставке нет стандартной библиотеки под такие версии;
 *   iOS 13.0 — собирается.
 *
 * Плюс SwiftUI существует только с iOS 13, а Swift вообще появился в 2014
 * (iOS 7+), поэтому более старые версии — не вопрос настройки, а другой
 * инструментарий.
 */

/** Минимальная версия, которую принимает сборка. */
const MIN_IOS = 13;

/** Максимальная известная версия: выше — просто нет смысла предлагать. */
const MAX_IOS = 18;

/** Список версий для выпадающего списка. */
const SUPPORTED_IOS = Array.from({ length: MAX_IOS - MIN_IOS + 1 }, (_, index) => MIN_IOS + index);

/**
 * Поддерживается ли версия.
 *
 * @param {string|number} version например 13, '13.0', '17.2'
 * @returns {boolean}
 */
function isSupported(version) {
  const major = Number.parseFloat(String(version));
  return Number.isFinite(major) && major >= MIN_IOS && major <= MAX_IOS;
}

/**
 * Привести версию к виду, который принимает Package.swift.
 *
 * SwiftPM знает платформы только по мажорной версии: .iOS(.v17). Запись
 * .v17.0 выглядит безобидно, но у неё нет соответствующего объявления, и
 * манифест перестаёт разбираться. Поэтому «17.0» и «17.2» превращаются в «17».
 *
 * @param {string|number} version
 * @returns {string} мажорная версия или пустая строка, если это не число
 */
function normalizeIosVersion(version) {
  const major = Number.parseInt(String(version ?? '').trim(), 10);
  return Number.isFinite(major) && major > 0 ? String(major) : '';
}

module.exports = { MIN_IOS, MAX_IOS, SUPPORTED_IOS, isSupported, normalizeIosVersion };
