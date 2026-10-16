'use strict';
/*
 * Автоматическая установка всего, что нужно для сборки.
 *
 * Пользователь один раз нажимает «Run», а FCode проходит по шагам, пропуская уже
 * выполненные:
 *
 *   Windows-шаги — через wsl.exe с повышением прав (появится запрос UAC);
 *   Linux-шаги   — от имени root внутри дистрибутива (wsl -u root), поэтому
 *                  apt-get не спрашивает пароль.
 *
 * Никаких таблиц «версия Ubuntu → ссылка» здесь нет: способ установки Swift
 * выбирает модуль distro, опираясь на репозиторий дистрибутива и список релизов
 * swift.org. Поэтому новые версии Ubuntu поддерживаются без правок кода.
 *
 * Что автоматизировать нельзя и почему:
 *   • Xcode.xip — ~10 ГБ с сайта Apple, требует входа по Apple ID в браузере;
 *   • xtool auth — нужны Apple ID, пароль и код двухфакторной аутентификации.
 *   Эти шаги FCode открывает в настоящем терминале WSL.
 */

const { execFile } = require('child_process');
const wslExec = require('./wsl-exec');
const distro = require('./distro');
const xtool = require('./xtool');

/**
 * Swift из репозитория дистрибутива.
 * Самый надёжный путь: не нужно ни угадывать версию платформы, ни подбирать
 * список зависимостей — всё делает пакетный менеджер.
 */
const APT_SWIFT = `
set -e
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq swiftlang
swift --version
`;

/** Официальный тулчейн swift.org, когда пакета в репозитории нет. */
function tarballSwift(url) {
  return `
set -e
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates tar

# Часть зависимостей привязана к версии GCC, поэтому имя пакета вычисляем,
# а не пишем числом: на Ubuntu 22.04 это libgcc-11-dev, на 26.04 — уже другой.
GCCPKG=$(apt-cache search --names-only '^libgcc-[0-9]+-dev$' | sort -V | tail -1 | cut -d' ' -f1)
STDPKG=$(apt-cache search --names-only '^libstdc\\+\\+-[0-9]+-dev$' | sort -V | tail -1 | cut -d' ' -f1)
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \\
  binutils libc6-dev libcurl4-openssl-dev libedit2 libncurses-dev libpython3-dev \\
  libsqlite3-0 libxml2-dev libz3-dev pkg-config tzdata unzip zlib1g-dev \\
  $GCCPKG $STDPKG

echo "Скачиваю ${url}"
curl -fL --retry 3 -o /tmp/swift.tar.gz "${url}"
rm -rf /opt/swift && mkdir -p /opt/swift
tar -xzf /tmp/swift.tar.gz -C /opt/swift --strip-components=1
rm -f /tmp/swift.tar.gz
ln -sf /opt/swift/usr/bin/swift /usr/local/bin/swift
ln -sf /opt/swift/usr/bin/swiftc /usr/local/bin/swiftc
swift --version
`;
}

/** usbmuxd и утилиты libimobiledevice — связь с iPhone из WSL. */
const USB_AND_TOOLS = `
set -e
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq usbmuxd libimobiledevice-utils
echo "usbmuxd готов"
`;

/**
 * xtool — один файл AppImage с GitHub Releases.
 * AppImage требует FUSE; если его нет, распаковываем — так работает всегда.
 */
const XTOOL_INSTALL = `
set -e
ARCH=$(uname -m)
URL="https://github.com/xtool-org/xtool/releases/latest/download/xtool-$ARCH.AppImage"
echo "Скачиваю $URL"
curl -fL --retry 3 -o /tmp/xtool.appimage "$URL"
chmod +x /tmp/xtool.appimage

if [ -e /dev/fuse ]; then
  mv /tmp/xtool.appimage /usr/local/bin/xtool
  echo "xtool установлен как AppImage"
else
  echo "FUSE недоступен — распаковываю AppImage"
  (cd /tmp && /tmp/xtool.appimage --appimage-extract >/dev/null)
  rm -rf /opt/xtool && mv /tmp/squashfs-root /opt/xtool
  printf '#!/bin/sh\\nexec /opt/xtool/AppRun "$@"\\n' > /usr/local/bin/xtool
  chmod +x /usr/local/bin/xtool
  rm -f /tmp/xtool.appimage
fi

xtool --help | head -3
`;

/**
 * Собрать список шагов под конкретное окружение.
 * @param {object} environment результат checkEnvironment
 * @param {object|null} swiftPlan результат distro.resolveSwift
 */
function buildSteps(environment, swiftPlan) {
  const steps = [
    {
      id: 'wsl-components',
      kind: 'windows',
      elevated: true,
      command: ['--install', '--no-distribution'],
      requiresReboot: true,
    },
    {
      id: 'distro',
      kind: 'windows',
      elevated: true,
      command: ['--install', '-d', 'Ubuntu'],
    },
  ];

  if (swiftPlan && swiftPlan.method === 'apt') {
    steps.push({ id: 'swift', kind: 'linux', script: APT_SWIFT });
  } else if (swiftPlan && swiftPlan.method === 'tarball') {
    steps.push({ id: 'swift', kind: 'linux', script: tarballSwift(swiftPlan.url) });
  } else {
    steps.push({
      id: 'swift',
      kind: 'unsupported',
      reason: swiftPlan ? swiftPlan.note : 'не удалось определить способ установки Swift',
    });
  }

  steps.push({ id: 'usbmuxd', kind: 'linux', script: USB_AND_TOOLS });
  steps.push({ id: 'xtool', kind: 'linux', script: XTOOL_INSTALL });
  steps.push({ id: 'ios-sdk', kind: 'manual', needs: 'Xcode.xip' });
  steps.push({ id: 'apple-id', kind: 'manual', needs: 'xtool auth' });

  return steps;
}

/** Запустить команду Windows с повышением прав (появится запрос UAC). */
function runElevated(file, args, { onOutput } = {}) {
  return new Promise((resolve) => {
    const list = args.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(',');
    const script = `Start-Process -FilePath '${file}' -ArgumentList @(${list}) -Verb RunAs -Wait`;

    if (onOutput) onOutput(`[UAC] ${file} ${args.join(' ')}\n`);

    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', script],
      { timeout: 30 * 60 * 1000, windowsHide: true },
      (error, stdout, stderr) => {
        const output = `${stdout || ''}${stderr || ''}`.trim();
        if (output && onOutput) onOutput(`${output}\n`);
        resolve({
          ok: !error,
          error: error ? error.message : null,
          output,
          // Отказ в UAC приходит именно так.
          cancelled: Boolean(
            error && /отменено|canceled|cancelled|The operation was canceled/i.test(error.message),
          ),
        });
      },
    );

    child.on('error', (error) =>
      resolve({ ok: false, error: error.message, output: '', cancelled: false }),
    );
  });
}

/** Запустить команду внутри дистрибутива от имени root — apt не спросит пароль. */
function runAsRoot(distroName, script, options = {}) {
  return wslExec.run({ distro: distroName, script, ...options });
}

/** Проверить, что дистрибутив готов к работе (Ubuntu при первом запуске просит создать пользователя). */
async function probeDistro(distroName) {
  const result = await wslExec.probe(distroName, 'echo ready', 90 * 1000);
  return { ...result, ok: result.ok && /ready/.test(result.output) };
}

/**
 * Пройти по шагам установки, пропуская уже выполненные.
 *
 * @param {{distro?: string, onOutput?: Function, onStep?: Function, signal?: AbortSignal}} options
 */
async function autoSetup(options = {}) {
  const onOutput = options.onOutput || (() => {});
  const onStep = options.onStep || (() => {});

  const before = await xtool.checkEnvironment(options.distro);
  const doneById = new Map(before.steps.map((step) => [step.id, step.done]));
  const distroName = before.distro || options.distro || xtool.DEFAULT_DISTRO;

  // Решаем, как ставить Swift, до начала работы — чтобы сразу сказать
  // пользователю, если автоматическая установка невозможна.
  let swiftPlan = null;
  if (!doneById.get('swift')) {
    onOutput('Определяю способ установки Swift…\n');
    try {
      swiftPlan = await distro.resolveSwift(distroName);
      onOutput(`  ${swiftPlan.note}\n`);
    } catch (error) {
      onOutput(`  не удалось определить: ${error.message}\n`);
    }
  }

  const steps = buildSteps(before, swiftPlan);
  const completed = [];
  const skipped = [];
  const results = [];

  for (const step of steps) {
    if (options.signal && options.signal.aborted) break;

    if (doneById.get(step.id)) {
      skipped.push(step.id);
      onStep({ id: step.id, status: 'skipped' });
      onOutput(`— ${step.id}: уже готово, пропускаю\n`);
      continue;
    }

    if (step.kind === 'manual') {
      onStep({ id: step.id, status: 'manual', needs: step.needs });
      onOutput(`\n→ Шаг «${step.id}» нужно выполнить вручную: ${step.needs}\n`);
      results.push({ id: step.id, status: 'manual', needs: step.needs });
      continue;
    }

    if (step.kind === 'unsupported') {
      onStep({ id: step.id, status: 'unsupported', reason: step.reason });
      onOutput(`\n⚠ ${step.id}: ${step.reason}\n`);
      results.push({ id: step.id, status: 'unsupported', reason: step.reason });
      continue;
    }

    onStep({ id: step.id, status: 'running' });
    onOutput(`\n→ ${step.id}: выполняю…\n`);

    let result;
    if (step.kind === 'windows') {
      result = await runElevated('wsl.exe', step.command, { onOutput });
      if (result.cancelled) {
        onStep({ id: step.id, status: 'cancelled' });
        onOutput('Запрос прав администратора отклонён — установка остановлена.\n');
        results.push({ id: step.id, status: 'cancelled' });
        return { completed, skipped, stopped: { id: step.id, reason: 'cancelled' }, results };
      }
    } else {
      if (!before.distro) {
        onStep({ id: step.id, status: 'blocked' });
        onOutput('Дистрибутив Linux ещё не установлен — сначала шаги Windows.\n');
        results.push({ id: step.id, status: 'blocked' });
        return { completed, skipped, stopped: { id: step.id, reason: 'no-distro' }, results };
      }
      result = await runAsRoot(distroName, step.script, {
        onOutput,
        signal: options.signal,
      });
    }

    if (!result.ok) {
      onStep({ id: step.id, status: 'failed', error: result.error });
      onOutput(`✗ ${step.id}: ошибка${result.error ? ` — ${result.error}` : ''}\n`);
      results.push({ id: step.id, status: 'failed', error: result.error });
      return { completed, skipped, stopped: { id: step.id, reason: 'failed' }, results };
    }

    completed.push(step.id);
    onStep({ id: step.id, status: 'done' });
    results.push({ id: step.id, status: 'done' });

    if (step.id === 'distro') {
      onOutput('Проверяю, что дистрибутив запускается…\n');
      const probe = await probeDistro(distroName);
      if (!probe.ok) {
        onOutput(
          '⚠ Дистрибутив установлен, но ещё не готов: при первом запуске Ubuntu просит\n' +
            '  создать пользователя. Откройте терминал WSL и завершите настройку, затем нажмите Run снова.\n',
        );
        onStep({ id: step.id, status: 'first-run' });
        return { completed, skipped, stopped: { id: step.id, reason: 'first-run' }, results };
      }
      onOutput('Дистрибутив отвечает.\n');
    }

    if (step.requiresReboot) {
      onOutput(
        '\n⚠ Компоненты WSL включены. Нужна перезагрузка — после неё нажмите Run снова,\n' +
          '  и установка продолжится с того же места.\n',
      );
      onStep({ id: step.id, status: 'reboot' });
      return { completed, skipped, stopped: { id: step.id, reason: 'reboot' }, results };
    }
  }

  const after = await xtool.checkEnvironment(distroName);
  const environment = await distro.detect(distroName);
  return { completed, skipped, stopped: null, results, environment, distroInfo: environment };
}

/** Проверить, запущены ли мы с правами администратора. */
function isElevated() {
  return new Promise((resolve) => {
    execFile('net', ['session'], { timeout: 5000, windowsHide: true }, (error) => {
      resolve(!error);
    });
  });
}

module.exports = {
  autoSetup,
  buildSteps,
  runElevated,
  runAsRoot,
  probeDistro,
  encodeScript: wslExec.encodeScript,
  isElevated,
  APT_SWIFT,
  tarballSwift,
};
