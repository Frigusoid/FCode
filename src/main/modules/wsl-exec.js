'use strict';
/*
 * Низкоуровневый запуск команд в WSL.
 *
 * Вынесено отдельно, потому что этим пользуются и установщик, и определение
 * окружения — иначе получилась бы циклическая зависимость модулей.
 *
 * Главное правило: многострочный скрипт НЕЛЬЗЯ передавать аргументом командной
 * строки Windows. Кавычки, переводы строк и знаки $ при этом ломаются, и в bash
 * приходит искалеченный текст (проверено: терялись значения переменных).
 * Поэтому скрипт всегда кодируется в base64.
 */

const { spawn } = require('child_process');

/**
 * wsl.exe печатает СВОИ сообщения (например, WSL_E_DISTRO_NOT_FOUND) в UTF-16LE,
 * а вывод bash внутри Linux — в UTF-8. Если читать всё как UTF-8, служебные
 * строки превращаются в «кракозябры» и настоящую ошибку не разобрать.
 * Переменная WSL_UTF8=1 переводит сам wsl.exe на UTF-8, после чего оба потока
 * читаются одинаково.
 */
const WSL_ENV = { ...process.env, WSL_UTF8: '1' };

/** Обернуть скрипт в base64 — так он дойдёт до bash без искажений. */
function encodeScript(script) {
  return `echo ${Buffer.from(script, 'utf8').toString('base64')} | base64 -d | bash`;
}

/**
 * Привести кусок вывода к тексту.
 *
 * Даже с WSL_UTF8 на старых сборках WSL может проскочить UTF-16LE — узнаём его
 * по чередованию нулевых байтов и раскодировываем правильно, а не гадаем.
 */
function decodeChunk(buffer) {
  // UTF-16LE на латинице выглядит как «символ, 0x00» — если нулей примерно
  // половина, это точно он.
  let nulls = 0;
  for (let i = 0; i < buffer.length; i += 1) if (buffer[i] === 0) nulls += 1;

  if (buffer.length >= 4 && nulls > buffer.length / 4) {
    return buffer.toString('utf16le');
  }
  return buffer.toString('utf8');
}

/** Собрать аргументы wsl.exe с учётом того, от кого запускать. */
function buildArgs(distro, user, script) {
  const args = ['-d', distro];
  // user === null означает «пользователь дистрибутива по умолчанию»:
  // именно там лежит токен Apple ID, созданный xtool auth.
  if (user !== null) args.push('-u', user || 'root');
  args.push('--', 'bash', '-lc', encodeScript(script));
  return args;
}

/**
 * Запустить скрипт в дистрибутиве.
 *
 * @param {{distro: string, user?: string|null, script: string,
 *          onOutput?: Function, signal?: AbortSignal}} options
 *   user: 'root' (по умолчанию) — системные задачи;
 *         null — обычный пользователь, где хранится токен Apple ID.
 */
function run(options) {
  const { distro, script, onOutput, signal } = options;

  return new Promise((resolve) => {
    const child = spawn('wsl.exe', buildArgs(distro, options.user, script), {
      windowsHide: true,
      env: WSL_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const push = (buffer) => {
      const text = decodeChunk(buffer);
      output += text;
      if (onOutput) onOutput(text);
    };

    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (error) => resolve({ ok: false, error: error.message, output }));
    child.on('close', (code) => resolve({ ok: code === 0, code, output }));

    if (signal) {
      signal.addEventListener('abort', () => {
        try {
          child.kill();
        } catch {
          /* уже завершился */
        }
      });
    }
  });
}

/** Короткая команда без многострочного скрипта — для быстрых проверок. */
function probe(distro, command, timeout = 60000, user = 'root') {
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', buildArgs(distro, user, command), {
      windowsHide: true,
      env: WSL_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (buffer) => {
      output += decodeChunk(buffer);
    });
    child.stderr.on('data', (buffer) => {
      output += decodeChunk(buffer);
    });

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* уже завершился */
      }
      resolve({ ok: false, output, error: 'timeout' });
    }, timeout);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output });
    });
  });
}

module.exports = { run, probe, encodeScript, buildArgs, decodeChunk, WSL_ENV };
