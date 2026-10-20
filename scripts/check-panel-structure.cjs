// Проверяет структуру панели требований: мало кнопок, разделы, шаги.
const fs = require('node:fs');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const PORT = Number(process.argv[2] || 9222);
const OUT = process.argv[3] || 'D:\\FCode-work\\requirements-panel.png';

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
  await cdp.call('Page.enable');

  await cdp.evaluate(`document.getElementById('btn-xtool').click()`);

  // Ждём, пока проверка Linux закончится и появятся шаги.
  let steps = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(2000);
    steps = await cdp.evaluate(`document.querySelectorAll('#linux-steps .linux-step').length`);
    if (steps > 0) break;
  }

  // Сворачиваем разделы: считаем то, что видно по умолчанию.
  await cdp.evaluate(`(() => {
    for (const link of document.querySelectorAll('.linux-links .link-btn[data-section]')) {
      const section = document.getElementById('linux-' + link.dataset.section);
      if (section && !section.classList.contains('hidden')) link.click();
    }
    return true;
  })()`);
  await sleep(400);

  const panel = await cdp.evaluate(`(() => {
    const root = document.getElementById('linux-panel');
    const visible = (el) => el && el.offsetParent !== null;
    const main = [...root.querySelectorAll('.linux-primary button')].filter(visible);
    return {
      шагов: document.querySelectorAll('#linux-steps .linux-step').length,
      главныхКнопок: main.length,
      подписи: main.map((b) => b.textContent.trim()),
      ссылок: document.querySelectorAll('.linux-links .link-btn').length,
      ссылки: [...document.querySelectorAll('.linux-links .link-btn')].map((b) => b.textContent.trim()),
      toolsЗакрыт: document.getElementById('linux-tools')?.classList.contains('hidden'),
      accountЗакрыт: document.getElementById('linux-account')?.classList.contains('hidden'),
    };
  })()`);

  console.log('\n=== панель требований ===');
  console.log(`  главных кнопок : ${panel.главныхКнопок} (${panel.подписи.join(' / ')})`);
  console.log(`  ссылок         : ${panel.ссылок} (${panel.ссылки.join(' / ')})`);
  console.log(`  разделы        : tools=${panel.toolsЗакрыт ? 'закрыт' : 'открыт'}, account=${panel.accountЗакрыт ? 'закрыт' : 'открыт'}`);
  console.log(`  шагов          : ${panel.шагов}`);

  await cdp.evaluate(`document.querySelector('.linux-links .link-btn[data-section="tools"]').click()`);
  await sleep(400);
  const opened = await cdp.evaluate(`(() => ({
    открыт: !document.getElementById('linux-tools').classList.contains('hidden'),
    кнопки: [...document.getElementById('linux-tools').querySelectorAll('button')].map((b) => b.textContent.trim()),
  }))()`);

  console.log(`  Tools раскрылся: ${opened.открыт} (${opened.кнопки.join(' / ')})`);

  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log(`  снимок: ${OUT}`);

  const ok = panel.главныхКнопок === 2
    && panel.ссылок === 4
    && panel.toolsЗакрыт === true
    && panel.accountЗакрыт === true
    && panel.шагов >= 5
    && opened.открыт;

  console.log(`\n${ok ? 'ПАНЕЛЬ В ПОРЯДКЕ' : 'ЕСТЬ ПРОБЛЕМЫ'}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('ошибка:', e.message);
  process.exit(1);
});
