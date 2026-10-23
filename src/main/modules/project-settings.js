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

/** Прочитать настройки проекта. */
function read(projectPath) {
  const manifestPath = path.join(projectPath, 'Package.swift');
  const configPath = path.join(projectPath, 'xtool.yml');

  const result = {
    name: null,
    bundleId: null,
    iosVersion: null,
    manifestPath,
    configPath,
    hasManifest: fs.existsSync(manifestPath),
    hasConfig: fs.existsSync(configPath),
  };

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
      const value = String(options.iosVersion).trim();
      if (/^\d+(\.\d+)?$/.test(value)) {
        if (/\.iOS\s*\(\s*\.v\d+(?:\.\d+)?\s*\)/.test(text)) {
          text = text.replace(/\.iOS\s*\(\s*\.v\d+(?:\.\d+)?\s*\)/, `.iOS(.v${value})`);
        } else if (/platforms\s*:\s*\[/.test(text)) {
          text = text.replace(/platforms\s*:\s*\[/, `platforms: [\n        .iOS(.v${value}),`);
        }
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

  return { ...read(projectPath), changed };
}

module.exports = { read, write };
