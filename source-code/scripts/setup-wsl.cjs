'use strict';
/*
 * Установка окружения сборки из командной строки.
 *
 * Тот же движок, что и за кнопкой Run в интерфейсе, но без окна — удобно
 * запускать в фоне и смотреть журнал в терминале.
 *
 * Использование:
 *   node scripts/setup-wsl.cjs
 */

const setup = require('../src/main/modules/setup');
const i18n = require('../src/shared/i18n');

i18n.setLanguage(process.env.FCODE_LANG || 'ru');

const labels = {
  'wsl-components': 'Компоненты WSL',
  distro: 'Дистрибутив Linux',
  swift: 'Swift 6.1',
  usbmuxd: 'usbmuxd',
  xtool: 'xtool',
  'ios-sdk': 'iOS Swift SDK',
  'apple-id': 'Авторизация Apple ID',
};

let lastStep = null;

setup
  .autoSetup({
    onOutput: (text) => process.stdout.write(text),
    onStep: (step) => {
      if (step.status === 'running' && step.id !== lastStep) {
        lastStep = step.id;
        process.stdout.write(`\n\n===== ${labels[step.id] || step.id} =====\n`);
      }
    },
  })
  .then((result) => {
    process.stdout.write('\n\n========== ИТОГ ==========\n');
    process.stdout.write(`выполнено: ${result.completed.join(', ') || '—'}\n`);
    process.stdout.write(`пропущено: ${result.skipped.join(', ') || '—'}\n`);
    if (result.stopped) {
      process.stdout.write(`остановлено на: ${result.stopped.id} (${result.stopped.reason})\n`);
    } else {
      process.stdout.write('все автоматические шаги пройдены\n');
    }
    const manual = (result.results || []).filter((item) => item.status === 'manual');
    if (manual.length) {
      process.stdout.write(`вручную осталось: ${manual.map((m) => m.needs).join(', ')}\n`);
    }
    process.exit(0);
  })
  .catch((error) => {
    process.stdout.write(`\nОШИБКА: ${error.message}\n`);
    process.exit(1);
  });
