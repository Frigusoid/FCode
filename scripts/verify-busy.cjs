// Проверка значка загрузки: маленький, в правом нижнем углу, не мешает кликам.
// Делает скриншот, чтобы увидеть результат глазами.
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.argv[2] || 9222);
const SHOT = process.argv[3] || path.join(__dirname, '..', 'busy-shot.png');

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

  // Показываем значок и снимаем мерки.
  const geom = await cdp.evaluate(`(() => {
    const overlay = document.getElementById('busy-overlay');
    overlay.classList.remove('hidden');
    const o = overlay.getBoundingClientRect();
    const img = document.getElementById('busy-image').getBoundingClientRect();
    const win = { w: innerWidth, h: innerHeight };
    const style = getComputedStyle(overlay);
    return {
      gif: Math.round(img.width) + 'x' + Math.round(img.height),
      overlay: { left: Math.round(o.left), top: Math.round(o.top), right: Math.round(o.right), bottom: Math.round(o.bottom) },
      window: win,
      pointerEvents: style.pointerEvents,
      background: style.backgroundColor,
      // Прилегает ли к правому нижнему углу
      cornerGapRight: Math.round(win.w - o.right),
      cornerGapBottom: Math.round(win.h - o.bottom),
    };
  })()`);

  await sleep(400);

  // Скриншот страницы.
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  const b64 = shot.result?.data;
  if (b64) fs.writeFileSync(SHOT, Buffer.from(b64, 'base64'));

  await cdp.evaluate(`document.getElementById('busy-overlay').classList.add('hidden')`);

  console.log('\n=== значок загрузки ===\n');
  console.log(`  размер значка        ${geom.gif}`);
  console.log(`  окно                 ${geom.window.w}x${geom.window.h}`);
  console.log(`  отступ от правого края  ${geom.cornerGapRight} px`);
  console.log(`  отступ от нижнего края  ${geom.cornerGapBottom} px`);
  console.log(`  перехват кликов      ${geom.pointerEvents}`);
  console.log(`  фон                  ${geom.background}`);
  console.log(`  скриншот             ${SHOT}`);

  const problems = [];
  if (geom.gif !== '28x28') problems.push(`размер ${geom.gif}, ожидался 28x28`);
  if (geom.pointerEvents !== 'none') problems.push('перехватывает клики');
  if (geom.cornerGapRight > 40 || geom.cornerGapBottom > 40) problems.push('не в углу');
  if (!/0\.55|0\.5/.test(geom.background)) problems.push('фон не полупрозрачный: ' + geom.background);

  console.log(problems.length ? `\nПРОБЛЕМЫ: ${problems.join('; ')}` : '\nВСЁ В ПОРЯДКЕ');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('ошибка:', e.message); process.exit(1); });
