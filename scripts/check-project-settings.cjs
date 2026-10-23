// Проверяет окно настроек проекта и правку версии пакета.
const fs = require('node:fs');
const path = require('node:path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const PORT = Number(process.argv[2] || 9222);
const PROJECT = process.argv[3] || 'D:\\FCode-work\\pkgcheck';
const OUT = process.argv[4] || 'D:\\FCode-work\\project-settings.png';

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

  // xtool.yml нужен, иначе bundle id некуда писать.
  const configPath = path.join(PROJECT, 'xtool.yml');
  if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, 'version: 1\nbundleID: com.example.demo\n', 'utf8');

  await cdp.evaluate(`window.fcode.workspace.load(${JSON.stringify(PROJECT)})`);
  await sleep(2000);

  // --- настройки проекта ---
  await cdp.evaluate(`document.getElementById('btn-project-settings').click()`);
  await sleep(1200);

  const before = await cdp.evaluate(`(() => ({
    открыто: !document.getElementById('modal').classList.contains('hidden'),
    заголовок: document.getElementById('modal-title')?.textContent || '',
    имя: document.getElementById('set-name')?.value || '',
    bundle: document.getElementById('set-bundle')?.value || '',
    ios: document.getElementById('set-ios')?.value || '',
    кнопки: [...document.querySelectorAll('#modal-foot button')].map((b) => b.textContent.trim()),
  }))()`);

  console.log('');
  console.log('=== настройки проекта ===');
  console.log(`  открыто : ${before.открыто}, заголовок: ${before.заголовок}`);
  console.log(`  поля    : имя «${before.имя}», bundle «${before.bundle}», iOS «${before.ios}»`);
  console.log(`  кнопки  : ${before.кнопки.join(' / ')}`);

  // Меняем значения и сохраняем.
  await cdp.evaluate(`(() => {
    document.getElementById('set-name').value = 'RenamedDemo';
    document.getElementById('set-bundle').value = 'com.frigusoid.renamed';
    document.getElementById('set-ios').value = '16.0';
    document.querySelector('#modal-foot .tb-btn.primary').click();
    return true;
  })()`);
  await sleep(1500);

  const manifest = fs.readFileSync(path.join(PROJECT, 'Package.swift'), 'utf8');
  const config = fs.readFileSync(path.join(PROJECT, 'xtool.yml'), 'utf8');

  const nameOk = /name: "RenamedDemo"/.test(manifest);
  const iosOk = /\.iOS\(\.v16\.0\)/.test(manifest);
  const bundleOk = /bundleID: com\.frigusoid\.renamed/.test(config);

  console.log('');
  console.log('=== после сохранения ===');
  console.log(`  имя в Package.swift    : ${nameOk ? 'RenamedDemo' : 'не изменилось'}`);
  console.log(`  iOS в Package.swift    : ${iosOk ? '16.0' : 'не изменилось'}`);
  console.log(`  bundleID в xtool.yml   : ${bundleOk ? 'обновлён' : 'не изменился'}`);

  // --- версия пакета ---
  await cdp.evaluate(`document.getElementById('btn-packages').click()`);
  await sleep(1200);

  const rows = await cdp.evaluate(`(() => ({
    пакеты: [...document.querySelectorAll('.pkg-row .pkg-main strong')].map((el) => el.textContent),
    версии: [...document.querySelectorAll('.pkg-row .pkg-version-edit')].map((el) => el.textContent.trim()),
  }))()`);

  console.log('');
  console.log('=== окно зависимостей ===');
  console.log(`  пакеты : ${rows.пакеты.join(', ')}`);
  console.log(`  версии : ${rows.версии.join(', ')}`);

  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log('');
  console.log('снимок:', OUT);

  const ok = before.открыто && nameOk && iosOk && bundleOk && rows.пакеты.length > 0;
  console.log('');
  console.log(ok ? 'НАСТРОЙКИ РАБОТАЮТ' : 'ЕСТЬ ПРОБЛЕМЫ');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('ошибка:', e.message);
  process.exit(1);
});
