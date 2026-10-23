// Проверяет кнопку «Restart WSL»: она есть, работает и WSL поднимается снова.
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { execFileSync } = require('node:child_process');

const PORT = Number(process.argv[2] || 9223);
const OUT = process.argv[3] || 'D:\\FCode-work\\restart-wsl.png';

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

  const before = await cdp.evaluate(`(() => {
    const btn = document.getElementById('btn-restart-wsl');
    return { есть: Boolean(btn), подпись: btn ? btn.textContent.trim() : null };
  })()`);

  console.log('');
  console.log('=== кнопка в консоли ===');
  console.log(`  есть   : ${before.есть}`);
  console.log(`  подпись: ${before.подпись}`);

  const started = Date.now();
  await cdp.evaluate(`document.getElementById('btn-restart-wsl').click()`);

  // Ждём строку в журнале.
  let logText = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(1000);
    logText = await cdp.evaluate(`document.getElementById('console-output')?.innerText || ''`);
    if (/WSL restarted|Could not restart/i.test(logText)) break;
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const lines = logText.split('\n').filter((line) => /WSL|restart/i.test(line)).slice(-4);

  console.log('');
  console.log('=== журнал ===');
  for (const line of lines) console.log('  ' + line.trim().slice(0, 110));
  console.log(`  время: ${seconds} с`);

  // WSL должен подняться сам при следующей команде.
  let wslOk = false;
  try {
    const probe = execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'frigus', '--', 'bash', '-lc', 'echo alive'], {
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, WSL_UTF8: '1' },
    });
    wslOk = /alive/.test(probe);
  } catch (error) {
    wslOk = false;
  }

  console.log('');
  console.log(`  WSL после перезапуска: ${wslOk ? 'работает' : 'НЕ ОТВЕЧАЕТ'}`);

  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) require('node:fs').writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log(`  снимок: ${OUT}`);

  const restarted = /WSL restarted/i.test(logText);
  console.log('');
  console.log(before.есть && restarted && wslOk ? 'КНОПКА РАБОТАЕТ' : 'ЕСТЬ ПРОБЛЕМЫ');
  process.exit(before.есть && restarted && wslOk ? 0 : 1);
})().catch((e) => {
  console.error('ошибка:', e.message);
  process.exit(1);
});
