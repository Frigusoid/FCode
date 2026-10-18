'use strict';
/*
 * Бэкенд сборки через xtool в подсистеме Linux (WSL).
 *
 * xtool (github.com/xtool-org/xtool) — кросс-платформенная замена Xcode: собирает
 * iOS-приложения из SwiftPM-пакетов, сам подписывает их и устанавливает на
 * устройство. Работает на Linux, а на Windows — через WSL.
 *
 * Что важно понимать про этот путь:
 *
 * 1. xtool собирает SwiftPM-пакеты, а НЕ .xcodeproj. Существующий Xcode-проект
 *    придётся переносить в Package.swift (Objective-C подключается как C-таргет).
 *
 * 2. iOS SDK xtool добывает из Xcode.xip, скачанного с сайта Apple. Использование
 *    SDK вне техники Apple противоречит лицензии Xcode — пользователь должен
 *    решать это сам, поэтому Fcode ничего не скачивает автоматически.
 *
 * 3. WSL требует включённых компонентов Windows и перезагрузки — это действие
 *    администратора, Fcode только показывает, чего не хватает.
 *
 * Модуль ничего не устанавливает сам. Он проверяет состояние и запускает команды,
 * показывая их пользователю целиком.
 */

const { execFile, spawn } = require('child_process');
const { t } = require('../../shared/i18n');
const path = require('path');
const mirror = require('./mirror');
// Многострочные скрипты выполняем через общий модуль: он кодирует их в base64,
// иначе Windows-командная строка искажает кавычки и переносы строк.
// Имя отличается от локальной функции wslExec ниже, чтобы не перекрывать её.
const wslRunner = require('./wsl-exec');

const DEFAULT_DISTRO = 'Ubuntu';
const QUICK_TIMEOUT = 25000;

/**
 * wsl.exe печатает свои служебные сообщения в UTF-16LE, а вывод запущенной
 * Linux-команды идёт как UTF-8. Определяем кодировку по наличию нулевых байтов.
 */
function decodeWsl(buffer) {
  if (!buffer || buffer.length === 0) return '';
  // UTF-16LE с ASCII-текстом даёт нулевой байт на каждой нечётной позиции.
  let nullsAtOdd = 0;
  const sample = Math.min(buffer.length, 512);
  for (let i = 1; i < sample; i += 2) {
    if (buffer[i] === 0) nullsAtOdd += 1;
  }
  const isUtf16 = nullsAtOdd > sample / 8;
  let text = isUtf16 ? buffer.toString('utf16le') : buffer.toString('utf8');
  // Убираем BOM и «межбуквенные» нули, если кодировка определилась неверно.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\u0000/g, '');
}

/** Выполнить wsl.exe и вернуть результат (без выброса исключения). */
function wslExec(args, { timeout = QUICK_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      args,
      { timeout, windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error && typeof error.code === 'number' ? error.code : error ? -1 : 0,
          stdout: decodeWsl(stdout).trim(),
          stderr: decodeWsl(stderr).trim(),
          error: error ? error.message : null,
        });
      },
    );
  });
}

/** Преобразовать путь Windows в путь WSL: D:\Проект → /mnt/d/Проект */
function toWslPath(windowsPath) {
  const resolved = path.resolve(windowsPath);
  const match = /^([A-Za-z]):\\(.*)$/.exec(resolved);
  if (!match) return resolved.replace(/\\/g, '/');
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

/** Экранировать аргумент для передачи в bash -lc. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Запустить команду внутри дистрибутива WSL с потоковым выводом.
 * @param {string} command команда для bash -lc
 * @param {{distro?: string, cwd?: string, onOutput?: (chunk: string) => void, signal?: AbortSignal}} options
 */
function wslStream(command, options = {}) {
  const distro = options.distro || DEFAULT_DISTRO;

  return new Promise((resolve) => {
    const args = ['-d', distro];
    if (options.cwd) args.push('--cd', options.cwd);
    args.push('--', 'bash', '-lc', command);

    let child;
    try {
      child = spawn('wsl.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, code: -1, error: error.message, output: '' });
      return;
    }

    let collected = '';
    const push = (buffer) => {
      const text = buffer.toString('utf8');
      collected += text;
      if (options.onOutput) options.onOutput(text);
    };

    child.stdout.on('data', push);
    child.stderr.on('data', push);

    child.on('error', (error) => {
      resolve({ ok: false, code: -1, error: error.message, output: collected });
    });

    child.on('close', (code) => {
      resolve({ ok: code === 0, code, error: code === 0 ? null : t('main.exitCode', { code }), output: collected });
    });

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        try {
          child.kill();
        } catch {
          /* уже завершился */
        }
      });
    }
  });
}

/** Доступен ли wsl.exe в принципе. */
async function checkWslBinary() {
  const result = await wslExec(['--status']);
  const text = `${result.stdout}\n${result.stderr}`;

  // Типичные признаки того, что компоненты Windows не включены.
  const componentMissing =
    /WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED/i.test(text) ||
    /не установлена|not installed/i.test(text);

  const versionResult = await wslExec(['--version']);
  const versionMatch = /WSL:\s*([\d.]+)/i.exec(versionResult.stdout);

  return {
    available: !componentMissing && result.ok,
    componentMissing,
    operational: !componentMissing,
    appVersion: versionMatch ? versionMatch[1] : null,
    rawOutput: text.slice(0, 1200),
  };
}

/** Список установленных дистрибутивов. */
async function listDistros() {
  const result = await wslExec(['-l', '-q']);
  if (!result.ok && !result.stdout) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^docker-desktop/i.test(line));
}

/**
 * Triple, под которые объявлен SDK: разбираем info.json бандла.
 *
 * Формат — обычный JSON от SwiftPM: artifacts.<имя>.variants[].supportedTriples.
 * Если разобрать не вышло, возвращаем пустой список: тогда проверка честно
 * скажет «не знаю», а не сделает вид, что всё в порядке.
 */
function parseSdkTriples(jsonText) {
  if (!jsonText || jsonText === 'нет') return [];
  try {
    const parsed = JSON.parse(jsonText);
    const artifacts = parsed.artifacts || {};
    const triples = new Set();

    for (const artifact of Object.values(artifacts)) {
      for (const variant of artifact.variants || []) {
        for (const triple of variant.supportedTriples || []) triples.add(triple);
      }
    }
    return [...triples];
  } catch {
    return [];
  }
}

function parseSdkTargets(jsonText) {
  if (!jsonText || jsonText === 'нет') return [];
  try {
    const parsed = JSON.parse(jsonText);
    return Object.keys(parsed.targetTriples || {});
  } catch {
    return [];
  }
}

/**
 * Triple системы из вывода `swift --version`.
 *
 * Строка выглядит как «Target: x86_64-pc-linux-gnu». Для Ubuntu на x86 это
 * именно pc, а не unknown — в этом и была причина, по которой SDK не находился:
 * бандл объявляет x86_64-unknown-linux-gnu, а система просит x86_64-pc-linux-gnu.
 */
function hostTripleOf(swiftText) {
  // Triple состоит из четырёх частей: архитектура-вендор-система-abi,
  // например x86_64-pc-linux-gnu. Захватываем до конца строки, а не три части.
  const match = /Target:\s*([a-z0-9_]+(?:-[a-z0-9_]+){2,})/i.exec(swiftText || '');
  return match ? match[1] : null;
}

/** Проверить наличие инструментов внутри дистрибутива. */
async function checkInside(distro) {
  // Один вызов вместо пяти: так быстрее и меньше поводов для гонок.
  //
  // Скрипт передаётся через base64. Раньше он уходил в wsl.exe аргументом, и
  // подстановки с кавычками и звёздочкой ломались: `$f` приходил пустым,
  // `cat` ругался на пустое имя, и разбор triple возвращал пустоту — панель
  // требований врала, будто SDK не настроен.
  const script = [
    // Маркер печатается через printf с ведущим переводом строки: если вывод
    // предыдущего раздела не закончился \n (например, файл без перевода строки
    // в конце), маркер иначе приклеится к последней строке JSON и разбор
    // потеряет целую секцию.
    "printf '\\n###swift\\n'; (swift --version 2>&1 | head -2) || echo 'нет'",
    "printf '\\n###usbmuxd\\n'; (usbmuxd --help 2>&1 | head -1) || echo 'нет'",
    "printf '\\n###xtool\\n'; (xtool --help 2>&1 | head -3) || echo 'нет'",
    "printf '\\n###sdk\\n'; (swift sdk list 2>&1) || echo 'нет'",
    // Оглавление бандла: в нём перечислены triple, под которые он годится.
    // Имя бандла заранее неизвестно: xtool может назвать его darwin, ios и как
    // угодно ещё. Берём первый найденный, а не жёсткое darwin.artifactbundle.
    "printf '\\n###sdkinfo\\n'; (for f in \"$HOME\"/.swiftpm/swift-sdks/*.artifactbundle/info.json; do cat \"$f\"; break; done) 2>/dev/null || echo 'нет'",
    // Описание самого SDK: здесь перечислены triple ЦЕЛИ, которые он умеет
    // собирать. Без arm64-apple-ios xtool не найдёт SDK, хотя info.json верен.
    "printf '\\n###sdktargets\\n'; (for f in \"$HOME\"/.swiftpm/swift-sdks/*.artifactbundle/swift-sdk.json; do cat \"$f\"; break; done) 2>/dev/null || echo 'нет'",
    "printf '\\n###arch\\n'; uname -m",
    "printf '\\n###home\\n'; echo \"$HOME\"",
  ].join('\n');

  // Base64-обёртка: иначе кавычки и звёздочки в подстановках искажаются при
  // передаче через аргументы wsl.exe, и данные приходят пустыми.
  const result = await wslStream(wslRunner.encodeScript(script), { distro });
  const sections = {};
  let current = null;
  for (const line of result.output.split(/\r?\n/)) {
    const marker = /^###(\w+)$/.exec(line.trim());
    if (marker) {
      current = marker[1];
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }

  const read = (key) => (sections[key] || []).join('\n').trim();
  const has = (key) => {
    const value = read(key);
    return Boolean(value) && value !== 'нет' && !/command not found|not found/i.test(value);
  };

  const swiftText = read('swift');
  const swiftMatch = /Swift version ([\d.]+)/i.exec(swiftText);

  return {
    reachable: result.ok || Object.keys(sections).length > 0,
    error: result.error,
    swift: {
      installed: has('swift'),
      version: swiftMatch ? swiftMatch[1] : null,
      raw: swiftText.slice(0, 200),
    },
    usbmuxd: { installed: has('usbmuxd'), raw: read('usbmuxd').slice(0, 120) },
    xtool: { installed: has('xtool'), raw: read('xtool').slice(0, 300) },
    swiftSdk: {
      list: read('sdk').slice(0, 300),
      // Имя бандла задаёт xtool, и оно не обязано быть darwin. Раньше проверка
      // искала слово darwin, поэтому на машине с другим именем SDK считался
      // отсутствующим: строка в Requirements не появлялась, чинить было нечего.
      installed: has('sdk') && !/no sdk|not found/i.test(read('sdk')),
      hasDarwin: /darwin/i.test(read('sdk')),
      // Triple, под которые объявлен бандл, и triple самой системы. Если второго
      // нет в первом — SDK не подхватится, и это надо чинить, а не пересобирать.
      triples: parseSdkTriples(read('sdkinfo')),
      hostTriple: hostTripleOf(swiftText),
      targetTriples: parseSdkTargets(read('sdktargets')),
    },
    arch: read('arch') || null,
    home: read('home') || null,
  };
}

/**
 * Полная диагностика пути «сборка без Xcode».
 * Возвращает пошаговый чек-лист — интерфейс показывает его пользователю.
 */
/** Команда установки xtool — одна и та же в тексте подсказки и в шаге. */
const XTOOL_INSTALL_COMMAND =
  'curl -fL "https://github.com/xtool-org/xtool/releases/latest/download/xtool-$(uname -m).AppImage" -o xtool && chmod +x xtool && sudo mv xtool /usr/local/bin/';

/** Шаг, который ещё нельзя выполнить: показываем, чего он ждёт. */
function pendingStep(spec) {
  return {
    id: spec.id,
    title: t(`linux.step.${spec.id}.title`),
    done: false,
    admin: false,
    needsReboot: false,
    detail: t('linux.waiting', { what: t(`linux.need.${spec.wait}`) }),
    command: spec.command,
    action: spec.action || null,
    hint: null,
  };
}

/**
 * Готовый шаг: текст берётся из словаря, данные подставляются параметрами.
 *
 * action — шаг выполняется не командой, а окном: интерактивные вещи вроде
 * выбора Xcode или входа в Apple ID нельзя запускать вслепую в фоне.
 */
function buildStep({
  id,
  done,
  admin = false,
  needsReboot = false,
  command = null,
  action = null,
  data = null,
}) {
  return {
    id,
    title: t(`linux.step.${id}.title`),
    done,
    admin,
    needsReboot,
    detail: t(`linux.step.${id}.${done ? 'done' : 'todo'}`, data || undefined),
    command: done ? null : command,
    action: done ? null : action,
    hint: done ? null : t(`linux.step.${id}.hint`),
  };
}

/**
 * Полная диагностика пути «сборка без Xcode».
 * Возвращает пошаговый чек-лист — интерфейс показывает его пользователю.
 */
async function checkEnvironment(preferredDistro) {
  const steps = [];
  const wsl = await checkWslBinary();

  steps.push(
    buildStep({
      id: 'wsl-components',
      done: wsl.operational,
      admin: !wsl.operational,
      needsReboot: !wsl.operational,
      command: wsl.operational ? null : 'wsl --install --no-distribution',
      data: { version: wsl.appVersion || '—' },
    }),
  );

  if (!wsl.operational) {
    // Без WSL остальные шаги бессмысленны — показываем их как ожидающие.
    steps.push(
      ...[
        { id: 'distro', wait: 'wsl', command: 'wsl --install -d Ubuntu' },
        { id: 'swift', wait: 'distro', command: null },
        {
          id: 'usbmuxd',
          wait: 'distro',
          command: 'sudo apt-get install -y usbmuxd libimobiledevice-utils',
        },
        { id: 'xtool', wait: 'distro', command: null },
        { id: 'ios-sdk', wait: 'xtool', command: null, action: 'sdk' },
        { id: 'apple-id', wait: 'xtool', command: null, action: 'signin' },
      ].map(pendingStep),
    );

    return {
      supported: false,
      ready: false,
      wsl,
      distros: [],
      distro: null,
      inside: null,
      steps,
      blocker: t('linux.blockerWsl'),
    };
  }

  const distros = await listDistros();
  const distro =
    preferredDistro && distros.includes(preferredDistro) ? preferredDistro : distros[0] || null;

  steps.push(
    buildStep({
      id: 'distro',
      done: Boolean(distro),
      command: distro ? null : 'wsl --install -d Ubuntu',
      data: { distro: distro || '—' },
    }),
  );

  if (!distro) {
    steps.push(
      ...[
        { id: 'swift', wait: 'distro', command: null },
        { id: 'usbmuxd', wait: 'distro', command: null },
        { id: 'xtool', wait: 'distro', command: null },
        { id: 'ios-sdk', wait: 'xtool', command: null, action: 'sdk' },
        { id: 'apple-id', wait: 'xtool', command: null, action: 'signin' },
      ].map(pendingStep),
    );

    return {
      supported: true,
      ready: false,
      wsl,
      distros,
      distro: null,
      inside: null,
      steps,
      blocker: t('linux.blockerDistro'),
    };
  }

  const inside = await checkInside(distro);

  steps.push(
    buildStep({
      id: 'swift',
      done: inside.swift.installed,
      command: inside.swift.installed
        ? null
        : 'sudo apt-get update && sudo apt-get install -y swiftlang   # либо тулчейн с swift.org/install/linux',
      data: { version: inside.swift.version || inside.swift.raw || '—' },
    }),
  );

  steps.push(
    buildStep({
      id: 'usbmuxd',
      done: inside.usbmuxd.installed,
      command: inside.usbmuxd.installed
        ? null
        : 'sudo apt-get install -y usbmuxd libimobiledevice-utils',
    }),
  );

  steps.push(
    buildStep({
      id: 'xtool',
      done: inside.xtool.installed,
      command: inside.xtool.installed ? null : XTOOL_INSTALL_COMMAND,
    }),
  );

  // Установка SDK требует путь к Xcode — открываем окно.
  steps.push(
    buildStep({
      id: 'ios-sdk',
      // Не привязываемся к имени darwin: бандл может называться иначе.
      done: Boolean(inside.swiftSdk.installed || inside.swiftSdk.hasDarwin),
      action: 'sdk',
    }),
  );

  // Вход в Apple ID проверяем отдельно от SDK: это разные вещи, и путать их
  // нельзя — иначе панель просит войти при живом токене.
  let account = null;
  try {
    account = await authStatus(distro);
  } catch {
    account = null;
  }

  steps.push(
    buildStep({
      id: 'apple-id',
      done: Boolean(account && account.loggedIn),
      action: 'signin',
      data: { account: (account && account.appleId) || '—' },
    }),
  );

  const ready = steps.every((step) => step.done);
  const firstPending = steps.find((step) => !step.done);

  return {
    supported: true,
    ready,
    wsl,
    distros,
    distro,
    inside,
    steps,
    blocker: ready ? null : firstPending ? firstPending.title : null,
  };
}
/**
 * Собрать проект через xtool.
 *
 * Команды xtool:
 *   xtool dev build --ipa  — собрать и получить готовый .ipa;
 *   xtool dev build        — собрать .app без упаковки;
 *   xtool dev run          — собрать и сразу поставить на подключённый iPhone.
 *
 * Отдельная тонкость — где собирать. Проект лежит на диске Windows и виден
 * внутри WSL как /mnt/..., а SwiftPM через 9p работать не умеет: падает на
 * блокировке файла состояния. Поэтому проект копируется в зеркало внутри Linux,
 * сборка идёт там, а готовый .ipa возвращается в папку проекта.
 *
 * @param {{projectPath: string, distro?: string, mode?: 'build'|'run',
 *          configuration?: 'debug'|'release', ipa?: boolean,
 *          outputDir?: string, onOutput?: Function, signal?: AbortSignal}} options
 */
async function build(options) {
  const distro = options.distro || DEFAULT_DISTRO;
  const mode = options.mode === 'run' ? 'run' : 'build';
  const wantIpa = mode === 'build' && options.ipa !== false;

  // Собираем в зеркале: на /mnt SwiftPM не работает.
  const prepared = await mirror.sync({
    windowsPath: options.projectPath,
    distro,
    onOutput: options.onOutput,
  });

  const parts = ['xtool', 'dev', mode];
  if (wantIpa) parts.push('--ipa');
  if (options.configuration === 'release') parts.push('--configuration', 'release');
  if (mode === 'run') parts.push('--usb');

  const command = `cd ${shellQuote(prepared.mirrorPath)} && ${parts.join(' ')}`;

  if (options.onOutput) {
    options.onOutput(`$ ${parts.join(' ')}\n`);
  }

  const result = await wslStream(command, {
    distro,
    onOutput: options.onOutput,
    signal: options.signal,
  });

  // Готовый .ipa лежит в зеркале — переносим его к проекту, иначе он потеряется.
  let ipaPath = null;
  if (result.ok && wantIpa) {
    ipaPath = await collectIpa({
      mirrorPath: prepared.mirrorPath,
      projectPath: options.projectPath,
      outputDir: options.outputDir,
      distro,
      onOutput: options.onOutput,
    });
  }

  return {
    ...result,
    command,
    projectPath: toWslPath(options.projectPath),
    mirrorPath: prepared.mirrorPath,
    ipaPath,
    distro,
  };
}

/**
 * Найти собранное приложение .app внутри зеркала сборки.
 * xtool кладёт его в .build/<конфигурация>-iphoneos/.
 */
async function findBuiltApp(options) {
  // Скрипт многострочный, поэтому выполняем через wslExec: он кодирует текст
  // в base64. wslStream передаёт команду напрямую, и переносы строк через
  // обратный слэш при этом искажаются — команда доходит сломанной.
  const script = `
set -e
MIRROR=${shellQuote(options.mirrorPath)}

# От прошлых сборок может остаться несколько .app — берём самый свежий.
CANDIDATES=$(find "$MIRROR" -maxdepth 5 -name '*.app' -type d 2>/dev/null | head -5)

if [ -z "$CANDIDATES" ]; then
  echo "APP_NOT_FOUND"
  exit 0
fi

BEST=""
BEST_TIME=0
for candidate in $CANDIDATES; do
  STAMP=$(stat -c %Y "$candidate" 2>/dev/null || echo 0)
  if [ "$STAMP" -gt "$BEST_TIME" ]; then
    BEST_TIME=$STAMP
    BEST="$candidate"
  fi
done

echo "\${BEST:-APP_NOT_FOUND}"
`;

  const result = await wslRunner.run({
    distro: options.distro || DEFAULT_DISTRO,
    user: null,
    script,
  });

  const found = String(result.output || '').trim().split(/\r?\n/).pop();

  if (!found || found === 'APP_NOT_FOUND' || !/\.app$/.test(found)) return null;
  return found;
}

/** Скопировать каталог из Linux в папку Windows. */
async function copyFromWsl(options) {
  const script = `
set -e
SRC=${shellQuote(options.wslPath)}
DST=${shellQuote(toWslPath(options.windowsDir))}

NAME=$(basename "$SRC")
rm -rf "$DST/$NAME"
mkdir -p "$DST"
cp -a "$SRC" "$DST/"
echo "$NAME"
`;

  const result = await wslRunner.run({
    distro: options.distro || DEFAULT_DISTRO,
    user: null,
    script,
  });

  const name = String(result.output || '').trim().split(/\r?\n/).pop();
  if (!name) throw new Error('не удалось перенести приложение из Linux');

  return path.join(options.windowsDir, name);
}

/** Забрать собранный .ipa из зеркала в папку проекта. */
async function collectIpa(options) {
  const destination = options.outputDir || path.join(options.projectPath, 'build');

  const script = `
set -e
SRC=${shellQuote(options.mirrorPath)}
DST=${shellQuote(toWslPath(destination))}

IPA=$(find "$SRC" -maxdepth 4 -name '*.ipa' -printf '%T@ %p\\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
if [ -z "$IPA" ]; then
  echo "IPA_NOT_FOUND"
  exit 0
fi

mkdir -p "$DST"
cp "$IPA" "$DST"/
basename "$IPA"
`;

  const result = await wslRunner.run({
    distro: options.distro || DEFAULT_DISTRO,
    user: null,
    script,
  });

  const name = String(result.output || '').trim().split(/\r?\n/).pop();

  if (!name || name === 'IPA_NOT_FOUND' || !/\.ipa$/i.test(name)) {
    if (options.onOutput) options.onOutput('Готовый .ipa не найден в зеркале сборки.\n');
    return null;
  }

  return path.join(destination, name);
}

/** Создать новый xtool-проект (заготовка SwiftUI-приложения). */
async function createProject(options) {
  const distro = options.distro || DEFAULT_DISTRO;
  const targetPath = toWslPath(options.projectPath);
  const name = options.name || path.basename(options.projectPath);
  const command = `cd ${shellQuote(path.posix.dirname(targetPath))} && xtool new ${shellQuote(name)}`;

  const result = await wslStream(command, { distro, onOutput: options.onOutput });
  return { ...result, command };
}

/** Установить готовый .ipa на подключённый iPhone через xtool. */
async function installIpa(options) {
  const distro = options.distro || DEFAULT_DISTRO;
  const ipaPath = toWslPath(options.ipaPath);
  const command = `xtool install ${shellQuote(ipaPath)}`;

  const result = await wslStream(command, { distro, onOutput: options.onOutput });
  return { ...result, command };
}

/** Список подключённых устройств. */
async function listDevices(distro) {
  const result = await wslStream('xtool devices', { distro: distro || DEFAULT_DISTRO });
  return { ...result, devices: result.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) };
}

/** Прямая команда в WSL — для ручного терминала в интерфейсе. */
async function runRaw(command, options = {}) {
  return wslStream(command, {
    distro: options.distro || DEFAULT_DISTRO,
    cwd: options.cwd,
    onOutput: options.onOutput,
    signal: options.signal,
  });
}


// ------------------------------------------------- учетная запись Apple

/** Прочитать состояние входа в Apple Developer Services. */
async function authStatus(distro) {
  const result = await runRaw('xtool auth status', { distro: distro || DEFAULT_DISTRO });
  const text = (result.output || '').trim();
  const loggedIn = /Logged in/i.test(text);

  // Токен печатается описанием; вытаскиваем из него понятные поля, если они есть.
  const pick = (pattern) => {
    const match = pattern.exec(text);
    return match ? match[1] : null;
  };

  // Формат вывода: строки вида «- Apple ID: …», «- Team ID: …».
  return {
    loggedIn,
    raw: text,
    appleId: pick(/-?\s*Apple ID:\s*(\S+)/i),
    teamId: pick(/-?\s*Team ID:\s*([A-Z0-9]+)/i),
    expiry: pick(/-?\s*Token expiry:\s*(.+)$/im),
  };
}

/** Выйти из учетной записи. reset2fa — забыть «псевдоустройство» для двухфакторки. */
async function logout(distro, reset2fa = false) {
  const command = reset2fa ? 'xtool auth logout --reset-2fa' : 'xtool auth logout';
  const result = await runRaw(command, { distro: distro || DEFAULT_DISTRO });
  return { ok: result.ok, output: (result.output || '').trim() };
}

/**
 * Команды Apple Developer Services: teams, certificates, profiles, devices,
 * identifiers. Возвращает и сырой текст, и разобранные строки.
 */
async function developerServices(subcommand, distro) {
  const allowed = new Set(['teams', 'certificates', 'profiles', 'devices', 'identifiers']);
  if (!allowed.has(subcommand)) throw new Error(`неизвестная команда ds: ${subcommand}`);

  const result = await runRaw(`xtool ds ${subcommand}`, { distro: distro || DEFAULT_DISTRO });
  const text = (result.output || '').trim();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  return { ok: result.ok, subcommand, output: text, lines };
}

/** Удалить приложение с устройства. */
async function uninstallApp(bundleId, distro) {
  const result = await runRaw(`xtool uninstall ${shellQuote(bundleId)}`, {
    distro: distro || DEFAULT_DISTRO,
  });
  return { ok: result.ok, output: (result.output || '').trim() };
}

/** Запустить установленное приложение на устройстве. */
async function launchApp(bundleId, distro) {
  const result = await runRaw(`xtool launch ${shellQuote(bundleId)}`, {
    distro: distro || DEFAULT_DISTRO,
  });
  return { ok: result.ok, output: (result.output || '').trim() };
}

/** Список установленных Swift SDK (darwin появляется после xtool setup). */
async function sdkList(distro) {
  const result = await runRaw('swift sdk list', { distro: distro || DEFAULT_DISTRO });
  const text = (result.output || '').trim();
  return {
    ok: result.ok,
    output: text,
    hasDarwin: /darwin/i.test(text),
    empty: /No Swift SDKs/i.test(text),
  };
}

/** Версия xtool и краткая справка — для панели «Об xtool». */
async function version(distro) {
  const result = await runRaw('xtool --help 2>&1 | head -3', { distro: distro || DEFAULT_DISTRO });
  return (result.output || '').trim();
}

module.exports = {
  DEFAULT_DISTRO,
  findBuiltApp,
  copyFromWsl,
  collectIpa,
  authStatus,
  logout,
  developerServices,
  uninstallApp,
  launchApp,
  sdkList,
  version,
  checkEnvironment,
  checkWslBinary,
  listDistros,
  build,
  createProject,
  installIpa,
  listDevices,
  runRaw,
  toWslPath,
  shellQuote,
  wslExec,
  decodeWsl,
  parseSdkTriples,
  parseSdkTargets,
  hostTripleOf,
};
