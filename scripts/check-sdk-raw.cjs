// Повторяет сборку скрипта checkInside и показывает сырой вывод.
const { execFileSync } = require('child_process');

const script = [
  'echo "###swift"; (swift --version 2>&1 | head -2) || echo "нет"',
  'echo "###sdk"; (swift sdk list 2>&1) || echo "нет"',
  'echo "###sdkinfo"; (for f in "$HOME"/.swiftpm/swift-sdks/*.artifactbundle/info.json; do cat "$f"; break; done) 2>/dev/null || echo "нет"',
  'echo "###sdktargets"; (for f in "$HOME"/.swiftpm/swift-sdks/*.artifactbundle/swift-sdk.json; do cat "$f"; break; done) 2>/dev/null || echo "нет"',
].join('; ');

console.log('скрипт длиной', script.length, 'символов');
console.log('');

const out = execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'frigus', '--', 'bash', '-lc', script], {
  encoding: 'utf8',
  env: { ...process.env, WSL_UTF8: '1' },
  timeout: 120000,
});

console.log('=== сырой вывод ===');
console.log(out.slice(0, 800));

console.log('=== маркеры ===');
for (const line of out.split('\n')) {
  if (/^###/.test(line.trim())) console.log(' ', line.trim());
}
