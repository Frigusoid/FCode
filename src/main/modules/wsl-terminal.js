'use strict';
/*
 * Запуск консоли WSL из интерфейса.
 *
 * Раньше команда собиралась и передавалась прямо в `cmd.exe /c start ...`,
 * и это ломалось: cmd заново разбирает строку и режет аргументы по пробелам и
 * кавычкам, поэтому bash получал мусор. Окно открывалось пустым и молча ждало
 * Enter — именно так выглядел «пустой WSL» у кнопки входа в Apple ID.
 *
 * Теперь пишем .cmd-обёртку во временную папку и запускаем её: внутри файла
 * кавычки не нужно экранировать повторно. Сам скрипт передаём в bash через
 * base64 — в нём нет ни пробелов, ни кавычек, поэтому его нельзя испортить.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

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
 * Аргументы для wsl.exe — для простых вызовов и тестов.
 *
 * @param {string} [command] команда, которую нужно выполнить в консоли
 * @param {string} [distro] дистрибутив
 * @returns {string[]}
 */
function args(command, distro) {
  const result = [];
  if (distro) result.push('-d', distro);
  // Домашняя папка Linux, а не /mnt/c/...
  result.push('--cd', '~');

  if (command) {
    result.push('--', 'bash', '-lc', `${command}; echo; echo "--- готово, нажмите Enter ---"; read _`);
  }
  return result;
}

/**
 * Текст .cmd-обёртки.
 *
 * @param {string} [command] команда для bash
 * @param {string} [distro] дистрибутив
 * @param {{wait?: boolean}} [options] wait: false — не ждать Enter (для тестов)
 * @returns {string}
 */
function shimContent(command, distro, options = {}) {
  const wait = options.wait !== false;
  const parts = [`"${executable()}"`];

  if (distro) parts.push('-d', distro);
  parts.push('--cd', '~');

  if (command) {
    // base64 исключает любые проблемы с кавычками и пробелами внутри команды.
    const encoded = Buffer.from(command, 'utf8').toString('base64');
    const tail = wait ? `; echo; echo '--- ready, press Enter ---'; read _` : '';
    parts.push('--', 'bash', '-lc', `"echo ${encoded} | base64 -d | bash${tail}"`);
  }

  return ['@echo off', 'chcp 65001 >nul', parts.join(' '), ''].join('\r\n');
}

/**
 * Записать .cmd-обёртку во временную папку и вернуть путь.
 *
 * @param {string} [command]
 * @param {string} [distro]
 * @param {{wait?: boolean, dir?: string}} [options]
 * @returns {string}
 */
function writeShim(command, distro, options = {}) {
  const dir = options.dir || path.join(os.tmpdir(), 'fcode-terminal');
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.cmd`);
  // Внутри только ASCII, поэтому кодировка cmd не важна.
  fs.writeFileSync(file, shimContent(command, distro, options), 'ascii');
  return file;
}

/**
 * Погасить подсистему Linux: `wsl --shutdown`.
 *
 * Нужно, когда WSL «залипает»: например, после нехватки памяти команды
 * перестают запускаться с ERROR_NO_SYSTEM_RESOURCES. Языковой сервер живёт
 * внутри WSL, поэтому вызывающий код должен остановить его заранее.
 *
 * @param {{timeout?: number}} [options]
 * @returns {Promise<{ok: boolean, code?: number, output?: string, error?: string}>}
 */
function shutdown(options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable(), ['--shutdown'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, error: error.message });
      return;
    }

    let output = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* уже завершился */
      }
      resolve({ ok: false, error: 'wsl --shutdown не ответил вовремя' });
    }, options.timeout || 30000);

    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: output.trim() });
    });
  });
}

module.exports = { executable, args, shimContent, writeShim, systemWslPath, shutdown };
