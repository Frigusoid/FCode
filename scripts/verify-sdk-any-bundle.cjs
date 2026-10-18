// Проверка: починка SDK не зависит от имени бандла.
// Создаём рядом маленький бандл probe.artifactbundle без arm64-apple-ios
// и смотрим, что FCode исправит и его.
const { execFileSync } = require('child_process');
const requirements = require('../src/main/modules/requirements');

function sh(script) {
  return execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'frigus', '--', 'bash', '-lc', script], {
    encoding: 'utf8',
    env: { ...process.env, WSL_UTF8: '1' },
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const setup = `
set -e
B="$HOME/.swiftpm/swift-sdks/probe.artifactbundle"
rm -rf "$B"
mkdir -p "$B/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk"
mkdir -p "$B/Developer/Platforms/iPhoneOS.platform/Developer/usr/lib"
printf '%s' '{"schemaVersion":"1.0","artifacts":{"probe":{"type":"swiftSDK","version":"0.0.1","variants":[{"path":".","supportedTriples":["aarch64-unknown-linux-gnu"]}]}}}' > "$B/info.json"
printf '%s' '{"schemaVersion":"4.0","targetTriples":{"arm64-apple-ios-simulator":{"sdkRootPath":"Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk","swiftStaticResourcesPath":"x","swiftResourcesPath":"y"},"arm64-apple-macosx":{"sdkRootPath":"z"}}}' > "$B/swift-sdk.json"
echo создан
`;

const inspect = `
B="$HOME/.swiftpm/swift-sdks/probe.artifactbundle"
python3 -c "
import json
info=json.load(open('$B/info.json'))
sdk=json.load(open('$B/swift-sdk.json'))
host=[t for a in info['artifacts'].values() for v in a['variants'] for t in v['supportedTriples']]
print('host:', ','.join(host))
print('цели:', ','.join(sorted(sdk.get('targetTriples',{}))))
"
`;

const cleanup = `rm -rf "$HOME/.swiftpm/swift-sdks/probe.artifactbundle"; echo удалён`;

(async () => {
  try {
    console.log('создаю поддельный бандл probe.artifactbundle:', sh(setup).trim());

    console.log('\n=== до починки ===');
    console.log(sh(inspect).trim());

    console.log('\n=== починка FCode ===');
    const result = await requirements.repairSdkHostTriple({});
    const lines = String(result.output)
      .split('\n')
      .filter((line) => /^(bundle|host|targets|changes|problems|added_root)=/.test(line));
    console.log(lines.join('\n'));

    console.log('\n=== после починки ===');
    const after = sh(inspect).trim();
    console.log(after);

    const hostOk = /x86_64-pc-linux-gnu/.test(after);
    const targetOk = /arm64-apple-ios\b/.test(after) && !/^цели: .*?arm64-apple-ios,/.test('');

    console.log('');
    console.log(`  triple хоста добавлен: ${hostOk ? 'ДА' : 'нет'}`);
    console.log(`  arm64-apple-ios есть:  ${/arm64-apple-ios(,|$)/m.test(after.split('\n')[1] || '') ? 'ДА' : 'нет'}`);

    process.exit(0);
  } finally {
    try {
      sh(cleanup);
    } catch {
      /* уборка не критична */
    }
  }
})().catch((error) => {
  console.error('ошибка:', error.message);
  process.exit(1);
});
