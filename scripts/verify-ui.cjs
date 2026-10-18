// Проверка интерфейса: вкладка «Requirements», версия 0.0.2, кнопка конвертации.
const http = require('http');
const PORT = Number(process.argv[2] || 9222);

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
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
    function send(obj) {
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
          call: (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); send({ id, method, params: params || {} }); }),
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

  const rows = {};
  const check = async (label, expr) => {
    rows[label] = await cdp.evaluate(expr);
  };

  await check('вкладка «Linux Build»', `document.getElementById('btn-xtool')?.textContent.trim()`);
  await check('кнопка Convert', `!!document.getElementById('btn-convert')`);
  await check('версия', `window.__fcode.state.appInfo?.version`);
  await check('имя', `window.__fcode.state.appInfo?.name`);

  // Открываем панель требований и смотрим, что она работает.
  await cdp.evaluate(`document.getElementById('btn-xtool')?.click()`);
  await sleep(2500);
  await check('панель открылась', `!document.getElementById('linux-panel')?.classList.contains('hidden')`);
  await check('заголовок панели', `document.querySelector('#linux-panel .linux-title')?.textContent.trim()`);

  // Проверки требований через API — главное, что нам нужно.
  const checkResult = await cdp.evaluate(`(async () => {
    const r = await window.fcode.requirements.check();
    return r.rows.map(x => ({ id: x.id, title: x.title, ok: x.ok, found: x.found, action: x.action || null }));
  })()`);

  console.log('\n=== интерфейс ===\n');
  for (const [k, v] of Object.entries(rows)) {
    console.log(`  ${k.padEnd(22)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }

  console.log('\n=== требования ===\n');
  if (Array.isArray(checkResult)) {
    for (const row of checkResult) {
      const mark = row.ok ? 'OK  ' : 'НЕТ ';
      console.log(`  ${mark} ${row.id.padEnd(16)} ${String(row.found || '—').slice(0, 46)}`);
    }
    const host = checkResult.find((r) => r.id === 'ios-sdk-host');
    const space = checkResult.find((r) => r.id === 'wsl-space');
    console.log('');
    console.log(`  строка про triple SDK: ${host ? (host.ok ? 'в порядке' : 'требует починки') : 'НЕ ПОКАЗАНА'}`);
    console.log(`  строка про место:      ${space ? space.found : 'НЕ ПОКАЗАНА'}`);
  } else {
    console.log('  не удалось получить', JSON.stringify(checkResult));
  }

  process.exit(0);
})().catch((e) => { console.error('ошибка:', e.message); process.exit(1); });
