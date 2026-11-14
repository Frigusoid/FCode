'use strict';
/*
 * Настройки проекта: имя, bundle id, версия iOS.
 *
 * Хранятся в двух местах, и это не ошибка: bundle id живёт в xtool.yml (его
 * читает xtool при сборке), а имя пакета и минимальная версия iOS — в
 * Package.swift, потому что SwiftPM берёт их оттуда.
 *
 * Правки точечные: подменяем одну строку и проверяем, что файл остался целым.
 * Пересобирать манифест нельзя — в нём могут быть чужие правки и комментарии.
 */

const fs = require('node:fs');
const path = require('node:path');

const packages = require('./packages');
const iosVersions = require('../../shared/ios-versions');

/** Файл с настройками, которым нет места в Package.swift и xtool.yml. */
const META_FILE = '.fcode.json';

/** Имя копии иконки внутри проекта. */
const ICON_FILE = 'AppIcon.png';

/** Прочитать .fcode.json; битый файл считаем отсутствующим. */
function readMeta(projectPath) {
  const file = path.join(projectPath, META_FILE);
  if (!fs.existsSync(file)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Записать .fcode.json. */
function writeMeta(projectPath, meta) {
  const file = path.join(projectPath, META_FILE);
  fs.writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

/** Прочитать настройки проекта. */
function read(projectPath) {
  const manifestPath = path.join(projectPath, 'Package.swift');
  const configPath = path.join(projectPath, 'xtool.yml');
  const meta = readMeta(projectPath);

  const result = {
    name: null,
    bundleId: null,
    iosVersion: null,
    icon: null,
    manifestPath,
    configPath,
    hasManifest: fs.existsSync(manifestPath),
    hasConfig: fs.existsSync(configPath),
  };

  // Иконка хранится относительным путём, наружу отдаём абсолютный.
  if (typeof meta.icon === 'string' && meta.icon) {
    const iconPath = path.join(projectPath, meta.icon);
    if (fs.existsSync(iconPath)) result.icon = iconPath;
  }

  if (result.hasManifest) {
    const text = fs.readFileSync(manifestPath, 'utf8');
    const name = /Package\s*\(\s*\n?\s*name\s*:\s*"([^"]+)"/.exec(text);
    if (name) result.name = name[1];

    const ios = /\.iOS\s*\(\s*\.v(\d+(?:\.\d+)?)\s*\)/.exec(text);
    if (ios) result.iosVersion = ios[1];
  }

  if (result.hasConfig) {
    const text = fs.readFileSync(configPath, 'utf8');
    const bundle = /bundleID\s*:\s*["']?([^"'\s]+)["']?/.exec(text);
    if (bundle) result.bundleId = bundle[1];
  }

  return result;
}

/** Сохранить настройки. Меняем только то, что передали. */
function write(projectPath, settings) {
  const options = settings || {};
  const current = read(projectPath);
  const changed = [];

  if (options.bundleId !== undefined && current.hasConfig) {
    const text = fs.readFileSync(current.configPath, 'utf8');
    const value = String(options.bundleId).trim();

    let next;
    if (/bundleID\s*:/.test(text)) {
      next = text.replace(/bundleID\s*:\s*.*$/m, `bundleID: ${value}`);
    } else {
      next = `${text.replace(/\s*$/, '')}\nbundleID: ${value}\n`;
    }

    if (next !== text) {
      fs.writeFileSync(current.configPath, next, 'utf8');
      changed.push('bundleId');
    }
  }

  if (current.hasManifest) {
    let text = fs.readFileSync(current.manifestPath, 'utf8');
    const original = text;
    if (options.name !== undefined) {
      const value = String(options.name).trim();
      if (value) text = text.replace(/(Package\s*\(\s*\n?\s*name\s*:\s*")[^"]*(")/, `$1${value}$2`);
    }

    if (options.iosVersion !== undefined) {
      // В манифест пишем только мажор: .iOS(.v17). Запись .v17.0 SwiftPM
      // не разбирает, и проект перестаёт собираться.
      const value = iosVersions.normalizeIosVersion(options.iosVersion);

      // Ниже 13 сборка физически невозможна: в поставке нет стандартной
      // библиотеки Swift под такие версии, а SwiftUI появился в iOS 13.
      // Лучше отказать сразу, чем записать версию, на которой всё упадёт.
      if (!/^\d+(\.\d+)?$/.test(value)) {
        throw new Error(`некорректная версия iOS: ${value}`);
      }
      if (!iosVersions.isSupported(value)) {
        throw new Error(
          `iOS ${value} не поддерживается: сборка умеет iOS ${iosVersions.MIN_IOS} и выше `
          + '(в тулчейне нет стандартной библиотеки Swift для более старых версий)',
        );
      }

      if (/\.iOS\s*\(\s*\.v\d+(?:\.\d+)?\s*\)/.test(text)) {
        text = text.replace(/\.iOS\s*\(\s*\.v\d+(?:\.\d+)?\s*\)/, `.iOS(.v${value})`);
      } else if (/platforms\s*:\s*\[/.test(text)) {
        text = text.replace(/platforms\s*:\s*\[/, `platforms: [\n        .iOS(.v${value}),`);
      }
    }

    if (text !== original) {
      const broken = packages.checkSyntax(text);
      if (broken) throw new Error(`правка сломала Package.swift: ${broken}`);
      fs.writeFileSync(current.manifestPath, text, 'utf8');
      if (options.name !== undefined) changed.push('name');
      if (options.iosVersion !== undefined) changed.push('iosVersion');
    }
  }

  // Иконка: копируем картинку в проект, чтобы она не зависела от исходного
  // пути и переживала перенос папки. В .fcode.json храним относительный путь.
  if (options.icon !== undefined && options.icon) {
    const source = path.resolve(String(options.icon));

    if (fs.existsSync(source)) {
      const target = path.join(projectPath, ICON_FILE);
      if (source !== target) fs.copyFileSync(source, target);

      const meta = readMeta(projectPath);
      meta.icon = ICON_FILE;
      writeMeta(projectPath, meta);
      changed.push('icon');
    }
  }

  return { ...read(projectPath), changed };
}

module.exports = { read, write };
