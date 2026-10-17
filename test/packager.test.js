'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const packager = require('../src/main/modules/packager');
const { readZipDirectory } = require('../src/main/modules/zip');
const h = require('./helpers');

const pythonOk = h.pythonAvailable();
const skip = pythonOk ? false : 'нужен Python с модулями plistlib/zipfile';

const BUNDLE_ID = 'com.fcode.testapp';

/**
 * Собрать синтетический .xcarchive, максимально похожий на настоящий:
 * бинарный Info.plist, Mach-O исполняемый файл, фреймворк с симлинком,
 * Swift-рантайм в Frameworks, SwiftSupport и dSYM в корне архива.
 */
function buildFixtureArchive(root) {
  const archive = path.join(root, 'TestApp.xcarchive');
  const app = path.join(archive, 'Products', 'Applications', 'TestApp.app');

  // Info.plist архива — XML (так делает Xcode).
  h.writeFile(
    path.join(archive, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Name</key><string>TestApp</string>
  <key>SchemeName</key><string>TestApp</string>
  <key>ArchiveVersion</key><integer>2</integer>
  <key>CreationDate</key><date>2024-03-01T12:00:00Z</date>
  <key>ApplicationProperties</key>
  <dict>
    <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
    <key>CFBundleShortVersionString</key><string>1.2.3</string>
    <key>CFBundleVersion</key><string>45</string>
  </dict>
</dict>
</plist>`,
  );

  // Info.plist приложения — бинарный, как в реальной сборке.
  h.writeBinaryPlistViaPython(path.join(app, 'Info.plist'), {
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleExecutable: 'TestApp',
    CFBundleName: 'TestApp',
    CFBundleDisplayName: 'Тестовое приложение',
    CFBundleShortVersionString: '1.2.3',
    CFBundleVersion: '45',
    CFBundlePackageType: 'APPL',
    MinimumOSVersion: '15.0',
    DTPlatformName: 'iphoneos',
    UIDeviceFamily: [1, 2],
  });

  h.writeFakeMachO(path.join(app, 'TestApp'), 4096);
  h.writeFile(path.join(app, 'Assets.car', ), Buffer.alloc(1024, 0x7a));
  h.writeFile(path.join(app, 'en.lproj', 'Localizable.strings'), 'hello = "Привет";\n');

  // Подпись и профиль — чтобы verifyIpa посчитал бандл пригодным к установке.
  h.writeFile(
    path.join(app, '_CodeSignature', 'CodeResources'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict/></plist>',
  );
  h.writeFile(
    path.join(app, 'embedded.mobileprovision'),
    Buffer.concat([
      Buffer.from([0x30, 0x82, 0x01, 0x00]), // псевдо-CMS обёртка
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>UUID</key><string>11111111-2222-3333-4444-555555555555</string>
  <key>Name</key><string>iOS Team Provisioning Profile: ${BUNDLE_ID}</string>
  <key>TeamName</key><string>FCode Test Team</string>
  <key>TeamIdentifier</key><array><string>ABCDE12345</string></array>
  <key>ExpirationDate</key><date>2030-01-01T00:00:00Z</date>
  <key>Platform</key><array><string>iOS</string></array>
  <key>Entitlements</key>
  <dict>
    <key>application-identifier</key><string>ABCDE12345.${BUNDLE_ID}</string>
    <key>get-task-allow</key><true/>
  </dict>
</dict>
</plist>`,
        'utf8',
      ),
    ]),
  );

  // Swift-рантайм лежит прямо в Frameworks (как в реальном бандле).
  h.writeFakeMachO(path.join(app, 'Frameworks', 'libswiftCore.dylib'), 2048);
  h.writeFakeMachO(path.join(app, 'Frameworks', 'libswiftFoundation.dylib'), 2048);

  // Свой фреймворк с версионированной структурой и симлинком Current -> A.
  h.writeFakeMachO(
    path.join(app, 'Frameworks', 'MyLib.framework', 'Versions', 'A', 'MyLib'),
    3072,
  );
  h.writeFile(
    path.join(app, 'Frameworks', 'MyLib.framework', 'Versions', 'A', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>',
  );

  let symlinkSupported = true;
  const currentLink = path.join(app, 'Frameworks', 'MyLib.framework', 'Versions', 'Current');
  try {
    fs.symlinkSync('A', currentLink, 'dir');
  } catch {
    symlinkSupported = false;
  }

  // SwiftSupport и dSYMs — в корне архива, а не внутри бандла.
  h.writeFakeMachO(path.join(archive, 'SwiftSupport', 'iphoneos', 'libswiftCore.dylib'), 2048);
  h.writeFakeMachO(
    path.join(archive, 'SwiftSupport', 'iphoneos', 'libswiftFoundation.dylib'),
    2048,
  );
  h.writeFile(
    path.join(archive, 'dSYMs', 'TestApp.app.dSYM', 'Contents', 'Resources', 'DWARF', 'TestApp'),
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x01, 0x02]),
  );

  return { archive, app, symlinkSupported };
}

test('разбор .xcarchive: находит .app, читает бинарный Info.plist и SwiftSupport', { skip }, () => {
  const dir = h.makeTempDir();
  try {
    const { archive } = buildFixtureArchive(dir);
    const info = packager.inspectArchive(archive);

    assert.strictEqual(path.basename(info.appPath), 'TestApp.app');
    assert.strictEqual(info.bundle.bundleId, BUNDLE_ID);
    assert.strictEqual(info.bundle.executable, 'TestApp');
    assert.strictEqual(info.bundle.shortVersion, '1.2.3');
    assert.strictEqual(info.bundle.buildVersion, '45');
    assert.strictEqual(info.bundle.minimumOSVersion, '15.0');
    assert.strictEqual(info.bundle.plistFormat, 'binary');
    assert.strictEqual(info.bundle.isSigned, true);
    assert.strictEqual(info.bundle.hasProvisioningProfile, true);
    assert.strictEqual(info.bundle.profile.teamId, 'ABCDE12345');
    assert.strictEqual(info.bundle.profile.daysLeft > 0, true);
    assert.deepStrictEqual(info.bundle.issues, []);

    assert.strictEqual(info.archiveSummary.scheme, 'TestApp');
    assert.deepStrictEqual(info.swiftDylibs.sort(), [
      'libswiftCore.dylib',
      'libswiftFoundation.dylib',
    ]);
    assert.deepStrictEqual(info.dsyms, ['TestApp.app.dSYM']);
  } finally {
    h.rmrf(dir);
  }
});

test('development-сборка: Payload, права 0755 у Mach-O, 0644 у данных', { skip }, async () => {
  const dir = h.makeTempDir();
  try {
    const { archive } = buildFixtureArchive(dir);
    const ipa = path.join(dir, 'out', 'TestApp.ipa');

    const result = await packager.buildIpa({ appPath: archive, outputPath: ipa, mode: 'development' });

    assert.strictEqual(result.bundle.bundleId, BUNDLE_ID);
    assert.strictEqual(result.mode, 'development');
    assert.strictEqual(fs.existsSync(ipa), true);
    assert.strictEqual(fs.existsSync(`${ipa}.part`), false, 'временный файл должен быть переименован');

    // Наш собственный разбор.
    const ours = readZipDirectory(ipa);
    const byName = new Map(ours.map((e) => [e.name, e]));
    assert.strictEqual(byName.get('Payload/TestApp.app/TestApp').mode & 0o777, 0o755);
    assert.strictEqual(byName.get('Payload/TestApp.app/Assets.car').mode & 0o777, 0o644);
    assert.strictEqual(byName.get('Payload/TestApp.app/').mode & 0o777, 0o755);
    assert.strictEqual(byName.get('Payload/').isDirectory, true);

    // Симлинк обязан остаться симлинком, иначе фреймворк не загрузится.
    const link = byName.get('Payload/TestApp.app/Frameworks/MyLib.framework/Versions/Current');
    if (link) {
      assert.strictEqual(link.isSymlink, true, 'Current должен быть symlink-записью');
    }

    // Независимая проверка через Python: права реально в архиве, CRC целы.
    const viaPython = h.inspectIpaViaPython(ipa);
    const pyByName = new Map(viaPython.map((e) => [e.name, e]));
    assert.strictEqual(
      pyByName.get('Payload/TestApp.app/TestApp').mode & 0o777,
      0o755,
      'Python должен видеть исполняемый бит — иначе .ipa не установится на устройство',
    );
    assert.strictEqual(pyByName.get('Payload/TestApp.app/Assets.car').mode & 0o777, 0o644);
    assert.strictEqual(pyByName.get('Payload/TestApp.app/Frameworks/libswiftCore.dylib').mode & 0o777, 0o755);

    assert.strictEqual(h.testZipViaPython(ipa), 'OK', 'CRC всех записей должен сходиться');

    // Байтовое сравнение содержимого: распаковываем Python-ом и сверяем с исходником.
    const extracted = h.extractEntryViaPython(
      ipa,
      'Payload/TestApp.app/TestApp',
      path.join(dir, 'extracted-TestApp'),
    );
    assert.deepStrictEqual(extracted, fs.readFileSync(path.join(dir, 'TestApp.xcarchive', 'Products', 'Applications', 'TestApp.app', 'TestApp')));

    const extractedPlist = h.extractEntryViaPython(
      ipa,
      'Payload/TestApp.app/Info.plist',
      path.join(dir, 'extracted-Info.plist'),
    );
    assert.deepStrictEqual(
      extractedPlist,
      fs.readFileSync(path.join(dir, 'TestApp.xcarchive', 'Products', 'Applications', 'TestApp.app', 'Info.plist')),
      'бинарный Info.plist должен переноситься байт в байт',
    );
  } finally {
    h.rmrf(dir);
  }
});

test('verifyIpa подтверждает корректный .ipa и объясняет проблемы', { skip }, async () => {
  const dir = h.makeTempDir();
  try {
    const { archive } = buildFixtureArchive(dir);
    const ipa = path.join(dir, 'verify.ipa');
    await packager.buildIpa({ appPath: archive, outputPath: ipa });

    const report = packager.verifyIpa(ipa);
    assert.strictEqual(report.ok, true, `ожидались проблемы: ${report.issues.join('; ')}`);
    assert.strictEqual(report.appRoot, 'Payload/TestApp.app');
    assert.strictEqual(report.issues.length, 0);
  } finally {
    h.rmrf(dir);
  }
});

test('appstore-сборка: Swift-рантайм вынесен в SwiftSupport, символы по желанию', { skip }, async () => {
  const dir = h.makeTempDir();
  try {
    const { archive } = buildFixtureArchive(dir);
    const ipa = path.join(dir, 'appstore.ipa');

    await packager.buildIpa({
      appPath: archive,
      outputPath: ipa,
      mode: 'appstore',
      includeSymbols: true,
    });

    const names = new Set(readZipDirectory(ipa).map((e) => e.name));

    assert.strictEqual(names.has('SwiftSupport/iphoneos/libswiftCore.dylib'), true);
    assert.strictEqual(names.has('SwiftSupport/iphoneos/libswiftFoundation.dylib'), true);
    assert.strictEqual(
      names.has('Payload/TestApp.app/Frameworks/libswiftCore.dylib'),
      false,
      'в режиме App Store Swift-рантайм не должен оставаться внутри бандла',
    );
    assert.strictEqual(
      names.has('Payload/TestApp.app/Frameworks/MyLib.framework/Versions/A/MyLib'),
      true,
      'пользовательский фреймворк обязан остаться в бандле',
    );
    assert.strictEqual(names.has('Symbols/TestApp.app.dSYM/Contents/Resources/DWARF/TestApp'), true);
    assert.strictEqual(names.has('Payload/TestApp.app/Info.plist'), true);
  } finally {
    h.rmrf(dir);
  }
});

test('iTunesMetadata.plist попадает в архив при запросе', { skip }, async () => {
  const dir = h.makeTempDir();
  try {
    const { archive } = buildFixtureArchive(dir);
    const ipa = path.join(dir, 'meta.ipa');

    await packager.buildIpa({
      appPath: archive,
      outputPath: ipa,
      iTunesMetadata: { itemName: 'TestApp', bundleVersion: '45' },
    });

    const entry = readZipDirectory(ipa).find((e) => e.name === 'iTunesMetadata.plist');
    assert.ok(entry, 'iTunesMetadata.plist должен быть в архиве');

    const xml = h.extractEntryViaPython(ipa, 'iTunesMetadata.plist', path.join(dir, 'meta.plist'));
    assert.match(xml.toString('utf8'), /<key>itemName<\/key>\s*<string>TestApp<\/string>/);
  } finally {
    h.rmrf(dir);
  }
});

test('упаковка принимает .app напрямую, без .xcarchive', { skip }, async () => {
  const dir = h.makeTempDir();
  try {
    const { app } = buildFixtureArchive(dir);
    const ipa = path.join(dir, 'direct.ipa');

    await packager.buildIpa({ appPath: app, outputPath: ipa });

    const names = new Set(readZipDirectory(ipa).map((e) => e.name));
    assert.strictEqual(names.has('Payload/TestApp.app/TestApp'), true);
    assert.strictEqual(names.has('SwiftSupport/iphoneos/libswiftCore.dylib'), false);
  } finally {
    h.rmrf(dir);
  }
});

test('понятные ошибки на некорректном входе', () => {
  assert.throws(() => packager.resolveAppFromArchive('D:/не/существует/x.xcarchive'), /not found/i);

  const dir = h.makeTempDir();
  try {
    const fake = path.join(dir, 'Broken.xcarchive');
    fs.mkdirSync(fake, { recursive: true });
    assert.throws(() => packager.resolveAppFromArchive(fake), /Products\/Applications/);

    const notArchive = path.join(dir, 'file.txt');
    fs.writeFileSync(notArchive, 'x');
    assert.throws(() => packager.resolveAppFromArchive(notArchive), /directory/i);
  } finally {
    h.rmrf(dir);
  }
});

test('isMachO распознаёт сигнатуры Mach-O и не путает их с данными', () => {
  const dir = h.makeTempDir();
  try {
    const macho = h.writeFakeMachO(path.join(dir, 'binary'), 16);
    const data = h.writeFile(path.join(dir, 'data.bin'), Buffer.from('обычный текст'));

    assert.strictEqual(packager.isMachO(macho), true);
    assert.strictEqual(packager.isMachO(data), false);
    assert.strictEqual(packager.isMachO(path.join(dir, 'нет-файла')), false);
  } finally {
    h.rmrf(dir);
  }
});

test('isSwiftRuntime отличает рантайм Swift от пользовательских библиотек', () => {
  assert.strictEqual(packager.isSwiftRuntime('libswiftCore.dylib'), true);
  assert.strictEqual(packager.isSwiftRuntime('libswift_Concurrency.dylib'), true);
  assert.strictEqual(packager.isSwiftRuntime('libswiftFoundation.dylib'), true);
  assert.strictEqual(packager.isSwiftRuntime('MyLib.dylib'), false);
  assert.strictEqual(packager.isSwiftRuntime('libswiftCore.dylib.bak'), false);
});
