// Проверка: в окне Requirements появляется кнопка починки SDK,
// а в журнале сборки видна строка проверки.
const { execFileSync } = require('child_process');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const PORT = Number(process.argv[2] || 9222);
const INFO = '$HOME/.swiftpm/swift-sdks/darwin.artifactbundle/info.json';

function sh(script) {
  return execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'frigus', '--', 'bash', '-lc', script], {
    encoding: 'utf8',
    env: { ...process.env, WSL_UTF8: '1' },
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

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
  // Ломаем: убираем host triple.
  sh(`python3 -c "
import json, os
p = os.path.expanduser('${INFO}')
d = json.load(open(p))
for a in d['artifacts'].values():
    for v in a['variants']:
        v['supportedTriples'] = [t for t in v.get('supportedTriples', []) if t != 'x86_64-pc-linux-gnu']
json.dump(d, open(p, 'w'), indent=4)
print('сломано')
"`);

  const page = (await getJson('/json/list')).find((t) => t.type === 'page');
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');

  // Открываем окно требований.
  await cdp.evaluate(`document.getElementById('btn-xtool')?.click()`);
  await sleep(1500);
  await cdp.evaluate(`document.getElementById('btn-linux-requirements')?.click()`);
  await sleep(3500);

  const modal = await cdp.evaluate(`(() => {
    const foot = document.getElementById('modal-foot');
    return {
      открыто: !document.getElementById('modal').classList.contains('hidden'),
      кнопки: foot ? [...foot.querySelectorAll('button')].map(b => b.textContent.trim()) : [],
      естьСтрокаПроSDK: /arm64-apple-ios|SDK для этой системы/.test(document.getElementById('modal-body')?.innerText || ''),
    };
  })()`);

  console.log('\n=== окно Requirements ===');
  console.log(`  открыто: ${modal.открыто}`);
  console.log(`  кнопки : ${modal.кнопки.join(' / ')}`);
  console.log(`  строка про SDK: ${modal.естьСтрокаПроSDK}`);

  const hasFixButton = modal.кнопки.some((label) => /Починить SDK|Fix SDK/i.test(label));
  console.log(`  кнопка починки: ${hasFixButton ? 'ЕСТЬ' : 'НЕТ'}`);

  // Закрываем и проверяем журнал сборки.
  await cdp.evaluate(`document.getElementById('modal-close')?.click()`);
  await sleep(800);

  await cdp.evaluate(`window.fcode.workspace.load('D:\\\\FCode-work\\\\sdkcheck')`);
  const buildResult = await cdp.evaluate(`(async () => {
    try {
      const done = await window.fcode.xtool.build({ projectPath: 'D:\\\\FCode-work\\\\sdkcheck', distro: 'Ubuntu', action: 'dev' });
      return { ok: done && done.ok };
    } catch (error) { return { error: String(error && error.message) }; }
  })()`);

  const logText = await cdp.evaluate(`document.getElementById('console-output')?.innerText || ''`);
  const hasLog = /iOS SDK проверен|iOS SDK checked|Поправил iOS SDK/i.test(logText);

  console.log('\n=== журнал сборки ===');
  console.log(`  сборка: ${JSON.stringify(buildResult)}`);
  console.log(`  строка про SDK в журнале: ${hasLog ? 'ЕСТЬ' : 'НЕТ'}`);
  if (hasLog) {
    const line = logText.split('\n').find((l) => /iOS SDK проверен|iOS SDK checked|Поправил/i.test(l));
    console.log(`  «${line.trim()}»`);
  }

  console.log('');
  console.log(`  кнопка в Requirements: ${hasFixButton ? 'ДА' : 'НЕТ'}`);
  console.log(`  запись в журнале:      ${hasLog ? 'ДА' : 'НЕТ'}`);
  process.exit(hasFixButton && hasLog ? 0 : 1);
})().catch((error) => {
  console.error('ошибка:', error.message);
  process.exit(1);
});
