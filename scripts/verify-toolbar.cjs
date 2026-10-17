// Проверка панели инструментов: Archive слева, у Requirements нет пингвина.
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.argv[2] || 9222);
const SHOT = process.argv[3] || path.join(__dirname, '..', 'toolbar-shot.png');

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

(async () => {
  const page = (await getJson('/json/list')).find((t) => t.type === 'page');
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');

  const info = await cdp.evaluate(`(() => {
    const pos = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), text: el.textContent.trim().replace(/\\s+/g, ' ') };
    };
    const req = document.getElementById('btn-xtool');
    return {
      open: pos('btn-open'),
      save: pos('btn-save'),
      archive: pos('btn-pick-archive'),
      folder: pos('btn-pick-archive-folder'),
      scheme: pos('scheme-select'),
      build: pos('btn-build'),
      verify: pos('btn-verify'),
      requirements: req ? { left: Math.round(req.getBoundingClientRect().left), text: req.textContent.trim(), hasIcon: !!req.querySelector('.ico') } : null,
      windowWidth: innerWidth,
    };
  })()`);

  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));

  console.log('\n=== панель инструментов ===\n');
  for (const [k, v] of Object.entries(info)) {
    if (v && typeof v === 'object') console.log(`  ${k.padEnd(14)} x=${String(v.left).padStart(4)}  «${v.text || ''}»`);
    else console.log(`  ${k.padEnd(14)} ${v}`);
  }

  const problems = [];
  if (!info.archive) problems.push('кнопка Archive не найдена');
  if (!info.folder) problems.push('кнопка папки архива не найдена');
  if (info.archive && info.archive.left > info.windowWidth / 2) problems.push('Archive всё ещё справа');
  if (info.folder && info.folder.left > info.windowWidth / 2) problems.push('папка архива всё ещё справа');
  if (info.archive && info.build && info.archive.left > info.build.left) problems.push('Archive правее Build');
  if (info.requirements && info.requirements.hasIcon) problems.push('у Requirements остался значок');
  if (info.requirements && info.requirements.text !== 'Requirements') problems.push('подпись Requirements: ' + info.requirements.text);

  console.log(problems.length ? `\nПРОБЛЕМЫ: ${problems.join('; ')}` : '\nВСЁ В ПОРЯДКЕ');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('ошибка:', e.message); process.exit(1); });
