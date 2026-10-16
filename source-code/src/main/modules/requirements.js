'use strict';
/*
 * Таблица требований: что нужно, какая версия, что уже есть.
 *
 * Смысл — чтобы Fcode сам говорил, чего не хватает, и давал готовую команду:
 * либо скопировать в терминал, либо выполнить кнопкой. Пользователю не нужно
 * читать документацию xtool и сопоставлять версии вручную.
 *
 * Отдельный случай — iOS SDK. Его можно получить двумя путями, и оба описаны
 * готовыми командами:
 *   1) скачать Xcode.xip с сайта Apple (около 2,8 ГБ — это сжатый архив,
 *      распакованный Xcode занимает порядка 12 ГБ);
 *   2) скопировать нужное подмножество уже установленного Xcode с Mac.
 * Второй путь короче, потому что Xcode у пользователя, скорее всего, уже есть.
 */

const fs = require('node:fs');
const path = require('node:path');
const wslExec = require('./wsl-exec');
const distro = require('./distro');
const xtool = require('./xtool');
const swift = require('./swift');
const versions = require('./versions');

/** Минимальные версии, которые нужны для работы. */
const REQUIRED = {
  swift: '6.1',
  // xtool строит SDK из Xcode; поддерживаемые версии начинаются с 16.x
  xcode: '16.3',
  wsl: '2',
};

/** Сравнить версии вида «6.1.3» и «6.1». */
function versionAtLeast(found, required) {
  if (!found) return false;
  const parse = (text) => String(text).split(/[^\d]+/).filter(Boolean).map(Number);
  const left = parse(found);
  const right = parse(required);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

/**
 * Выполняющаяся проверка: второй одновременный вызов получит тот же результат,
 * а не запустит wsl.exe ещё раз параллельно.
 */
let inFlight = null;

/**
 * Собрать таблицу требований.
 * @param {{distro?: string}} options
 */
async function check(options = {}) {
  if (inFlight) return inFlight;

  inFlight = collect(options).finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/** Собственно сбор данных: выполняется по одному разу за раз. */
async function collect(options = {}) {
  const distroName = options.distro;

  // Проверки идут последовательно: три одновременных запуска wsl.exe мешают
  // друг другу, и часть ответов приходит пустой.
  const environment = await xtool.checkEnvironment(distroName);
  // Дальше всё читается оттуда же, откуда xtool берёт токен.
  const tools = await swift.checkTools(distroName).catch(() => null);
  const auth = await xtool.authStatus(distroName).catch(() => null);

  const inside = environment.inside || {};
  const rows = [];

  // --- Windows и WSL ---
  rows.push({
    id: 'wsl',
    title: 'WSL 2',
    required: `версия ${REQUIRED.wsl}+`,
    found: environment.wsl && environment.wsl.operational ? `включён, приложение ${environment.wsl.appVersion || '?'}` : null,
    ok: Boolean(environment.wsl && environment.wsl.operational),
    hint: 'Без подсистемы Linux установить инструменты Swift невозможно.',
    command: environment.wsl && environment.wsl.operational ? null : 'wsl --install --no-distribution',
    admin: true,
  });

  rows.push({
    id: 'distro',
    title: 'Дистрибутив Linux',
    required: 'Ubuntu 22.04 и новее',
    found: environment.distro || null,
    ok: Boolean(environment.distro),
    hint: 'Берём Ubuntu: для него есть готовый пакет swiftlang.',
    command: environment.distro ? null : 'wsl --install -d Ubuntu',
  });

  // --- инструменты внутри Linux ---
  const swiftVersion = (inside.swift && inside.swift.version) || null;
  rows.push({
    id: 'swift',
    title: 'Swift для Linux',
    required: `версия ${REQUIRED.swift}+`,
    found: swiftVersion ? `версия ${swiftVersion}` : null,
    ok: Boolean(swiftVersion) && versionAtLeast(swiftVersion, REQUIRED.swift),
    hint: 'Компилятор Swift и языковой сервер sourcekit-lsp ставятся одним пакетом.',
    command:
      swiftVersion && versionAtLeast(swiftVersion, REQUIRED.swift)
        ? null
        : 'apt-get install -y swiftlang',
  });

  rows.push({
    id: 'usbmuxd',
    title: 'usbmuxd и libimobiledevice',
    required: 'любая версия',
    found: inside.usbmuxd && inside.usbmuxd.installed ? 'установлен' : null,
    ok: Boolean(inside.usbmuxd && inside.usbmuxd.installed),
    hint: 'Нужны, чтобы видеть iPhone из подсистемы Linux.',
    command:
      inside.usbmuxd && inside.usbmuxd.installed
        ? null
        : 'apt-get install -y usbmuxd libimobiledevice-utils',
  });

  rows.push({
    id: 'xtool',
    title: 'xtool',
    required: 'последняя версия',
    found: inside.xtool && inside.xtool.installed ? 'установлен' : null,
    ok: Boolean(inside.xtool && inside.xtool.installed),
    hint: 'Собирает приложение, подписывает и ставит на устройство.',
    command: inside.xtool && inside.xtool.installed ? null : null,
  });

  // --- учетная запись ---
  rows.push({
    id: 'apple-id',
    title: 'Apple ID',
    required: 'бесплатного достаточно',
    found: auth && auth.loggedIn ? auth.appleId || 'вход выполнен' : null,
    ok: Boolean(auth && auth.loggedIn),
    hint: 'xtool сам выпустит сертификат и профиль подписи. Профиль живёт 7 дней.',
    command: null,
    action: 'signin',
  });

  // --- iOS SDK ---
  const sdk = inside.swiftSdk || {};
  rows.push({
    id: 'ios-sdk',
    title: 'iOS SDK',
    required: `Xcode ${REQUIRED.xcode}+`,
    found: sdk.hasDarwin ? 'SDK darwin зарегистрирован' : null,
    ok: Boolean(sdk.hasDarwin),
    hint: 'Без него компилятор не видит SwiftUI и UIKit — собирать можно только под Linux.',
    command: sdk.hasDarwin ? null : null,
    action: 'sdk',
  });

  // --- инструменты, которые появились вместе со Swift ---
  if (tools) {
    rows.push({
      id: 'swift-format',
      title: 'swift-format',
      required: 'вместе со Swift',
      found: tools.swiftFormat && tools.swiftFormat !== 'нет' ? tools.swiftFormat : null,
      ok: Boolean(tools.swiftFormat && tools.swiftFormat !== 'нет'),
      hint: 'Форматирование кода по клавишам Ctrl+Alt+F.',
      command: null,
    });
  }

  return {
    rows,
    ready: rows.every((row) => row.ok),
    missing: rows.filter((row) => !row.ok),
    environment,
    auth,
  };
}

/**
 * Команды для получения iOS SDK.
 *
 * Два равноправных пути:
 *   1) скачать Xcode.xip с сайта Apple — ничего копировать не нужно;
 *   2) взять уже установленный Xcode с Mac, скопировав только те файлы,
 *      которые xtool действительно читает.
 *
 * Список файлов для второго пути взят из исходников xtool
 * (SDKBuilder.SDKEntry.wanted), поэтому лишнее копировать не придётся.
 *
 * Пути не зашиты: оба приходят снаружи, потому что у каждого пользователя
 * они свои — внешний диск, общая папка SMB или просто загрузки.
 *
 * @param {{macPath?: string, windowsPath?: string}} options
 */
function sdkInstructions(options = {}) {
  const target = options.macPath;
  const windowsPath = options.windowsPath;

  if (!target || !windowsPath) {
    return {
      needsPaths: true,
      xipUrl: 'https://developer.apple.com/download/all/?q=Xcode',
      recommendedUrl: versions.RECOMMENDED.url,
      recommendedXcode: versions.RECOMMENDED.xcode,
      hint: 'Укажите папку, доступную и Windows, и macOS: exFAT-раздел, внешний диск или общая папка SMB.',
      alternatives: [
        'xtool sdk install --slim /путь/к/Xcode.xip',
        'xtool sdk install --slim /путь/к/Xcode.app',
      ],
    };
  }

  const copyScript = [
    '#!/bin/bash',
    '# Копирует с Mac только то, что xtool читает из Xcode.',
    '# Запускать в Терминале на macOS. Xcode можно указать первым аргументом.',
    'set -e',
    '',
    'SRC="${1:-/Applications/Xcode.app}"',
    `DST="${target}/Xcode.app"`,
    '',
    'if [ ! -d "$SRC" ]; then echo "Не найден Xcode: $SRC"; exit 1; fi',
    'echo "Источник: $SRC"',
    'echo "Назначение: $DST"',
    '',
    'mkdir -p "$DST/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib"',
    'cp "$SRC/Contents/Info.plist" "$DST/Contents/"',
    'cp "$SRC/Contents/version.plist" "$DST/Contents/"',
    '',
    'for LIB in swift swift_static clang; do',
    '  cp -R "$SRC/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/$LIB" \\',
    '        "$DST/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/"',
    'done',
    '',
    'for PLAT in iPhoneOS MacOSX iPhoneSimulator; do',
    '  SP="$SRC/Contents/Developer/Platforms/$PLAT.platform"',
    '  DP="$DST/Contents/Developer/Platforms/$PLAT.platform"',
    '  mkdir -p "$DP/Developer/Library" "$DP/Developer/usr"',
    '  cp "$SP/Info.plist" "$DP/"',
    '  cp -R "$SP/Developer/SDKs" "$DP/Developer/"',
    '  cp -R "$SP/Developer/Library/Frameworks" "$DP/Developer/Library/" 2>/dev/null || true',
    '  cp -R "$SP/Developer/Library/PrivateFrameworks" "$DP/Developer/Library/" 2>/dev/null || true',
    '  cp -R "$SP/Developer/usr/lib" "$DP/Developer/usr/"',
    'done',
    '',
    'du -sh "$DST"',
  ].join('\n');

  return {
    needsPaths: false,
    xipUrl: 'https://developer.apple.com/download/all/?q=Xcode',
    recommendedUrl: versions.RECOMMENDED.url,
    recommendedXcode: versions.RECOMMENDED.xcode,
    copyScript,
    copyTarget: target,
    windowsPath,
    installCommand: `xtool sdk install --slim ${xtool.toWslPath(windowsPath)}/Xcode.app`,
    alternatives: [
      'xtool sdk install --slim /путь/к/Xcode.xip',
      'xtool sdk install --slim /путь/к/Xcode.app',
    ],
  };
}

/**
 * Установить SDK из указанного пути (внутри Linux).
 *
 * Флаг --slim не передаём: он появился только в новых версиях xtool, а в
 * установленной 1.17.0 его нет и команда падает с «Unknown option». Это лишь
 * экономия места, поэтому обходимся без него — так работает на обеих версиях.
 */
async function installSdk(sdkPath, options = {}) {
  const distroName = options.distro || xtool.DEFAULT_DISTRO;
  const quoted = `'${String(sdkPath).replace(/'/g, "'\\''")}'`;

  const script = `
set -e
command -v xtool >/dev/null 2>&1 || { echo "xtool не найден"; exit 2; }

# Проверяем, понимает ли установленная версия флаг --slim.
if xtool sdk install --help 2>&1 | grep -q -- '--slim'; then
  xtool sdk install --slim ${quoted}
else
  xtool sdk install ${quoted}
fi
`;

  // Обычный пользователь, а не root: только там xtool видит токен Apple ID.
  return wslExec.run({ distro: distroName, user: null, script, onOutput: options.onOutput });
}

/**
 * Найти Sideloadly в системе.
 *
 * Программа ставится обычным установщиком, поэтому ищем её в типовых местах.
 * Нужна только для установки на iPhone — для сборки не требуется.
 *
 * @returns {{installed: boolean, path: string|null}}
 */
function findSideloadly() {
  const os = require("node:os");

  // Программа ставится прямо в AppData\Local, а не в Programs — это
  // проверено на живой установке. Порядок: сначала точные места, потом общие.
  const candidates = [
    path.join(os.homedir(), "AppData", "Local", "Sideloadly"),
    path.join(os.homedir(), "AppData", "Local", "Programs", "Sideloadly"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Sideloadly"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Sideloadly"),
  ];

  const pick = (dir) => {
    if (!fs.existsSync(dir)) return null;

    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return null;
    }

    // Основная программа и демон: демон позволяет ставить .ipa без окна.
    const program = entries.find((name) => /^sideloadly\.exe$/i.test(name));
    const daemon = entries.find((name) => /^sideloadlydaemon\.exe$/i.test(name));

    if (!program && !daemon) return null;

    return {
      installed: true,
      path: program ? path.join(dir, program) : null,
      daemon: daemon ? path.join(dir, daemon) : null,
      directory: dir,
    };
  };

  for (const dir of candidates) {
    const found = pick(dir);
    if (found) return found;
  }

  return { installed: false, path: null, daemon: null, directory: null };
}

/**
 * Открыть Sideloadly с готовым .ipa.
 *
 * Публичного командного интерфейса у Sideloadly нет, поэтому передаём путь
 * к файлу аргументом: программа подхватывает его и открывает окно с уже
 * выбранным .ipa. Пользователю остаётся ввести Apple ID и нажать Start.
 *
 * @param {{ipaPath?: string}} options
 */
function launchSideloadly(options = {}) {
  const sideloadly = findSideloadly();

  if (!sideloadly.installed || !sideloadly.path) {
    return { launched: false, reason: 'not-installed' };
  }

  const args = [];
  if (options.ipaPath && fs.existsSync(options.ipaPath)) {
    args.push(options.ipaPath);
  }

  const { spawn } = require("node:child_process");
  const { dirname } = require("node:path");

  try {
    // detached: программа должна остаться работать после выхода из FCode.
    // cwd важен: Sideloadly ищет свои библиотеки рядом с собой.
    const child = spawn(sideloadly.path, args, {
      cwd: sideloadly.directory || dirname(sideloadly.path),
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    return { launched: true, path: sideloadly.path, ipa: options.ipaPath || null };
  } catch (error) {
    return { launched: false, reason: error.message };
  }
}

/**
 * Пошаговое руководство для нового компьютера.
 *
 * Возвращает шаги по порядку: что сделать, чем проверить, готова ли связка.
 * Каждый шаг знает, выполнен ли он уже на этой машине, — поэтому окно
 * подсказывает ровно то, что осталось, а не весь список сразу.
 *
 * @param {{distro?: string}} options
 */
async function setupGuide(options = {}) {
  const environment = await xtool.checkEnvironment(options.distro);
  const inside = environment.inside || {};
  const auth = await xtool.authStatus(options.distro).catch(() => null);
  const tools = await swift.checkTools(options.distro).catch(() => null);
  const sideloadly = findSideloadly();

  const swiftVersion = (inside.swift && inside.swift.version) || null;
  const sdkReady = Boolean(inside.swiftSdk && inside.swiftSdk.hasDarwin);

  const steps = [];

  // --- 1. Подсистема Linux ---
  steps.push({
    id: 'wsl',
    title: 'Включить WSL 2',
    done: Boolean(environment.wsl && environment.wsl.operational),
    why: 'Без подсистемы Linux собрать iOS-приложение на Windows нельзя: компилятор Swift работает только в Linux.',
    note: 'Требует прав администратора и перезагрузки.',
    command: 'wsl --install -d Ubuntu',
    admin: true,
    link: null,
  });

  // --- 2. Дистрибутив ---
  steps.push({
    id: 'distro',
    title: 'Установить Ubuntu',
    done: Boolean(environment.distro),
    why: 'Для Ubuntu есть готовый пакет Swift, поэтому не нужно ничего собирать вручную.',
    note: environment.distro ? `Найден: ${environment.distro}` : null,
    command: 'wsl --install -d Ubuntu',
    admin: false,
    link: null,
  });

  // --- 3. Swift ---
  steps.push({
    id: 'swift',
    title: 'Поставить Swift для Linux',
    done: Boolean(swiftVersion) && versionAtLeast(swiftVersion, REQUIRED.swift),
    why: 'Компилятор Swift и языковой сервер sourcekit-lsp ставятся одним пакетом. Версия важна: слишком старая не прочитает интерфейсы из SDK.',
    note: swiftVersion ? `Найден Swift ${swiftVersion}` : null,
    command: 'apt-get install -y swiftlang',
    admin: true,
    link: 'https://www.swift.org/install/linux/',
  });

  // --- 4. Инструменты для работы с iPhone ---
  steps.push({
    id: 'usbmuxd',
    title: 'Поставить usbmuxd и libimobiledevice',
    done: Boolean(inside.usbmuxd && inside.usbmuxd.installed),
    why: 'Нужны, чтобы подсистема Linux видела iPhone по кабелю.',
    note: null,
    command: 'apt-get install -y usbmuxd libimobiledevice-utils',
    admin: true,
    link: null,
  });

  // --- 5. xtool ---
  steps.push({
    id: 'xtool',
    title: 'Установить xtool',
    done: Boolean(inside.xtool && inside.xtool.installed),
    why: 'xtool собирает приложение, подписывает его сертификатом и ставит на устройство. Это замена Xcode, которая работает на Linux.',
    note: null,
    command: 'curl -fsSL https://xtool.sh/install.sh | bash',
    admin: false,
    link: 'https://github.com/xtool-org/xtool',
  });

  // --- 6. Учётная запись Apple ---
  steps.push({
    id: 'apple-id',
    title: 'Войти в Apple ID',
    done: Boolean(auth && auth.loggedIn),
    why: 'xtool сам выпускает сертификат и профиль подписи. Бесплатного Apple ID достаточно, но профиль живёт 7 дней.',
    note: auth && auth.loggedIn ? `Вход выполнен: ${auth.appleId || "-"}` : null,
    command: null,
    action: 'signin',
    admin: false,
    link: null,
  });

  // --- 7. iOS SDK ---
  steps.push({
    id: 'ios-sdk',
    title: 'Установить iOS SDK',
    done: sdkReady,
    why: 'Без SDK компилятор не видит SwiftUI и UIKit — собирать можно только под Linux.',
    note: sdkReady ? 'SDK зарегистрирован' : `Нужен Xcode ${versions.RECOMMENDED.xcode} (скачать около 2,8 ГБ) и Swift ${versions.RECOMMENDED.swift}`,
    command: null,
    action: 'sdk',
    admin: false,
    link: versions.RECOMMENDED.url,
  });

  // --- 8. Подпись для установки на iPhone ---
  steps.push({
    id: 'sideloadly',
    title: 'Поставить Sideloadly (для установки на iPhone)',
    done: sideloadly.installed,
    why: 'Fcode собирает .ipa, но подписать его вашим Apple ID и поставить на телефон удобнее через Sideloadly: он работает на Windows и использует драйверы Apple.',
    note: sideloadly.installed
      ? `Найден: ${sideloadly.directory}`
      : 'Нужен только для установки на устройство — для сборки не требуется.',
    command: null,
    action: 'sideloadly',
    admin: false,
    link: 'https://sideloadly.io',
  });

  const missing = steps.filter((step) => !step.done);

  return {
    steps,
    missing,
    ready: missing.length === 0,
    environment,
    auth,
    tools,
    recommended: versions.RECOMMENDED,
  };
}

module.exports = {
  check,
  setupGuide,
  findSideloadly,
  launchSideloadly,
  sdkInstructions,
  installSdk,
  versionAtLeast,
  REQUIRED,
};
