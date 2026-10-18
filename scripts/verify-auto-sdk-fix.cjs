// Проверка: FCode сам чинит SDK при сборке, если triple цели пропал.
// Проект лежит на диске D:, потому что workspace.load принимает путь Windows.
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const path = require('path');

const PORT = Number(process.argv[2] || 9222);
const SDK = '$HOME/.swiftpm/swift-sdks/darwin.artifactbundle/swift-sdk.json';
const PROJECT = 'D:\\FCode-work\\sdkcheck';

function sh(script) {
  return execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'frigus', '--', 'bash', '-lc', script], {
    encoding: 'utf8',
    env: { ...process.env, WSL_UTF8: '1' },
    timeout: 300000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function targets() {
  return sh(
    `python3 -c "import json,os;d=json.load(open(os.path.expanduser('${SDK}')));print(','.join(sorted(d['targetTriples'])))"`,
  ).trim();
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

/** Макет приложения на диске Windows. */
function makeProject() {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROJECT, 'Sources', 'sdkcheck'), { recursive: true });

  fs.writeFileSync(
    path.join(PROJECT, 'Package.swift'),
    `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "sdkcheck",
    platforms: [.iOS(.v17)],
    products: [.library(name: "sdkcheck", targets: ["sdkcheck"])],
    targets: [.target(name: "sdkcheck")]
)
`,
    'utf8',
  );

  fs.writeFileSync(path.join(PROJECT, 'xtool.yml'), 'version: 1\nbundleID: com.example.sdkcheck\n', 'utf8');

  fs.writeFileSync(
    path.join(PROJECT, 'Sources', 'sdkcheck', 'Probe.swift'),
    `import SwiftUI

@main
struct ProbeApp: App {
    var body: some Scene {
        WindowGroup { Text("ok") }
    }
}
`,
    'utf8',
  );
}

(async () => {
  makeProject();
  console.log('проект создан:', PROJECT);

  console.log('\n=== triple цели до ломки ===');
  console.log(targets());

  sh(`python3 -c "
import json, os
p = os.path.expanduser('${SDK}')
d = json.load(open(p))
d['targetTriples'].pop('arm64-apple-ios', None)
json.dump(d, open(p, 'w'))
"`);
  console.log('\n=== после ломки ===');
  console.log(targets());

  const page = (await getJson('/json/list')).find((t) => t.type === 'page');
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');

  const opened = await cdp.evaluate(`(async () => {
    const payload = await window.fcode.workspace.load(${JSON.stringify(PROJECT)});
    return payload && payload.path ? payload.path : null;
  })()`);
  console.log(`\nпроект открыт: ${opened}`);

  // Путь подставляем строкой, а не через шаблон PowerShell: его разбор съедал
  // подстановку и в скрипт попадал битый код.
  const projectLiteral = JSON.stringify(PROJECT);

  const result = await cdp.evaluate(`(async () => {
    try {
      const done = await window.fcode.xtool.build({
        projectPath: ${projectLiteral},
        distro: 'Ubuntu',
        action: 'dev',
      });
      return { ok: done && done.ok, code: done && done.code, tool: done && done.tool };
    } catch (error) {
      return { error: String(error && error.message) };
    }
  })()`);
  console.log('результат сборки:', JSON.stringify(result));

  // Консоль интерфейса — туда пишется журнал сборки.
  const log = await cdp.evaluate(`document.getElementById('console-body')?.innerText || ''`);

  console.log('\n=== журнал (первые 1000 символов) ===');
  console.log(String(log).slice(0, 1000));

  console.log('\n=== triple цели после сборки ===');
  const after = targets();
  console.log(after);

  const repaired = after.split(',').includes('arm64-apple-ios');
  const targetBack = repaired;
  const noSdkError = !/No Swift SDK found/.test(String(log));
  const buildOk = Boolean(result && result.ok);

  console.log('');
  console.log(`  FCode сам поправил SDK:   ${repaired ? 'ДА' : 'нет'}`);
  console.log(`  triple цели восстановлен: ${targetBack ? 'ДА' : 'нет'}`);
  console.log(`  ошибки поиска SDK нет:    ${noSdkError ? 'ДА' : 'НЕТ'}`);
  console.log(`  сборка прошла:            ${buildOk ? 'ДА' : 'НЕТ'}`);

  process.exit(repaired && noSdkError && buildOk ? 0 : 1);
})().catch((error) => {
  console.error('ошибка:', error.message);
  process.exit(1);
});
