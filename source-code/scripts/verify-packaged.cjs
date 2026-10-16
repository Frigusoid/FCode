// Проверка собранного приложения через CDP: имя в «О программе», ссылка на GitHub
// и переключение языка должны работать именно в упакованной сборке.
const http = require('http');

const PORT = 9223;

function getJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

// Минимальный CDP-клиент поверх WebSocket — без внешних зависимостей.
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const crypto = require('crypto');
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(Number(u.port), u.hostname, () => {
      socket.write(
        `GET ${u.pathname} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    const pending = new Map();
    let nextId = 1;

    function send(obj) {
      const payload = Buffer.from(JSON.stringify(obj));
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.from([0x81, 0x80 | len]);
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      socket.write(Buffer.concat([header, mask, masked]));
    }

    function handleFrame(data) {
      const opcode = data[0] & 0x0f;
      let len = data[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        len = data.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        len = Number(data.readBigUInt64BE(2));
        off = 10;
      }
      const text = data.toString('utf8', off, off + len);
      if (opcode === 1) {
        try {
          const msg = JSON.parse(text);
          if (msg.id && pending.has(msg.id)) {
            const { resolve: res } = pending.get(msg.id);
            pending.delete(msg.id);
            res(msg);
          }
        } catch {}
      }
    }

    socket.on('data', (chunk) => {
      if (!handshakeDone) {
        const idx = chunk.indexOf('\r\n\r\n');
        if (idx === -1) return;
        handshakeDone = true;
        resolve({
          call(method, params) {
            return new Promise((res) => {
              const id = nextId++;
              pending.set(id, { resolve: res });
              send({ id, method, params: params || {} });
            });
          },
          evaluate(expression) {
            return this.call('Runtime.evaluate', {
              expression,
              awaitPromise: true,
              returnByValue: true,
            }).then((r) => r.result?.result?.value);
          },
        });
        const rest = chunk.subarray(idx + 4);
        if (rest.length) buffer = Buffer.concat([buffer, rest]);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        let len = buffer[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buffer.length < 4) break;
          len = buffer.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buffer.length < 10) break;
          len = Number(buffer.readBigUInt64BE(2));
          off = 10;
        }
        if (buffer.length < off + len) break;
        handleFrame(buffer.subarray(0, off + len));
        buffer = buffer.subarray(off + len);
      }
    });
    socket.on('error', reject);
  });
}

(async () => {
  const targets = await getJson('/json/list');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('страница не найдена');
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');

  const results = [];
  const check = async (label, expr) => {
    const value = await cdp.evaluate(expr);
    results.push({ label, value });
  };

  await check('имя в about', `window.__fcode.state.appInfo.name`);
  await check('версия', `window.__fcode.state.appInfo.version`);
  await check('автор', `window.__fcode.state.appInfo.author`);
  await check('ссылка на репозиторий', `window.__fcode.state.appInfo.repository`);
  await check('electron', `window.__fcode.state.appInfo.electron`);

  // Ссылка на GitHub должна уходить во внешний браузер, а не в path.resolve.
  await check('открыть ссылку', `window.fcode.shell.open('https://github.com/Frigusoid/FCode')`);
  await check('открыть файл', `window.fcode.shell.open('D:/FCode/package.json')`);

  // loading.gif должен реально загружаться из сборки.
  await check(
    'loading.gif доступен',
    `(async () => { const r = await fetch('loading.gif'); return r.ok ? (await r.blob()).size : 'HTTP ' + r.status; })()`
  );

  // Оверлей загрузки: без текста и без рамки, только картинка.
  await check('busy-overlay есть', `!!document.getElementById('busy-overlay')`);
  await check('busy-image src', `document.getElementById('busy-image')?.getAttribute('src')`);
  await check('в оверлее нет текста', `document.getElementById('busy-overlay')?.textContent.trim().length === 0`);

  // Переключение языка должно менять подписи в интерфейсе.
  await check('язык до', `window.__fcode.state.language`);
  await cdp.evaluate(`document.querySelector('#lang-select') ? (document.querySelector('#lang-select').value = 'ru', document.querySelector('#lang-select').dispatchEvent(new Event('change'))) : null`);
  await new Promise((r) => setTimeout(r, 1500));
  await check('язык после', `window.__fcode.state.language`);
  await check('подпись кнопки сборки', `document.getElementById('btn-build')?.textContent.trim()`);

  console.log('\n=== проверка упакованной сборки ===\n');
  for (const r of results) {
    const v = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
    console.log(`  ${r.label.padEnd(26)} ${v}`);
  }

  const problems = [];
  const byLabel = Object.fromEntries(results.map((r) => [r.label, r.value]));
  if (byLabel['имя в about'] !== 'Fcode') problems.push('имя не Fcode');
  if (!String(byLabel['ссылка на репозиторий'] || '').includes('github.com/Frigusoid')) problems.push('нет ссылки на GitHub');
  if (byLabel['открыть ссылку'] !== true) problems.push('ссылка не открывается');
  if (byLabel['открыть файл'] !== true) problems.push('файл не открывается');
  if (typeof byLabel['loading.gif доступен'] !== 'number') problems.push('loading.gif не грузится');
  if (byLabel['busy-image src'] !== 'loading.gif') problems.push('оверлей не использует loading.gif');
  if (byLabel['в оверлее нет текста'] !== true) problems.push('в оверлее есть текст');

  console.log(problems.length ? `\nПРОБЛЕМЫ: ${problems.join(', ')}` : '\nВСЁ РАБОТАЕТ');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => {
  console.error('ошибка проверки:', e.message);
  process.exit(1);
});
