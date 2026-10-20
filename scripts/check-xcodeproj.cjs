// Проверка кнопки «.xcodeproj»: создаёт проект и разбирает его обратно.
const fs = require('node:fs');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const path = require('node:path');

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

(async () => {
  // Убираем прошлый результат, чтобы проверить именно создание.
  for (const entry of fs.readdirSync(PROJECT)) {
    if (entry.endsWith('.xcodeproj')) {
      fs.rmSync(path.join(PROJECT, entry), { recursive: true, force: true });
    }
  }

  const page = (await getJson('/json/list')).find((t) => t.type === 'page');
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');

  const result = await cdp.evaluate(`(async () => {
    try {
      return await window.fcode.xcode.makeProject({ projectPath: ${JSON.stringify(PROJECT)}, overwrite: true });
    } catch (error) {
      return { ok: false, error: String(error && error.message) };
    }
  })()`);

  console.log('\n=== создание .xcodeproj ===');
  console.log(JSON.stringify(result, null, 2));

  if (!result || !result.path) {
    console.log('\nНЕ СОЗДАН');
    process.exit(1);
  }

  // Независимая проверка: наш же парсер pbxproj.
  const xcode = require('../src/main/modules/xcode');
  const analysis = xcode.analyzeProject(PROJECT);

  console.log('');
  console.log('=== разбор обратно ===');
  console.log(`  имя проекта : ${analysis.projectName}`);
  console.log(`  цель        : ${analysis.target ? analysis.target.name : 'нет'}`);
  console.log(`  тип цели    : ${analysis.target ? analysis.target.kind : '—'}`);
  console.log(`  bundleId    : ${analysis.build.bundleId}`);
  console.log(`  iOS         : ${analysis.build.iosVersion}`);
  console.log(`  исходники   : ${analysis.sourceDir}`);

  const pbxproj = fs.readFileSync(path.join(result.path, 'project.pbxproj'), 'utf8');
  const checks = {
    'product-type.application': /com\.apple\.product-type\.application/.test(pbxproj),
    'синхронизированная группа': /fileSystemSynchronizedGroups/.test(pbxproj),
    'GENERATE_INFOPLIST_FILE': /GENERATE_INFOPLIST_FILE = YES/.test(pbxproj),
  };

  console.log('');
  for (const [label, ok] of Object.entries(checks)) {
    console.log(`  ${label.padEnd(26)} ${ok ? 'есть' : 'НЕТ'}`);
  }

  const good = analysis.target && analysis.target.kind === 'app'
    && Object.values(checks).every(Boolean);

  console.log(`\n${good ? 'ПРОЕКТ XCODE ГОТОВ' : 'ЕСТЬ ПРОБЛЕМЫ'}`);
  process.exit(good ? 0 : 1);
})().catch((e) => { console.error('ошибка:', e.message); process.exit(1); });
