// Проверяет окно сборки: строка иконки и выбор «для устройства / App Store».
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const PORT = Number(process.argv[2] || 9222);
const PROJECT = process.argv[3] || 'D:\\FCode-work\\icontest';

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const socket = net.connect(Number(u.port), u.hostname, () => {
      socket.write(
        `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let ready = false, buf = Buffer.alloc(0);
    const pending = new Map();
    let nextId = 1;
    function sendRaw(obj) {
      const p = Buffer.from(JSON.stringify(obj));
      const len = p.length;
      let h;
      if (len < 126) h = Buffer.from([0x81, 0x80 | len]);
      else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); }
      else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2); }
      const mask = crypto.randomBytes(4);
      const m = Buffer.from(p);
      for (let i = 0; i < m.length; i++) m[i] ^= mask[i % 4];
      socket.write(Buffer.concat([h, mask, m]));
    }
    function frame(d) {
      const op = d[0] & 0x0f;
      let len = d[1] & 0x7f, off = 2;
      if (len === 126) { len = d.readUInt16BE(2); off = 4; }
      else if (len === 127) { len = Number(d.readBigUInt64BE(2)); off = 10; }
      if (op !== 1) return;
      try {
        const msg = JSON.parse(d.toString('utf8', off, off + len));
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      } catch {}
    }
    socket.on('data', (chunk) => {
      if (!ready) {
        const i = chunk.indexOf('\r\n\r\n');
        if (i === -1) return;
        ready = true;
        resolve({
          call: (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); sendRaw({ id, method, params: params || {} }); }),
          evaluate(expr) {
            return this.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
              .then((r) => r.result?.result?.value);
          },
        });
        const rest = chunk.subarray(i + 4);
        if (rest.length) buf = Buffer.concat([buf, rest]);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        frame(buf.subarray(0, off + len));
        buf = buf.subarray(off + len);
      }
    });
    socket.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const page = (await getJson('/json/list')).find((t) => t.type === 'page');
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');

  await cdp.evaluate(`window.fcode.workspace.load(${JSON.stringify(PROJECT)})`);
  await sleep(2500);

  // Кнопка сборки открывает окно выбора.
  await cdp.evaluate(`document.getElementById('btn-build').click()`);
  await sleep(3000);

  const info = await cdp.evaluate(`(() => {
    const modal = document.getElementById('modal');
    const body = document.getElementById('modal-body');
    const foot = document.getElementById('modal-foot');
    return {
      открыто: modal ? !modal.classList.contains('hidden') : false,
      заголовок: document.getElementById('modal-title')?.textContent || '',
      иконка: Boolean(document.getElementById('build-icon-import')),
      превью: Boolean(document.getElementById('build-icon-preview')),
      подпись: document.getElementById('build-icon-note')?.textContent || '',
      карточки: [...body.querySelectorAll('.limit-card h4')].map((h) => h.textContent.trim()),
      кнопки: [...foot.querySelectorAll('button')].map((b) => b.textContent.trim()),
    };
  })()`);

  console.log('\n=== окно сборки ===');
  console.log(`  открыто   : ${info.открыто}`);
  console.log(`  заголовок : ${info.заголовок}`);
  console.log(`  карточки  : ${info.карточки.join(' / ')}`);
  console.log(`  кнопки    : ${info.кнопки.join(' / ')}`);
  console.log(`  строка иконки : ${info.иконка ? 'есть' : 'НЕТ'}`);
  console.log(`  превью        : ${info.превью ? 'есть' : 'НЕТ'}`);
  console.log(`  подпись       : ${info.подпись}`);

  // Закрываем, чтобы не запустить сборку.
  await cdp.evaluate(`document.getElementById('modal-close').click()`);

  const toolbar = await cdp.evaluate(`(() => ({
    appIcon: Boolean(document.getElementById('btn-app-icon')),
    preview: Boolean(document.getElementById('btn-preview')),
    xcode: Boolean(document.getElementById('btn-make-xcode')),
    всего: document.querySelectorAll('.toolbar .tb-btn').length,
  }))()`);

  console.log('');
  console.log('=== панель инструментов ===');
  console.log(`  кнопок всего     : ${toolbar.всего}`);
  console.log(`  App icon убрана  : ${toolbar.appIcon ? 'НЕТ' : 'да'}`);
  console.log(`  Preview убрана   : ${toolbar.preview ? 'НЕТ' : 'да'}`);
  console.log(`  .xcodeproj убрана: ${toolbar.xcode ? 'НЕТ' : 'да'}`);

  const ok = info.открыто && info.иконка && info.превью && info.кнопки.length === 3;
  console.log(`\n${ok ? 'ОК' : 'ЕСТЬ ПРОБЛЕМЫ'}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ошибка:', e.message); process.exit(1); });
