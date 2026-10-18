// Проверяем, что приходит из checkInside и почему triple пустые.
const { execFileSync } = require('child_process');
const wslRunner = require('../src/main/modules/wsl-exec');

const script = [
  'echo "###swift"; (swift --version 2>&1 | head -2) || echo "нет"',
  'echo "###sdk"; (swift sdk list 2>&1) || echo "нет"',
  'echo "###sdkinfo"; (for f in "$HOME"/.swiftpm/swift-sdks/*.artifactbundle/info.json; do cat "$f"; break; done) 2>/dev/null || echo "нет"',
  'echo "###sdktargets"; (for f in "$HOME"/.swiftpm/swift-sdks/*.artifactbundle/swift-sdk.json; do cat "$f"; break; done) 2>/dev/null || echo "нет"',
].join('\n');

const encoded = wslRunner.encodeScript(script);
console.log('команда (первые 80):', encoded.slice(0, 80));

const out = execFileSync('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', encoded], {
  encoding: 'utf8',
  env: { ...process.env, WSL_UTF8: '1' },
  timeout: 120000,
});

console.log('');
console.log('=== маркеры и данные ===');
let section = null;
const data = {};
for (const line of out.split('\n')) {
  const m = /^###(\w+)$/.exec(line.trim());
  if (m) { section = m[1]; data[section] = []; continue; }
  if (section) data[section].push(line);
}

for (const key of Object.keys(data)) {
  const text = data[key].join('\n').trim();
  console.log(`${key}: ${text.length} символов, начало: ${JSON.stringify(text.slice(0, 60))}`);
}
