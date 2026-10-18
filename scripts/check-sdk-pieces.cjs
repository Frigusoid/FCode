// Ищем, на каком шаге ломается однострочный скрипт.
const { execFileSync } = require('child_process');

const pieces = [
  'echo "###a"; ls -d "$HOME"/.swiftpm/swift-sdks/*.artifactbundle 2>&1',
  'echo "###b"; ls -d "$HOME"/.swiftpm/swift-sdks/*.artifactbundle/info.json 2>&1',
  'echo "###c"; for f in "$HOME"/.swiftpm/swift-sdks/*.artifactbundle/info.json; do cat "$f"; break; done',
  'echo "###d"; cat "$HOME/.swiftpm/swift-sdks/darwin.artifactbundle/info.json"',
];

for (const piece of pieces) {
  try {
    const out = execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'frigus', '--', 'bash', '-lc', piece], {
      encoding: 'utf8',
      env: { ...process.env, WSL_UTF8: '1' },
      timeout: 60000,
    });
    const first = out.split('\n').slice(0, 3).join(' | ');
    console.log(`${piece.slice(0, 28).padEnd(30)} → ${first.slice(0, 120)}`);
  } catch (error) {
    console.log(`${piece.slice(0, 28).padEnd(30)} → ОШИБКА: ${String(error.message).slice(0, 80)}`);
  }
}

// И тот же набор, но склеенный через '; '
const joined = pieces.join('; ');
try {
  const out = execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'frigus', '--', 'bash', '-lc', joined], {
    encoding: 'utf8',
    env: { ...process.env, WSL_UTF8: '1' },
    timeout: 60000,
  });
  console.log('\n=== склеенный вариант ===');
  console.log(out.slice(0, 600));
} catch (error) {
  console.log('\nсклеенный упал:', error.message);
}
