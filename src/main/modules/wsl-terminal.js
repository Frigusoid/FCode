'use strict';
/*
 * Запуск консоли WSL из интерфейса.
 *
 * Раньше здесь был просто `wsl.exe` из PATH и без рабочей папки: консоль
 * открывалась в /mnt/c/... и человек сам шёл в проект. Теперь берём wsl.exe
 * из Program Files и всегда открываем домашнюю папку Linux (`--cd ~`).
 *
 * Модуль отдельный, потому что собрать аргументы — единственное, что здесь
 * можно проверить тестом: сам запуск открывает окно терминала.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Путь к wsl.exe из установленного приложения WSL. */
function systemWslPath() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  return path.join(programFiles, 'WSL', 'wsl.exe');
}

/**
 * Чем запускать: установленный wsl.exe или обычный из PATH.
 * @returns {string}
 */
function executable() {
  const candidate = systemWslPath();
  return fs.existsSync(candidate) ? candidate : 'wsl.exe';
}

/**
 * Аргументы для wsl.exe.
 *
 * @param {string} [command] команда, которую нужно выполнить в консоли
 * @param {string} [distro] дистрибутив; по умолчанию берётся системный
 * @returns {string[]}
 */
function args(command, distro) {
  const result = [];
  if (distro) result.push('-d', distro);
  // Домашняя папка Linux, а не /mnt/c/...
  result.push('--cd', '~');

  if (command) {
    // read _ не даёт окну закрыться сразу после вывода.
    result.push('--', 'bash', '-lc', `${command}; echo; echo "--- готово, нажмите Enter ---"; read _`);
  }
  return result;
}

module.exports = { executable, args, systemWslPath };
