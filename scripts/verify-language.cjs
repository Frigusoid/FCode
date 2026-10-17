// Проверка переключения языка так, как это делает пользователь:
// открыть «Настройки», найти #settings-lang, сменить значение, убедиться,
// что подписи интерфейса действительно поменялись.
const http = require('http');
const PORT = 9223;

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
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
      const payload = Buffer.from(JSON.stringify(obj));
      const len = payload.length;
      let header;
      if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
      else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
      const mask = crypto.randomBytes(4);
      const m = Buffer.from(payload);
      for (let i = 0; i < m.length; i++) m[i] ^= mask[i % 4];
      socket.write(Buffer.concat([header, mask, m]));
    }
    function frame(data) {
      const op = data[0] & 0x0f;
      let len = data[1] & 0x7f, off = 2;
      if (len === 126) { len = data.readUInt16BE(2); off = 4; }
      else if (len === 127) { len = Number(data.readBigUInt64BE(2)); off = 10; }
      if (op !== 1) return;
      try {
        const msg = JSON.parse(data.toString('utf8', off, off + len));
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
  const targets = await getJson('/json/list');
  const page = targets.find((t) => t.type === 'page');
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');

  const buildLabel = () => cdp.evaluate(`document.getElementById('btn-build')?.textContent.trim()`);
  const newProjLabel = () => cdp.evaluate(`document.getElementById('btn-new-project')?.textContent.trim()`);

  console.log('\n=== переключение языка ===\n');

  // Ставим английский как исходный.
  await cdp.evaluate(`window.__fcode && (async () => { await window.fcode.app.setLanguage('en'); })()`);
  await sleep(800);
  await cdp.evaluate(`location.reload()`);
  await sleep(3500);
  await cdp.call('Runtime.enable');

  const enBuild = await buildLabel();
  const enNew = await newProjLabel();
  console.log(`  английский:  build="${enBuild}"  new="${enNew}"`);

  // Открываем настройки и переключаем на русский через настоящий select.
  await cdp.evaluate(`document.getElementById('btn-settings')?.click()`);
  await sleep(2500);
  const selectFound = await cdp.evaluate(`!!document.getElementById('settings-lang')`);
  const options = await cdp.evaluate(`[...(document.getElementById('settings-lang')?.options || [])].map(o => o.value).join(',')`);
  console.log(`  найдено поле языка: ${selectFound}, варианты: ${options}`);

  await cdp.evaluate(`(() => {
    const s = document.getElementById('settings-lang');
    s.value = 'ru';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(2500);

  const ruBuildModal = await cdp.evaluate(`document.getElementById('btn-build')?.textContent.trim()`);

  // Закрываем настройки и смотрим подписи на главном экране.
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find(x => /close|закрыть|готово|ok|done/i.test(x.textContent));
    if (b) b.click();
  })()`);
  await sleep(1500);

  const ruBuild = await buildLabel();
  const ruNew = await newProjLabel();
  const langState = await cdp.evaluate(`window.__fcode.state.language`);
  console.log(`  русский:     build="${ruBuild}"  new="${ruNew}"  state=${langState}`);

  const problems = [];
  if (enBuild === ruBuild) problems.push('подпись кнопки сборки не изменилась');
  if (!ruBuild || !/[\u0400-\u04FF]/.test(String(ruBuild))) problems.push('в русском нет кириллицы');
  if (!selectFound) problems.push('поле языка не найдено в настройках');

  console.log(problems.length ? `\nПРОБЛЕМЫ: ${problems.join(', ')}` : '\nПЕРЕКЛЮЧЕНИЕ ЯЗЫКА РАБОТАЕТ');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('ошибка:', e.message); process.exit(1); });
