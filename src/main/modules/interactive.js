'use strict';
/*
 * Драйвер интерактивных команд в WSL.
 *
 * Нужен, чтобы показывать вход в Apple ID своим окном, а не в терминале.
 * xtool auth — обычная консольная программа: печатает приглашение, ждёт строку,
 * печатает следующее. Мы запускаем её с подключёнными потоками, ловим
 * приглашения и передаём их в интерфейс, а ответы пользователя отправляем обратно
 * в stdin.
 *
 * Как распознаётся приглашение: программа печатает текст без перевода строки и
 * ждёт ввод. Поэтому смотрим на «хвост» вывода после последнего \n — если он
 * непустой и заканчивается двоеточием или вопросительным знаком, это вопрос.
 *
 * Тот же драйвер подходит для любой другой интерактивной команды xtool.
 */

const { spawn } = require('child_process');
const { t } = require('../../shared/i18n');

/** Похож ли хвост вывода на приглашение ко вводу. */
function looksLikePrompt(tail) {
  const trimmed = tail.trim();
  if (!trimmed || trimmed.length > 500) return false;
  // Строка выбора вида «Select a team (0-2): » тоже подходит.
  return /[:?]\s*$/.test(trimmed);
}

class InteractiveSession {
  /**
   * @param {{distro?: string, command: string, onOutput?: Function, onPrompt?: Function,
   *          onDone?: Function, timeout?: number}} options
   */
  constructor(options) {
    this.distro = options.distro || 'Ubuntu';
    this.command = options.command;
    this.onOutput = options.onOutput || (() => {});
    this.onPrompt = options.onPrompt || (() => {});
    this.onDone = options.onDone || (() => {});
    this.timeout = options.timeout || 15 * 60 * 1000;

    this.child = null;
    this.buffer = '';
    this.pendingPrompt = null;
    this.finished = false;
    this.timer = null;
  }

  start() {
    if (this.child) return;

    this.onOutput(`${t('auth.running')}\n`);

    // Без -u root: вход должен сохраниться в тот же профиль, где xtool
    // потом будет искать токен.
    this.child = spawn(
      'wsl.exe',
      ['-d', this.distro, '--', 'bash', '-lc', this.command],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const consume = (chunk) => {
      const text = chunk.toString('utf8');
      this.buffer += text;
      this.onOutput(text);

      const tail = this.buffer.slice(this.buffer.lastIndexOf('\n') + 1);
      if (looksLikePrompt(tail)) {
        const prompt = tail.trim();
        // Не повторяем один и тот же вопрос, пока на него не ответили.
        if (this.pendingPrompt !== prompt) {
          this.pendingPrompt = prompt;
          this.onPrompt(prompt);
        }
      }
    };

    this.child.stdout.on('data', consume);
    this.child.stderr.on('data', consume);

    // Оборванный ввод — обычное дело, если команда завершилась сама.
    // Без обработчика событие «error» на потоке остаётся необработанным
    // и роняет приложение.
    this.child.stdin.on('error', (error) => {
      if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') return;
      this.finish({ ok: false, error: error.message });
    });

    this.child.on('error', (error) => {
      this.finish({ ok: false, error: error.message });
    });

    this.child.on('close', (code) => {
      this.finish({ ok: code === 0, code });
    });

    // Страховка от зависания на вопросе, которого мы не распознали.
    this.timer = setTimeout(() => {
      this.onOutput(`\n${t('auth.timeout')}\n`);
      this.cancel();
    }, this.timeout);
  }

  /** Ответить на текущее приглашение. */
  send(answer) {
    if (!this.child || this.finished) return false;
    this.pendingPrompt = null;
    this.buffer = '';
    try {
      this.child.stdin.write(`${answer}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** Прервать сессию. */
  cancel() {
    if (!this.child) return;
    try {
      this.child.kill();
    } catch {
      /* уже завершился */
    }
  }

  finish(result) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    this.child = null;
    this.onDone(result);
  }
}

/** Сколько живых сессий — чтобы не запускать вход дважды. */
const sessions = new Map();

function createSession(id, options) {
  if (sessions.has(id)) sessions.get(id).cancel();
  const session = new InteractiveSession(options);
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  return sessions.get(id) || null;
}

function closeSession(id) {
  const session = sessions.get(id);
  if (session) {
    session.cancel();
    sessions.delete(id);
  }
}

module.exports = { InteractiveSession, createSession, getSession, closeSession, looksLikePrompt };
