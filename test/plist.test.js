'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const plist = require('../src/main/modules/plist');
const h = require('./helpers');

const pythonOk = h.pythonAvailable();
const skip = pythonOk ? false : 'нужен Python с модулями plistlib/zipfile';

test('бинарный plist разбирается так же, как эталонным plistlib', { skip }, () => {
  const dir = h.makeTempDir();
  try {
    const source = {
      CFBundleIdentifier: 'com.fcode.demo',
      CFBundleName: 'Демо-приложение',
      WithEmoji: 'FCode 🚀 тест',
      EmptyString: '',
      BoolTrue: true,
      BoolFalse: false,
      IntZero: 0,
      IntSmall: 42,
      IntNegative: -5,
      IntBig: 9007199254740991,
      IntNegativeBig: -9007199254740991,
      Real: 3.5,
      NegativeReal: -0.125,
      Blob: { __bytes__: Buffer.from([0, 1, 2, 253, 254, 255]).toString('base64') },
      When: { __date__: '2024-03-01T12:00:00' },
      List: [1, 'two', false, null],
      Nested: { a: { b: [{ c: 1 }, { d: 'вложенный' }] } },
      EmptyList: [],
      EmptyDict: {},
    };

    const target = path.join(dir, 'Info.plist');
    h.writeBinaryPlistViaPython(target, source);

    const raw = fs.readFileSync(target);
    assert.strictEqual(
      raw.toString('latin1', 0, 8),
      'bplist00',
      'фикстура обязана быть бинарным plist — иначе тест не проверяет то, что нужно',
    );

    const ours = plist.parseBinaryPlist(raw);
    assert.strictEqual(ours.format, 'binary');

    const expected = h.readPlistViaPython(target);
    assert.deepStrictEqual(h.normalizeOurs(ours.value), expected);
  } finally {
    h.rmrf(dir);
  }
});

test('бинарный plist: читается через readPlistFile по сигнатуре', { skip }, () => {
  const dir = h.makeTempDir();
  try {
    const target = path.join(dir, 'Info.plist');
    h.writeBinaryPlistViaPython(target, { CFBundleExecutable: 'TestApp', Num: 7 });

    assert.strictEqual(plist.isBinaryPlist(fs.readFileSync(target)), true);
    const parsed = plist.readPlistFile(target);
    assert.strictEqual(parsed.value.CFBundleExecutable, 'TestApp');
    assert.strictEqual(parsed.value.Num, 7);
  } finally {
    h.rmrf(dir);
  }
});

test('XML plist разбирается: строки, массивы, словари, вложенность, сущности', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- комментарий должен игнорироваться -->
  <key>Name</key>
  <string>Fish &amp; Chips &lt;тест&gt;</string>
  <key>Count</key>
  <integer>17</integer>
  <key>Ratio</key>
  <real>0.25</real>
  <key>Enabled</key>
  <true/>
  <key>Disabled</key>
  <false/>
  <key>Items</key>
  <array>
    <string>a</string>
    <integer>2</integer>
    <dict>
      <key>inner</key>
      <string>значение</string>
    </dict>
  </array>
  <key>Empty</key>
  <array/>
  <key>Blob</key>
  <data>AAEC/f7/</data>
</dict>
</plist>`;

  const { format, value } = plist.parseXmlPlist(xml);
  assert.strictEqual(format, 'xml');
  assert.strictEqual(value.Name, 'Fish & Chips <тест>');
  assert.strictEqual(value.Count, 17);
  assert.strictEqual(value.Ratio, 0.25);
  assert.strictEqual(value.Enabled, true);
  assert.strictEqual(value.Disabled, false);
  assert.deepStrictEqual(value.Items[2], { inner: 'значение' });
  assert.deepStrictEqual(value.Empty, []);
  assert.deepStrictEqual([...value.Blob], [0, 1, 2, 253, 254, 255]);
});

test('XML plist: запись и обратное чтение сохраняют структуру', () => {
  const dir = h.makeTempDir();
  try {
    const source = {
      CFBundleIdentifier: 'com.fcode.roundtrip',
      UIDeviceFamily: [1, 2],
      Flag: true,
      Num: 3,
      Nested: { deep: { deeper: 'да' } },
    };
    const target = path.join(dir, 'out.plist');
    plist.writeXmlPlistFile(target, source);

    const back = plist.readPlistFile(target).value;
    assert.deepStrictEqual(back, source);
  } finally {
    h.rmrf(dir);
  }
});

test('битый ввод не роняет парсеры, а даёт понятную ошибку', () => {
  assert.throws(() => plist.parseBinaryPlist(Buffer.from('не plist вообще')), /binary plist/i);
  assert.strictEqual(plist.isBinaryPlist(Buffer.from('bplist0')), false);
  assert.strictEqual(plist.parseXmlPlist('<plist version="1.0"><string>ок</string></plist>').value, 'ок');
});
