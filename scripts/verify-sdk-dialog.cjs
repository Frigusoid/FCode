// Проверка диалога установки SDK: только путь к .xip, без варианта с Mac.
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.argv[2] || 9222);
const SHOT = process.argv[3] || path.join(__dirname, '..', 'sdk-dialog.png');

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
    const net = require('net');
    const crypto = require('crypto');
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
  await cdp.call('Page.enable');

  // Открываем панель требований, затем диалог SDK.
  await cdp.evaluate(`document.getElementById('btn-xtool').click()`);
  await sleep(1500);
  await cdp.evaluate(`document.getElementById('btn-ios-sdk').click()`);
  await sleep(2500);

  const state = await cdp.evaluate(`(() => {
    const body = document.getElementById('modal-body');
    const text = body ? body.innerText : '';
    return {
      открыт: !document.getElementById('modal').classList.contains('hidden'),
      заголовок: document.getElementById('modal-title').textContent.trim(),
      поле_пути: !!document.getElementById('sdk-path'),
      кнопка_выбора: !!document.getElementById('sdk-pick'),
      кнопки_внизу: [...document.querySelectorAll('#modal-foot button')].map(b => b.textContent.trim()),
      упоминает_Mac: /macos|с Mac|from Mac|Volumes/i.test(text),
      текст: text.replace(/\\n+/g, ' | ').slice(0, 260),
    };
  })()`);

  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));

  console.log('\n=== диалог установки SDK ===\n');
  console.log(`  открыт              ${state.открыт}`);
  console.log(`  заголовок           ${state.заголовок}`);
  console.log(`  поле для пути       ${state.поле_пути}`);
  console.log(`  кнопка выбора файла ${state.кнопка_выбора}`);
  console.log(`  кнопки              ${state.кнопки_внизу.join(' / ')}`);
  console.log(`  упоминает Mac       ${state.упоминает_Mac}`);
  console.log(`  текст               ${state.текст}`);
  console.log(`  скриншот            ${SHOT}`);

  const problems = [];
  if (!state.открыт) problems.push('диалог не открылся');
  if (!state.поле_пути) problems.push('нет поля для пути к .xip');
  if (!state.кнопка_выбора) problems.push('нет кнопки выбора файла');
  if (state.упоминает_Mac) problems.push('осталось упоминание Mac');

  console.log(problems.length ? `\nПРОБЛЕМЫ: ${problems.join('; ')}` : '\nВСЁ В ПОРЯДКЕ');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('ошибка:', e.message); process.exit(1); });
