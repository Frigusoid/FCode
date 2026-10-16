/*
 * Smoke-тест интерфейса через Chrome DevTools Protocol.
 *
 * Запускает уже работающее окно FCode (Electron с --remote-debugging-port),
 * нажимает указанный элемент, собирает ошибки консоли и снимает состояние DOM.
 * Нужен, чтобы проверять интерфейс автоматически, а не «на глаз».
 *
 * Использование:
 *   node scripts/smoke-test.mjs --click #btn-xtool --wait 5000
 *   node scripts/smoke-test.mjs --eval "document.title"
 *   node scripts/smoke-test.mjs --eval-file scripts/check.js
 */

import fs from 'node:fs';

const PORT = process.env.FCODE_CDP_PORT || 9222;

function parseArgs(argv) {
  const args = { clicks: [], evals: [], wait: 3000, port: PORT };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--click') args.clicks.push(argv[++i]);
    else if (key === '--eval') args.evals.push(argv[++i]);
    // Выражение из файла: удобно, когда внутри кавычки или обратные апострофы —
    // командная строка Windows их искажает.
    else if (key === '--eval-file') {
      const file = argv[++i];
      args.evals.push(fs.readFileSync(file, 'utf8'));
    }
    else if (key === '--wait') args.wait = Number(argv[++i]);
    else if (key === '--port') args.port = Number(argv[++i]);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPage(port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* окно ещё поднимается */
    }
    await sleep(500);
  }
  throw new Error(`Не удалось подключиться к CDP на порту ${port}. Запущен ли FCode с --remote-debugging-port?`);
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.logErrors = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });

    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
        return;
      }
      // Ошибки интерфейса — то, ради чего этот тест и нужен.
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        this.consoleErrors.push(
          details.exception?.description || details.text || 'исключение без описания',
        );
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.consoleErrors.push(
          message.params.args.map((a) => a.value ?? a.description ?? '').join(' '),
        );
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        this.logErrors.push(message.params.entry.text);
      }
    });

    await this.send('Runtime.enable');
    await this.send('Log.enable');
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Выполнить выражение в контексте страницы и вернуть значение. */
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (response.result?.exceptionDetails) {
      const details = response.result.exceptionDetails;
      throw new Error(details.exception?.description || details.text);
    }
    return response.result?.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* уже закрыт */
    }
  }
}

async function main() {
  const page = await findPage(args.port);
  console.log(`Подключение к: ${page.title} — ${page.url}`);

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();

  // Базовое состояние до нажатий.
  const initial = await cdp.evaluate(`
    JSON.stringify({
      title: document.title,
      hasToolbar: Boolean(document.querySelector('.toolbar')),
      buttons: [...document.querySelectorAll('.tb-btn')].map((b) => b.id || b.textContent.trim()),
      consoleLines: document.querySelectorAll('.log-line').length,
      modalVisible: !document.getElementById('modal').classList.contains('hidden')
    })
  `);
  console.log('Начальное состояние:', initial);

  for (const selector of args.clicks) {
    console.log(`--- нажимаю ${selector} ---`);
    const clicked = await cdp.evaluate(`
      (() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return 'НЕ НАЙДЕН';
        node.click();
        return 'нажато';
      })()
    `);
    console.log(`  ${clicked}`);
    if (clicked !== 'нажато') continue;

    await sleep(args.wait);

    const after = await cdp.evaluate(`
      JSON.stringify({
        modalVisible: !document.getElementById('modal').classList.contains('hidden'),
        modalTitle: document.getElementById('modal-title').textContent,
        modalCards: document.querySelectorAll('#modal-body .limit-card').length,
        modalCommands: [...document.querySelectorAll('#modal-body .cmd')].map((n) => n.textContent.slice(0, 70)),
        consoleLines: document.querySelectorAll('.log-line').length,
        lastLogs: [...document.querySelectorAll('.log-line')].slice(-6).map((n) => n.textContent.trim().slice(0, 130)),
        status: document.getElementById('status-pill').textContent,
        linuxPanel: !document.getElementById('linux-panel').classList.contains('hidden'),
        linuxSteps: document.querySelectorAll('.linux-step').length,
        wizardFields: document.querySelectorAll('.wizard input, .wizard select').length,
        wizardPreview: (document.getElementById('np-preview') || {}).textContent || null
      })
    `);
    console.log('  Состояние после:', after);
  }

  for (const expression of args.evals) {
    console.log(`--- eval: ${expression}`);
    console.log('  =>', await cdp.evaluate(expression));
  }

  console.log('--- ошибки консоли ---');
  if (cdp.consoleErrors.length === 0 && cdp.logErrors.length === 0) {
    console.log('  нет');
  } else {
    cdp.consoleErrors.forEach((e) => console.log('  [console]', e));
    cdp.logErrors.forEach((e) => console.log('  [log]', e));
  }

  cdp.close();
  process.exit(cdp.consoleErrors.length || cdp.logErrors.length ? 2 : 0);
}

main().catch((error) => {
  console.error('Smoke-тест не прошёл:', error.message);
  process.exit(1);
});
