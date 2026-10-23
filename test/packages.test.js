'use strict';
/*
 * Проверки работы с зависимостями SwiftPM.
 *
 * Package.swift — код, поэтому проверяем не только «прочиталось», но и то, что
 * после правки файл остаётся синтаксически целым и не теряет чужие строки.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packages = require('../src/main/modules/packages');

const MANIFEST = `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Demo",
    platforms: [
        .iOS(.v17),
    ],
    products: [
        .library(name: "Demo", targets: ["Demo"]),
    ],
    dependencies: [
        .package(url: "https://github.com/mhdhejazi/Dynamic", from: "1.2.0"),
    ],
    targets: [
        .target(
            name: "Demo",
            dependencies: [
                .product(name: "Dynamic", package: "Dynamic"),
            ],
            path: "Sources/Demo"
        ),
    ]
)
`;

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-pkg-'));
  fs.writeFileSync(path.join(root, 'Package.swift'), MANIFEST, 'utf8');
  return root;
}

test('читает имя пакета и зависимости', () => {
  const root = makeProject();
  const result = packages.read(root);

  assert.strictEqual(result.exists, true);
  assert.strictEqual(result.name, 'Demo');
  assert.strictEqual(result.packages.length, 1);
  assert.strictEqual(result.packages[0].url, 'https://github.com/mhdhejazi/Dynamic');
  assert.strictEqual(result.packages[0].name, 'Dynamic');
  assert.deepStrictEqual(result.packages[0].requirement, { kind: 'from', value: '1.2.0' });
  assert.deepStrictEqual(result.products, [{ name: 'Dynamic', package: 'Dynamic' }]);
});

test('проект без Package.swift не считается ошибкой', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-pkg-'));
  const result = packages.read(root);
  assert.strictEqual(result.exists, false);
  assert.deepStrictEqual(result.packages, []);
});

test('добавляет зависимость и продукт к цели', () => {
  const root = makeProject();
  const result = packages.add(root, {
    url: 'https://github.com/apple/swift-collections',
    version: '1.1.0',
  });

  assert.strictEqual(result.packages.length, 2);
  const added = result.packages.find((pkg) => pkg.name === 'swift-collections');
  assert.ok(added, 'пакет не появился в списке');
  assert.deepStrictEqual(added.requirement, { kind: 'from', value: '1.1.0' });

  const text = fs.readFileSync(path.join(root, 'Package.swift'), 'utf8');
  assert.match(text, /\.package\(url: "https:\/\/github\.com\/apple\/swift-collections", \.from\("1\.1\.0"\)\)/);
  assert.match(text, /\.product\(name: "swift-collections", package: "swift-collections"\)/);
  assert.strictEqual(packages.checkSyntax(text), null);
});

test('добавляет зависимость по ветке', () => {
  const root = makeProject();
  packages.add(root, { url: 'https://github.com/user/repo.git', kind: 'branch', version: 'main' });

  const text = fs.readFileSync(path.join(root, 'Package.swift'), 'utf8');
  assert.match(text, /\.branch\("main"\)/);
  assert.strictEqual(packages.checkSyntax(text), null);
});

test('не добавляет один и тот же пакет дважды', () => {
  const root = makeProject();
  assert.throws(
    () => packages.add(root, { url: 'https://github.com/mhdhejazi/Dynamic', version: '2.0.0' }),
    /уже подключён/,
  );
});

test('удаляет пакет вместе с его продуктом', () => {
  const root = makeProject();
  const result = packages.remove(root, { url: 'https://github.com/mhdhejazi/Dynamic' });

  assert.deepStrictEqual(result.packages, []);
  assert.deepStrictEqual(result.products, []);

  const text = fs.readFileSync(path.join(root, 'Package.swift'), 'utf8');
  assert.doesNotMatch(text, /mhdhejazi/);
  assert.doesNotMatch(text, /product\(name: "Dynamic"/);
  assert.strictEqual(packages.checkSyntax(text), null);

  // Чужие строки остаются на месте.
  assert.match(text, /name: "Demo"/);
  assert.match(text, /path: "Sources\/Demo"/);
});

test('делает резервную копию перед первой правкой', () => {
  const root = makeProject();
  packages.add(root, { url: 'https://github.com/a/b', version: '1.0.0' });

  const backup = path.join(root, 'Package.swift.bak');
  assert.ok(fs.existsSync(backup), 'нет резервной копии');
  assert.strictEqual(fs.readFileSync(backup, 'utf8'), MANIFEST);
});

test('после добавления и удаления файл возвращается к исходному виду', () => {
  const root = makeProject();
  packages.add(root, { url: 'https://github.com/a/b', version: '1.0.0' });
  packages.remove(root, { url: 'https://github.com/a/b' });

  const text = fs.readFileSync(path.join(root, 'Package.swift'), 'utf8');
  assert.doesNotMatch(text, /github\.com\/a\/b/);
  assert.strictEqual(packages.checkSyntax(text), null);
});

test('понимает разные виды требований к версии', () => {
  assert.deepStrictEqual(packages.versionRequirement('url: "u", from: "1.2.3"'), { kind: 'from', value: '1.2.3' });
  assert.deepStrictEqual(packages.versionRequirement('url: "u", exact: "2.0.0"'), { kind: 'exact', value: '2.0.0' });
  assert.deepStrictEqual(packages.versionRequirement('url: "u", .upToNextMajor(from: "3.1.0")'), { kind: 'upToNextMajor', value: '3.1.0' });
  assert.deepStrictEqual(packages.versionRequirement('url: "u", revision: "abc123"'), { kind: 'revision', value: 'abc123' });
});

test('имя пакета берётся из адреса', () => {
  assert.strictEqual(packages.nameFromUrl('https://github.com/apple/swift-collections'), 'swift-collections');
  assert.strictEqual(packages.nameFromUrl('https://github.com/user/repo.git'), 'repo');
  assert.strictEqual(packages.nameFromUrl('https://github.com/user/repo/'), 'repo');
});

test('ловит сломанные скобки и незакрытую строку', () => {
  assert.strictEqual(packages.checkSyntax('let x = [1, 2'), '[ не закрыт');
  assert.strictEqual(packages.checkSyntax('let package = Package(\n  name: "Demo"\n'), '( не закрыт');
  assert.strictEqual(packages.checkSyntax('let x = "не закрытая строка'), 'не закрыта кавычка');
  assert.strictEqual(packages.checkSyntax('let x = [1, 2]'), null);
});
