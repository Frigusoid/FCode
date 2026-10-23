// Проверяет окно зависимостей: список, добавление, удаление.
const fs = require('node:fs');
const path = require('node:path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const PORT = Number(process.argv[2] || 9222);
const PROJECT = process.argv[3] || 'D:\\FCode-work\\pkgcheck';
const OUT = process.argv[4] || 'D:\\FCode-work\\packages-dialog.png';

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

/** Проект-макет с одним пакетом. */
function makeProject() {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROJECT, 'Sources', 'Demo'), { recursive: true });
  fs.writeFileSync(
    path.join(PROJECT, 'Package.swift'),
    `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Demo",
    platforms: [.iOS(.v17)],
    products: [.library(name: "Demo", targets: ["Demo"])],
    dependencies: [
        .package(url: "https://github.com/mhdhejazi/Dynamic", from: "1.2.0"),
    ],
    targets: [
        .target(
            name: "Demo",
            dependencies: [
                .product(name: "Dynamic", package: "Dynamic"),
            ],
            path: "Sources/Demo"
        ),
    ]
)
`,
    'utf8',
  );
  fs.writeFileSync(path.join(PROJECT, 'Sources', 'Demo', 'App.swift'), 'import SwiftUI\n', 'utf8');
}

(async () => {
  makeProject();

  const page = (await getJson('/json/list')).find((t) => t.type === 'page');
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');

  await cdp.evaluate(`window.fcode.workspace.load(${JSON.stringify(PROJECT)})`);
  await sleep(2000);

  await cdp.evaluate(`document.getElementById('btn-packages').click()`);
  await sleep(1500);

  const initial = await cdp.evaluate(`(() => {
    const modal = document.getElementById('modal');
    return {
      открыто: modal ? !modal.classList.contains('hidden') : false,
      заголовок: document.getElementById('modal-title')?.textContent || '',
      пакеты: [...document.querySelectorAll('.pkg-row .pkg-main strong')].map((el) => el.textContent),
      версии: [...document.querySelectorAll('.pkg-row .pkg-version')].map((el) => el.textContent),
      кнопки: [...document.querySelectorAll('#modal-foot button')].map((b) => b.textContent.trim()),
    };
  })()`);

  console.log('');
  console.log('=== окно зависимостей ===');
  console.log(`  открыто : ${initial.открыто}`);
  console.log(`  заголовок: ${initial.заголовок}`);
  console.log(`  пакеты  : ${initial.пакеты.join(', ') || 'нет'}`);
  console.log(`  версии  : ${initial.версии.join(', ') || '—'}`);
  console.log(`  кнопки  : ${initial.кнопки.join(' / ')}`);

  // Добавляем пакет через поля.
  await cdp.evaluate(`(() => {
    document.getElementById('pkg-url').value = 'https://github.com/apple/swift-collections';
    document.getElementById('pkg-version').value = '1.1.0';
    document.getElementById('pkg-add').click();
    return true;
  })()`);
  await sleep(1200);

  const afterAdd = await cdp.evaluate(`(() => ({
    пакеты: [...document.querySelectorAll('.pkg-row .pkg-main strong')].map((el) => el.textContent),
    версии: [...document.querySelectorAll('.pkg-row .pkg-version')].map((el) => el.textContent),
  }))()`);

  const manifest = fs.readFileSync(path.join(PROJECT, 'Package.swift'), 'utf8');
  const onDisk = manifest.includes('swift-collections');

  console.log('');
  console.log('=== добавление ===');
  console.log(`  в списке : ${afterAdd.пакеты.join(', ')}`);
  console.log(`  версии   : ${afterAdd.версии.join(', ')}`);
  console.log(`  в файле  : ${onDisk ? 'записан' : 'НЕТ'}`);

  // Удаляем добавленный.
  await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.pkg-row')].find((r) => /swift-collections/.test(r.textContent));
    row.querySelector('.pkg-remove').click();
    return true;
  })()`);
  await sleep(1200);

  const afterRemove = await cdp.evaluate(`(() => ({
    пакеты: [...document.querySelectorAll('.pkg-row .pkg-main strong')].map((el) => el.textContent),
  }))()`);

  const removedFromDisk = !fs.readFileSync(path.join(PROJECT, 'Package.swift'), 'utf8').includes('swift-collections');

  console.log('');
  console.log('=== удаление ===');
  console.log(`  в списке : ${afterRemove.пакеты.join(', ') || 'пусто'}`);
  console.log(`  в файле  : ${removedFromDisk ? 'удалён' : 'остался'}`);

  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log('');
  console.log('снимок:', OUT);

  const ok = initial.открыто
    && initial.пакеты.includes('Dynamic')
    && onDisk
    && afterAdd.пакеты.includes('swift-collections')
    && removedFromDisk;

  console.log('');
  console.log(ok ? 'ЗАГРУЗЧИК РАБОТАЕТ' : 'ЕСТЬ ПРОБЛЕМЫ');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('ошибка:', e.message);
  process.exit(1);
});
