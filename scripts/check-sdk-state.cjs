// Состояние SDK: какие цели объявлены и какие triple видит SwiftPM.
const { execFileSync } = require('child_process');

const script = `
B="$HOME/.swiftpm/swift-sdks/darwin.artifactbundle"
echo "=== файлы бандла ==="
ls -1 "$B" 2>/dev/null
echo ""
echo "=== цели в swift-sdk.json ==="
python3 -c "import json,os;d=json.load(open(os.path.expanduser('$HOME/.swiftpm/swift-sdks/darwin.artifactbundle/swift-sdk.json')));print(','.join(sorted(d.get('targetTriples',{}))))" 2>&1
echo ""
echo "=== triple хоста в info.json ==="
python3 -c "import json,os;d=json.load(open(os.path.expanduser('$HOME/.swiftpm/swift-sdks/darwin.artifactbundle/info.json')));print([t for a in d['artifacts'].values() for v in a['variants'] for t in v.get('supportedTriples',[])])" 2>&1
echo ""
echo "=== swift sdk list ==="
swift sdk list 2>&1
echo ""
echo "=== triple системы ==="
swift --version 2>&1 | tail -2
`;

const out = execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'frigus', '--', 'bash', '-lc', script], {
  encoding: 'utf8',
  env: { ...process.env, WSL_UTF8: '1' },
  timeout: 120000,
});

console.log(out);
