/*
 * Окно входа в Apple Developer Services.
 *
 * Сделано по образцу системного окна Apple: логотип, заголовок с пояснением,
 * поля Apple ID и пароля, ссылка «забыли пароль», кнопки внизу. Отличие одно:
 * вместо логотипа Apple — нейтральный знак, потому что это товарный знак.
 *
 * Окно не просто собирает данные: оно ведёт живой диалог с командой xtool auth.
 * Та печатает приглашения по мере работы (код двухфакторной аутентификации,
 * выбор команды разработчика), и окно показывает под них нужный шаг.
 */

import { mountIcons } from './icons.js';

const STEPS = {
  credentials: 'credentials',
  key: 'key',
  question: 'question',
  twofactor: 'twofactor',
  team: 'team',
  working: 'working',
  done: 'done',
  failed: 'failed',
};

/** Путь Windows -> путь внутри WSL: C:\keys\a.p8 -> /mnt/c/keys/a.p8 */
function toWslPath(windowsPath) {
  const match = /^([A-Za-z]):\\(.*)$/.exec(String(windowsPath).trim());
  if (!match) return String(windowsPath).trim().replace(/\\/g, '/');
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

/** Разобрать нумерованный список вариантов из вывода команды. */
function parseChoices(output) {
  const choices = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = /^\s*(\d+)[:.)]\s*(.+?)\s*$/.exec(line);
    if (match && match[2].length > 1) choices.push({ index: Number(match[1]), label: match[2] });
  }
  return choices;
}

/**
 * Открыть окно входа.
 * @param {{api: object, t: Function, esc: Function, log: Function, distro?: string}} context
 * @returns {Promise<{ok: boolean, cancelled?: boolean}>}
 */
export function openSignIn(context) {
  const { api, t, esc, log } = context;

  return new Promise((resolve) => {
    let step = STEPS.credentials;
    let outputBuffer = '';
    let finished = false;
    /** Текст ошибки от Apple и подсказка, что с ней делать. */
    let failureReason = '';
    let failureHint = '';
    /** Ответы для режима API-ключа: xtool спрашивает их по очереди. */
    const pendingKeyAnswers = [];
    const disposers = [];

    const overlay = document.createElement('div');
    overlay.className = 'signin-overlay';
    overlay.innerHTML = `
      <div class="signin-window" role="dialog" aria-modal="true">
        <div class="signin-head">
          <div class="signin-headtext">
            <h3 id="signin-title">${esc(t('auth.title'))}</h3>
            <p id="signin-subtitle">${esc(t('auth.subtitle'))}</p>
          </div>
        </div>

        <div class="signin-body" id="signin-body"></div>

        <div class="signin-log" id="signin-log"></div>

        <div class="signin-foot">
          <button class="signin-btn" id="signin-secondary">${esc(t('auth.createAccount'))}</button>
          <span class="signin-spacer"></span>
          <button class="signin-btn" id="signin-cancel">${esc(t('modal.cancel'))}</button>
          <button class="signin-btn primary" id="signin-submit">${esc(t('auth.signIn'))}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    mountIcons(overlay);

    const body = overlay.querySelector('#signin-body');
    const logBox = overlay.querySelector('#signin-log');
    const submit = overlay.querySelector('#signin-submit');
    const cancel = overlay.querySelector('#signin-cancel');
    const secondary = overlay.querySelector('#signin-secondary');
    const subtitle = overlay.querySelector('#signin-subtitle');

    const appendLog = (text) => {
      const cleaned = String(text || '').replace(/\r/g, '');
      if (!cleaned.trim()) return;
      outputBuffer += cleaned;
      logBox.textContent += cleaned;
      logBox.scrollTop = logBox.scrollHeight;
    };

    const cleanup = () => {
      if (finished) return;
      finished = true;
      disposers.forEach((dispose) => dispose());
      api.auth.cancel().catch(() => {});
      overlay.remove();
    };

    const close = (result) => {
      cleanup();
      resolve(result);
    };

    /** Нарисовать текущий шаг. */
    const render = () => {
      submit.classList.remove('hidden');
      secondary.classList.remove('hidden');

      if (step === STEPS.credentials) {
        subtitle.textContent = t('auth.subtitle');
        body.innerHTML = `
          <label class="signin-row">
            <span>${esc(t('auth.appleId'))}</span>
            <input id="signin-user" class="signin-input" autocomplete="off" spellcheck="false" />
          </label>
          <label class="signin-row">
            <span>${esc(t('auth.password'))}</span>
            <input id="signin-pass" class="signin-input" type="password" autocomplete="off" />
          </label>
          <div class="signin-links">
            <button class="signin-link" id="signin-forgot">${esc(t('auth.forgot'))}</button>
            <button class="signin-link" id="signin-use-key">${esc(t('auth.useKey'))}</button>
            <button class="signin-link" id="signin-terminal">${esc(t('auth.viaTerminal'))}</button>
          </div>
          <p class="signin-hint">${esc(t('auth.viaTerminalHint'))}</p>
        `;
        submit.textContent = t('auth.signIn');

        body.querySelector('#signin-use-key').onclick = () => {
          step = STEPS.key;
          render();
        };
        body.querySelector('#signin-forgot').onclick = () => {
          api.shell.open('https://iforgot.apple.com/password/verify/appleid');
        };

        // Запасной путь: вход в настоящем терминале Ubuntu. Там xtool ведёт
        // диалог сам, включая код двухфакторной проверки — это помогает, когда
        // ответ Apple не удаётся разобрать своим окном.
        body.querySelector('#signin-terminal').onclick = async () => {
          const entered = (body.querySelector('#signin-user').value || '').trim();
          const command = entered
            ? `xtool auth login --mode password --username ${JSON.stringify(entered)}`
            : 'xtool auth login --mode password';
          await api.xtool.terminal(command, context.distro);
          appendLog(`${t('auth.viaTerminalOpened')}\n`);
        };

        body.querySelector('#signin-user').focus();
      }

      if (step === STEPS.key) {
        subtitle.textContent = t('auth.keySubtitle');
        body.innerHTML = `
          <label class="signin-row">
            <span>${esc(t('auth.keyId'))}</span>
            <input id="signin-keyid" class="signin-input" autocomplete="off" spellcheck="false" />
          </label>
          <label class="signin-row">
            <span>${esc(t('auth.issuerId'))}</span>
            <input id="signin-issuer" class="signin-input" autocomplete="off" spellcheck="false" />
          </label>
          <label class="signin-row">
            <span>${esc(t('auth.keyPath'))}</span>
            <input id="signin-keypath" class="signin-input" placeholder="C:\\keys\\AuthKey_XXX.p8" autocomplete="off" spellcheck="false" />
          </label>
          <div class="signin-links">
            <button class="signin-link" id="signin-use-password">${esc(t('auth.usePassword'))}</button>
          </div>
        `;
        submit.textContent = t('auth.signIn');
        body.querySelector('#signin-use-password').onclick = () => {
          step = STEPS.credentials;
          render();
        };
        body.querySelector('#signin-keyid').focus();
      }

      if (step === STEPS.twofactor) {
        subtitle.textContent = t('auth.twoFactorSubtitle');
        body.innerHTML = `
          <label class="signin-row">
            <span>${esc(t('auth.code'))}</span>
            <input id="signin-code" class="signin-input code" maxlength="6" inputmode="numeric" autocomplete="off" />
          </label>
          <p class="signin-hint">${esc(t('auth.twoFactorHint'))}</p>
        `;
        submit.textContent = t('auth.confirm');
        body.querySelector('#signin-code').focus();
      }

      if (step === STEPS.team) {
        subtitle.textContent = t('auth.teamSubtitle');
        const choices = parseChoices(outputBuffer);
        body.innerHTML = `
          <div class="signin-choices">
            ${choices
              .map(
                (choice) =>
                  `<button class="signin-choice" data-index="${choice.index}">
                    <span class="signin-choice-index">${choice.index}</span>
                    <span>${esc(choice.label)}</span>
                  </button>`,
              )
              .join('')}
          </div>
        `;
        submit.classList.add('hidden');
        body.querySelectorAll('.signin-choice').forEach((button) => {
          button.onclick = () => {
            api.auth.answer(button.dataset.index);
            step = STEPS.working;
            render();
          };
        });
      }

      if (step === STEPS.question) {
        subtitle.textContent = t('auth.questionSubtitle');
        body.innerHTML = `
          <p class="signin-hint">${esc(context.t('auth.questionHint'))}</p>
          <label class="signin-row">
            <span>${esc(t('auth.answer'))}</span>
            <input id="signin-answer" class="signin-input" autocomplete="off" spellcheck="false" />
          </label>
        `;
        submit.textContent = t('auth.confirm');
        body.querySelector('#signin-answer').focus();
      }

      if (step === STEPS.working) {
        subtitle.textContent = t('auth.working');
        body.innerHTML = `<div class="signin-progress"><span class="spinner"></span> ${esc(t('auth.working'))}</div>`;
        submit.classList.add('hidden');
      }

      if (step === STEPS.done) {
        subtitle.textContent = t('auth.successSubtitle');
        body.innerHTML = `<div class="signin-result ok">${esc(t('auth.success'))}</div>`;
        submit.textContent = t('modal.ok');
        submit.onclick = () => close({ ok: true });
        secondary.classList.add('hidden');
        cancel.classList.add('hidden');
      }

      if (step === STEPS.failed) {
        subtitle.textContent = t('auth.failedSubtitle');
        // Показываем настоящую причину: xtool печатает её в выводе, а общее
        // «проверьте пароль» вводит в заблуждение, когда дело в блокировке
        // попыток или в коде двухфакторной проверки.
        const reason = failureReason || t('auth.failedUnknown');
        body.innerHTML =
          `<div class="signin-result bad">${esc(t('auth.failed'))}</div>` +
          `<p class="signin-hint">${esc(t('auth.failedReason', { reason }))}</p>` +
          (failureHint ? `<p class="signin-hint">${esc(failureHint)}</p>` : '');
        submit.textContent = t('auth.retry');
        submit.onclick = () => {
          failureReason = '';
          failureHint = '';
          step = STEPS.credentials;
          submit.onclick = null;
          render();
        };
      }
    };

    /**
     * Достать причину отказа из вывода xtool.
     *
     * xtool печатает строку вида «Error: This action cannot be completed at
     * this time. (-80045)». Раньше интерфейс её выбрасывал и всегда показывал
     * «проверьте пароль» — даже когда дело было в блокировке попыток или в
     * двухфакторном коде. Здесь показываем настоящий текст и подсказку для
     * известных кодов Apple.
     */
    const explainFailure = (text) => {
      const lines = String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      const errorLine = [...lines].reverse().find((line) => /^error[:!]/i.test(line))
        || [...lines].reverse().find((line) => /error|failed|invalid|incorrect/i.test(line))
        // Совсем незнакомый текст: лучше показать последнюю строку, чем ничего.
        || lines[lines.length - 1]
        || '';

      const reason = errorLine.replace(/^error[:!]\s*/i, '').trim();
      let hint = '';

      // Порядок важен: проверки на сбой Windows/WSL идут первыми, иначе текст
      // «недостаточно ресурсов» можно принять за что угодно другое.
      if (/ERROR_NO_SYSTEM_RESOURCES|CreateInstance|CreateVm|недостаточно системных ресурсов|not enough memory/i.test(reason)) {
        // Не путать с паролем: Apple тут вообще ни при чём — не запустилась WSL.
        hint = t('auth.hintNoResources');
      } else if (/-80045|-20101|too many|cannot be completed/i.test(reason)) {
        hint = t('auth.hintTooMany');
      } else if (/incorrect|invalid password|wrong password|-20101/i.test(reason)) {
        hint = t('auth.hintPassword');
      } else if (/two-factor|2fa|verification code/i.test(reason)) {
        hint = t('auth.hintTwoFactor');
      } else if (/session|expired|token/i.test(reason)) {
        hint = t('auth.hintSession');
      } else {
        // Всё остальное — общая подсказка. Именно этот случай раньше оставлял
        // человека без объяснений.
        hint = t('auth.hintUnknown');
      }

      return { reason, hint };
    };

    /** Отправить данные текущего шага. */
    const onSubmit = () => {
      if (step === STEPS.credentials) {
        const username = body.querySelector('#signin-user').value.trim();
        const password = body.querySelector('#signin-pass').value;
        if (!username || !password) return;
        step = STEPS.working;
        render();
        outputBuffer = '';
        logBox.textContent = '';
        api.auth.start({ mode: 'password', username, password, distro: context.distro }).catch((error) => {
          appendLog(`\n${error.message}\n`);
          step = STEPS.failed;
          render();
        });
        return;
      }

      if (step === STEPS.key) {
        const keyId = body.querySelector('#signin-keyid').value.trim();
        const issuer = body.querySelector('#signin-issuer').value.trim();
        const keyPath = body.querySelector('#signin-keypath').value.trim();
        if (!keyId || !issuer || !keyPath) return;

        // Команда выполняется внутри Linux, поэтому путь Windows переводим
        // в /mnt/...: иначе файл ключа не найдётся.
        pendingKeyAnswers.push(keyId, issuer, toWslPath(keyPath));

        step = STEPS.working;
        render();
        outputBuffer = '';
        logBox.textContent = '';
        api.auth.start({ mode: 'key', distro: context.distro }).catch((error) => {
          appendLog(`\n${error.message}\n`);
          step = STEPS.failed;
          render();
        });
        return;
      }

      const input = body.querySelector('#signin-code') || body.querySelector('#signin-answer');
      if (!input || !input.value.trim()) return;
      const answer = input.value.trim();
      step = STEPS.working;
      render();
      api.auth.answer(answer);
    };

    // --- подписки на события команды ---
    disposers.push(api.auth.onOutput((text) => appendLog(text)));

    disposers.push(
      api.auth.onPrompt((prompt) => {
        appendLog(`\n${prompt}\n`);

        // В режиме ключа вопросы известны заранее — отвечаем без участия человека.
        if (pendingKeyAnswers.length > 0) {
          api.auth.answer(pendingKeyAnswers.shift());
          return;
        }

        if (/two-?factor|2fa|verification|code|authentication/i.test(prompt)) {
          step = STEPS.twofactor;
        } else if (parseChoices(outputBuffer).length > 0 || /select|choose/i.test(prompt)) {
          step = STEPS.team;
        } else {
          step = STEPS.question;
        }
        render();
      }),
    );

    disposers.push(
      api.auth.onDone((result) => {
        if (result && result.ok) {
          step = STEPS.done;
          render();
          log(t('auth.success'), 'ok');
        } else {
          const explained = explainFailure(outputBuffer);
          failureReason = explained.reason;
          failureHint = explained.hint;
          step = STEPS.failed;
          render();
          log(t('auth.failed'), 'error');
          // Причина в консоль: по ней видно, что именно ответила Apple.
          if (explained.reason) log(`  ${explained.reason}`, 'dim');
        }
      }),
    );

    submit.onclick = onSubmit;
    cancel.onclick = () => {
      cleanup();
      resolve({ ok: false, cancelled: true });
    };
    secondary.onclick = () => {
      api.shell.open('https://appleid.apple.com/account');
    };

    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (step === STEPS.team || step === STEPS.done) return;
        onSubmit();
      }
      if (event.key === 'Escape') {
        cleanup();
        resolve({ ok: false, cancelled: true });
      }
    });

    logBox.classList.toggle('hidden', true);
    render();
    overlay.querySelector('.signin-window').focus();
  });
}
