// Открывает файл проекта, включает предпросмотр и снимает результат.
const fs = require('fs');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const path = require('path');

const PORT = Number(process.argv[2] || 9222);
const FILE = process.argv[3] || 'D:\\FCode-work\\icontest\\Sources\\icontest\\App.swift';
const SHOT = process.argv[4] || path.join(__dirname, '..', 'D:\\FCode-work\\preview-shot.png');

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

  // Открываем проект и файл через тот же путь, что и интерфейс.
  await cdp.evaluate(`window.fcode.workspace.load(${JSON.stringify(path.dirname(path.dirname(path.dirname(FILE))))})`);
  await sleep(1500);

  const opened = await cdp.evaluate(`(async () => {
    const tree = await window.fcode.file.read(${JSON.stringify(FILE)});
    return Boolean(tree);
  })()`);

  // Вставляем файл прямо во вкладку: так проверяем отрисовку, не завися от дерева.
  const source = fs.readFileSync(FILE, 'utf8');
  const result = await cdp.evaluate(`(() => {
    const mod = window.__fcode;
    return typeof mod === 'object';
  })()`);

  await cdp.evaluate(`(() => {
    const text = ${JSON.stringify(source)};
    const tabs = window.__fcode.state.tabs;
    tabs.push({
      path: ${JSON.stringify(FILE)},
      name: 'App.swift',
      text,
      dirty: false,
      language: 'swift',
      editorState: null,
    });
    window.__fcode.state.activeTabPath = ${JSON.stringify(FILE)};
    const panel = document.getElementById('preview-panel');
    if (panel && panel.classList.contains('hidden')) document.getElementById('btn-preview').click();
    document.getElementById('btn-preview-refresh').click();
    return true;
  })()`);

  await sleep(1200);

  const info = await cdp.evaluate(`(() => {
    const panel = document.getElementById('preview-panel');
    const body = document.getElementById('preview-body');
    return {
      панельВидна: panel ? !panel.classList.contains('hidden') : false,
      элементов: body ? body.querySelectorAll('*').length : 0,
      текст: body ? body.innerText.replace(/\\n+/g, ' | ').slice(0, 200) : null,
      заметки: document.getElementById('preview-notes')?.textContent || '',
    };
  })()`);

  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  const target = 'D:\\FCode-work\\preview-shot.png';
  if (shot.result?.data) fs.writeFileSync(target, Buffer.from(shot.result.data, 'base64'));

  console.log('\n=== предпросмотр ===');
  console.log(`  панель видна : ${info.панельВидна}`);
  console.log(`  элементов    : ${info.элементов}`);
  console.log(`  заметки      : ${info.заметки || '—'}`);
  console.log(`  текст        : ${info.текст}`);
  console.log(`  снимок       : ${target}`);

  process.exit(info.элементов > 3 ? 0 : 1);
})().catch((e) => { console.error('ошибка:', e.message); process.exit(1); });
