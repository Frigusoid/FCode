'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const distro = require('../src/main/modules/distro');

/** Небольшой срез настоящего ответа swift.org — достаточный для проверки логики. */
const FIXTURE = [
  {
    name: '5.10.1',
    tag: 'swift-5.10.1-RELEASE',
    platforms: [
      { name: 'Ubuntu 22.04', platform: 'Linux', archs: ['x86_64', 'aarch64'] },
      { name: 'Ubuntu 24.04', platform: 'Linux', archs: ['x86_64', 'aarch64'] },
    ],
  },
  {
    name: '6.1',
    tag: 'swift-6.1-RELEASE',
    platforms: [
      { name: 'Ubuntu 20.04', platform: 'Linux', archs: ['x86_64', 'aarch64'] },
      { name: 'Ubuntu 22.04', platform: 'Linux', archs: ['x86_64', 'aarch64'] },
      { name: 'Ubuntu 24.04', platform: 'Linux', archs: ['x86_64', 'aarch64'] },
    ],
  },
  {
    name: '6.1.3',
    tag: 'swift-6.1.3-RELEASE',
    platforms: [
      { name: 'Ubuntu 22.04', platform: 'Linux', archs: ['x86_64', 'aarch64'] },
      { name: 'Ubuntu 24.04', platform: 'Linux', archs: ['x86_64', 'aarch64'] },
    ],
  },
  {
    name: '6.4.1',
    tag: 'swift-6.4.1-RELEASE',
    platforms: [
      { name: 'Ubuntu 22.04', platform: 'Linux', archs: ['x86_64', 'aarch64'] },
      { name: 'Ubuntu 24.04', platform: 'Linux', archs: ['x86_64', 'aarch64'] },
      { name: 'Ubuntu 26.04', platform: 'Linux', archs: ['x86_64', 'aarch64'] },
    ],
  },
];

test('parseUbuntuName разбирает название платформы', () => {
  assert.deepStrictEqual(distro.parseUbuntuName('Ubuntu 24.04'), {
    major: 24,
    minor: 4,
    key: 2404,
    label: '24.04',
  });
  assert.strictEqual(distro.parseUbuntuName('Ubuntu 26.04').key, 2604);
  assert.strictEqual(distro.parseUbuntuName('Debian 12'), null);
  assert.strictEqual(distro.parseUbuntuName('Windows 10'), null);
});

test('buildSwiftUrl повторяет формат swift.org: каталог без точки, файл с точкой', () => {
  assert.strictEqual(
    distro.buildSwiftUrl('swift-6.1-RELEASE', { major: 24, minor: 4 }),
    'https://download.swift.org/swift-6.1-release/ubuntu2404/swift-6.1-RELEASE/swift-6.1-RELEASE-ubuntu24.04.tar.gz',
  );
  assert.strictEqual(
    distro.buildSwiftUrl('swift-6.4.1-RELEASE', { major: 26, minor: 4 }),
    'https://download.swift.org/swift-6.4.1-release/ubuntu2604/swift-6.4.1-RELEASE/swift-6.4.1-RELEASE-ubuntu26.04.tar.gz',
  );
  // 20.04 — младшая версия однозначная, ведущий ноль сохраняется
  assert.strictEqual(
    distro.buildSwiftUrl('swift-6.1-RELEASE', { major: 20, minor: 4 }),
    'https://download.swift.org/swift-6.1-release/ubuntu2004/swift-6.1-RELEASE/swift-6.1-RELEASE-ubuntu20.04.tar.gz',
  );
});

test('для точной версии Ubuntu берётся самая новая подходящая сборка', () => {
  const build = distro.pickSwiftBuild(FIXTURE, { versionId: '24.04' });
  assert.strictEqual(build.version, '6.4.1');
  assert.strictEqual(build.exact, true);
  assert.match(build.url, /ubuntu2404/);
});

test('для Ubuntu 26.04 берётся её собственная сборка', () => {
  const build = distro.pickSwiftBuild(FIXTURE, { versionId: '26.04' });
  assert.strictEqual(build.version, '6.4.1');
  assert.strictEqual(build.exact, true);
  assert.match(build.url, /ubuntu2604/);
});

test('незнакомая будущая версия Ubuntu получает сборку для более старой', () => {
  // Ubuntu 30.04 в списке релизов нет — алгоритм обязан не сдаться,
  // а взять самую новую сборку, которая гарантированно запустится.
  const build = distro.pickSwiftBuild(FIXTURE, { versionId: '30.04' });
  assert.ok(build, 'сборка должна быть найдена');
  assert.strictEqual(build.version, '6.4.1');
  assert.strictEqual(build.exact, false, 'точного совпадения нет — это должно быть видно');
  assert.match(build.url, /ubuntu2604/);
});

test('Ubuntu 21.10 (без своей сборки) откатывается на 20.04, а не на 22.04', () => {
  const build = distro.pickSwiftBuild(FIXTURE, { versionId: '21.10' });
  assert.strictEqual(build.version, '6.1');
  assert.strictEqual(build.platformName, 'Ubuntu 20.04');
  assert.strictEqual(build.exact, false);
});

test('учитывается архитектура', () => {
  const onlyArm = [
    {
      name: '6.4.1',
      tag: 'swift-6.4.1-RELEASE',
      platforms: [{ name: 'Ubuntu 24.04', platform: 'Linux', archs: ['aarch64'] }],
    },
  ];
  assert.strictEqual(distro.pickSwiftBuild(onlyArm, { versionId: '24.04', arch: 'x86_64' }), null);
  assert.ok(distro.pickSwiftBuild(onlyArm, { versionId: '24.04', arch: 'aarch64' }));
});

test('слишком старые релизы Swift игнорируются', () => {
  const build = distro.pickSwiftBuild(FIXTURE, { versionId: '24.04', minVersion: '6.0' });
  assert.strictEqual(build.version, '6.4.1');
  // 5.10.1 не должен попасть в выбор ни при каких условиях
  assert.notStrictEqual(build.version, '5.10.1');
});

test('если подходящих сборок нет, возвращается null, а не исключение', () => {
  assert.strictEqual(distro.pickSwiftBuild([], { versionId: '24.04' }), null);
  assert.strictEqual(distro.pickSwiftBuild(null, { versionId: '24.04' }), null);
  assert.strictEqual(
    distro.pickSwiftBuild(
      [{ name: '6.4.1', platforms: [{ name: 'Ubuntu 24.04', platform: 'Linux', archs: [] }] }],
      { versionId: '24.04' },
    ),
    null,
  );
});

test('сравнение версий работает для разной длины', () => {
  assert.ok(distro.compareVersions('6.4.1', '6.4') > 0);
  assert.ok(distro.compareVersions('6.1', '6.1.3') < 0);
  assert.strictEqual(distro.compareVersions('6.1.3', '6.1.3'), 0);
  assert.ok(distro.compareVersions('6.10', '6.9') > 0);
});

test('реальный список релизов swift.org даёт сборку для Ubuntu 26.04', async (t) => {
  let releases;
  try {
    releases = await distro.fetchSwiftReleases();
  } catch (error) {
    t.skip(`swift.org недоступен: ${error.message}`);
    return;
  }

  assert.ok(Array.isArray(releases) && releases.length > 10);

  const build = distro.pickSwiftBuild(releases, { versionId: '26.04', arch: 'x86_64' });
  assert.ok(build, 'для Ubuntu 26.04 должна найтись сборка');
  assert.strictEqual(build.exact, true, 'Ubuntu 26.04 уже поддерживается официально');
  assert.match(build.url, /^https:\/\/download\.swift\.org\/swift-[\d.]+-release\/ubuntu2604\//);

  // И для давно существующей версии тоже.
  const old = distro.pickSwiftBuild(releases, { versionId: '22.04', arch: 'x86_64' });
  assert.ok(old);
  assert.strictEqual(old.exact, true);
});
