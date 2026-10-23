'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const setup = require('../src/main/modules/setup');
const xtool = require('../src/main/modules/xtool');

test('encodeScript: base64 декодируется обратно байт в байт', () => {
  const script = `set -e
. /etc/os-release
case "$VERSION_ID" in
  26.04) PLATFORM=ubuntu2604 ;;
esac
echo "ID=[$ID] VERSION=[$VERSION_ID] PLATFORM=[$PLATFORM]"
echo "кавычки: \\"двойные\\" и 'одинарные'"
`;

  const wrapped = setup.encodeScript(script);
  assert.match(wrapped, /^echo [A-Za-z0-9+/=]+ \| base64 -d \| bash$/);

  const base64 = wrapped.slice('echo '.length, wrapped.indexOf(' | base64 -d'));
  assert.strictEqual(Buffer.from(base64, 'base64').toString('utf8'), script);
});

test('encodeScript: результат не содержит символов, ломающих командную строку Windows', () => {
  const wrapped = setup.encodeScript('echo "a b" && echo \'c d\'\nrm -rf /tmp/$VAR');
  // Ни кавычек, ни переводов строк, ни знаков $ — именно из-за них скрипт
  // раньше приходил в bash искалеченным.
  assert.strictEqual(/["'\n\r$]/.test(wrapped), false);
});

/**
 * WSL не смогла запустить экземпляр (например, не хватило памяти).
 *
 * Это состояние машины, а не ошибка кода: такие проверки пропускаем, иначе
 * `npm test` падает у любого, у кого WSL временно недоступен.
 */
function wslUnavailable(result) {
  return Boolean(
    result &&
      !result.ok &&
      /ERROR_NO_SYSTEM_RESOURCES|CreateInstance|CreateVm|Недостаточно системных ресурсов/i.test(
        result.output || result.error || '',
      ),
  );
}

test('скрипт доходит до bash без искажений: переменные и кавычки целы', async (t) => {
  const env = await xtool.checkEnvironment();
  if (!env.distro) {
    t.skip('дистрибутив WSL не установлен');
    return;
  }

  const script = `. /etc/os-release
PLATFORM=fallback
case "$VERSION_ID" in
  26.04) PLATFORM=ubuntu2604 ;;
  24.04) PLATFORM=ubuntu2404 ;;
esac
echo "ID=[$ID] PLATFORM=[$PLATFORM]"
echo "quote=[\\"двойные\\"]"`;

  const result = await setup.runAsRoot(env.distro, script);

  if (wslUnavailable(result)) {
    t.skip('WSL не запускается на этой машине');
    return;
  }

  assert.strictEqual(result.ok, true, `скрипт упал: ${result.output}`);
  // Главное: значения переменных не потерялись. До перехода на base64 здесь
  // было "ID=[] PLATFORM=[]" — Windows съедал кавычки и знаки $.
  assert.match(result.output, /ID=\[ubuntu\]/);
  assert.match(result.output, /PLATFORM=\[ubuntu2604\]|PLATFORM=\[ubuntu2404\]/);
  assert.match(result.output, /quote=\["двойные"\]/);
});

test('probeDistro: дистрибутив отвечает и печатает ready', async (t) => {
  const env = await xtool.checkEnvironment();
  if (!env.distro) {
    t.skip('дистрибутив WSL не установлен');
    return;
  }

  const probe = await setup.probeDistro(env.distro);

  if (wslUnavailable(probe)) {
    t.skip('WSL не запускается на этой машине');
    return;
  }

  assert.strictEqual(probe.ok, true, `дистрибутив не ответил: ${JSON.stringify(probe)}`);
  assert.match(probe.output, /ready/);
});

test('шаги строятся под окружение и идут в правильном порядке', () => {
  const steps = setup.buildSteps({}, { method: 'apt', note: 'пакет в репозитории' });
  const ids = steps.map((step) => step.id);

  assert.deepStrictEqual(ids, [
    'wsl-components',
    'distro',
    'swift',
    'usbmuxd',
    'xtool',
    'ios-sdk',
    'apple-id',
  ]);

  // Первые два шага — Windows с повышением прав, следующие три — внутри Linux.
  assert.strictEqual(steps[0].kind, 'windows');
  assert.strictEqual(steps[0].elevated, true);
  assert.strictEqual(steps[0].requiresReboot, true);
  assert.strictEqual(steps[1].kind, 'windows');

  ['swift', 'usbmuxd', 'xtool'].forEach((id) => {
    const step = steps.find((item) => item.id === id);
    assert.strictEqual(step.kind, 'linux');
    assert.ok(step.script.length > 50, `у шага ${id} пустой скрипт`);
  });

  // Ручные шаги — ровно те два, которые нельзя автоматизировать.
  const manual = steps.filter((step) => step.kind === 'manual').map((step) => step.needs);
  assert.deepStrictEqual(manual.sort(), ['Xcode.xip', 'xtool auth'].sort());
});

test('способ установки Swift подставляется в шаг, а не выбирается в скрипте', () => {
  const apt = setup.buildSteps({}, { method: 'apt', note: '' }).find((s) => s.id === 'swift');
  assert.match(apt.script, /apt-get install -y -qq swiftlang/);

  const url = 'https://download.swift.org/swift-6.4.1-release/ubuntu2604/swift-6.4.1-RELEASE/swift-6.4.1-RELEASE-ubuntu26.04.tar.gz';
  const tarball = setup
    .buildSteps({}, { method: 'tarball', url, version: '6.4.1', note: '' })
    .find((s) => s.id === 'swift');
  assert.ok(tarball.script.includes(url), 'ссылка должна попасть в скрипт целиком');
});

test('в скриптах нет зашитых версий Ubuntu и GCC', () => {
  // Именно из-за таких констант ломалась поддержка новых версий:
  // на Ubuntu 26.04 пакета libgcc-13-dev уже нет.
  // Комментарии не проверяем — в них версии уместны как пояснение.
  const code = [
    setup.APT_SWIFT,
    setup.tarballSwift('https://example.org/swift.tar.gz'),
    ...setup.buildSteps({}, { method: 'apt', note: '' }).map((step) => step.script || ''),
  ]
    .join('\n')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  assert.doesNotMatch(code, /ubuntu2[0-9]0[0-9]/, 'не должно быть зашитых версий Ubuntu');
  assert.doesNotMatch(code, /libgcc-1[0-9]-dev/, 'версия GCC должна вычисляться');
  assert.doesNotMatch(code, /libstdc\+\+-1[0-9]-dev/, 'версия libstdc++ должна вычисляться');
  // А вычисление — быть.
  assert.match(code, /apt-cache search --names-only '\^libgcc-\[0-9\]\+-dev\$'/);
});

test('неподдерживаемый дистрибутив даёт понятный шаг, а не молчаливый пропуск', () => {
  const steps = setup.buildSteps({}, { method: 'none', note: 'установлен Fedora' });
  const swift = steps.find((step) => step.id === 'swift');

  assert.strictEqual(swift.kind, 'unsupported');
  assert.strictEqual(swift.reason, 'установлен Fedora');
  assert.strictEqual(swift.script, undefined);
});
