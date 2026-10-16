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

/** Обернуть скрипт в base64 — так он дойдёт до bash без искажений. */
function encodeScript(script) {
  return `echo ${Buffer.from(script, 'utf8').toString('base64')} | base64 -d | bash`;
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
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const push = (buffer) => {
      const text = buffer.toString('utf8');
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
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (buffer) => {
      output += buffer.toString('utf8');
    });
    child.stderr.on('data', (buffer) => {
      output += buffer.toString('utf8');
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

module.exports = { run, probe, encodeScript, buildArgs };
