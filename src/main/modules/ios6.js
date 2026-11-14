'use strict';
/*
 * Сборка под старые iOS (6.x) на Objective-C.
 *
 * Почему отдельный конвейер, а не SwiftPM: Swift требует iOS 7+ и не умеет
 * 32-битный ARM, поэтому для iOS 6 остаётся только Objective-C. Собираем так
 * же, как это делал Xcode 4.6:
 *
 *   clang -target armv7-apple-ios6.1 -isysroot <iPhoneOS6.1.sdk>   → .o
 *   ld64  -arch armv7 -ios_version_min 6.1 -syslibroot <SDK>      → Mach-O
 *   Info.plist + бинарник                                          → .app
 *
 * Линкер — портированный Apple ld64 (cctools-port): lld не умеет scattered-
 * релокации, которые выдаёт clang для 32-битного ARM.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** Где лежат скачанный SDK и собранный линкер. */
/**
 * Куда по умолчанию ставится тулчейн.
 *
 * В домашней папке пользователя, а не в фиксированном D:\FCode-work: у другой
 * машины другой диск и другое имя пользователя.
 */
const DEFAULT_ROOT = path.join(require('node:os').homedir(), 'Fcode', 'ios6');

/**
 * Пути внутри папки тулчейна.
 *
 * @param {string} [root]
 * @returns {{sdk: string, ld: string, clang: string, dispatch: string, blocks: string}}
 */
function toolchainPaths(root = DEFAULT_ROOT) {
  return {
    sdk: path.join(root, 'ios6-sdk', 'Xcode', 'Xcode.app', 'Contents', 'Developer',
      'Platforms', 'iPhoneOS.platform', 'Developer', 'SDKs', 'iPhoneOS6.1.sdk'),
    ld: path.join(root, 'cctools-build', 'cctools-port', 'cctools', 'ld64', 'src', 'ld', 'ld'),
    clang: '/usr/libexec/swift/bin/clang',
    dispatch: path.join(root, 'dispatch-stub', 'bin'),
    blocks: path.join(root, 'cctools-deps', 'root', 'usr', 'lib', 'x86_64-linux-gnu'),
  };
}

const DEFAULT_TOOLCHAIN = toolchainPaths(DEFAULT_ROOT);

/** Расширения исходников Objective-C. */
const SOURCE_EXTENSIONS = new Set(['.m', '.mm', '.c', '.cc']);

/** Фреймворки, без которых не обходится обычное приложение. */
const DEFAULT_FRAMEWORKS = ['UIKit', 'Foundation', 'CoreGraphics'];

/** Перевести путь Windows в путь WSL. */
function toWslPath(windowsPath) {
  const text = String(windowsPath).replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(text);
  if (!drive) return text;
  return `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
}

/** Собрать список исходников проекта. */
function collectSources(root) {
  const found = [];
  // Служебные и чужие каталоги: в них легко набрать тысячи .c-файлов
  // (тулчейны, SDK), которые к проекту отношения не имеют.
  const skip = new Set([
    '.git', 'build', '.build', 'xtool', 'Payload', 'node_modules',
    'cctools-build', 'cctools-deps', 'ios6-sdk', 'lld13', 'clang15',
    'quickjs-src', 'certs-src', 'tests', 'scripts',
    'dispatch-stub', 'tmp', 'dist', 'dist-new',
  ]);

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(full);
        continue;
      }

      if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(full);
    }
  };

  walk(root);
  return found.sort();
}

/** Есть ли в проекте Objective-C и нет ли SwiftPM-манифеста. */
function isLegacyProject(root) {
  if (fs.existsSync(path.join(root, 'Package.swift'))) return false;
  return collectSources(root).length > 0;
}

/** Прочитать Info.plist шаблоном или отдать null. */
function readInfoPlist(root) {
  for (const candidate of ['Info.plist', path.join('Sources', 'Info.plist')]) {
    const full = path.join(root, candidate);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/** Сгенерировать минимальный Info.plist, если своего нет. */
function makeInfoPlist({ bundleId, name }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>MinimumOSVersion</key><string>6.1</string>
  <key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
</dict>
</plist>
`;
}

/**
 * Команды для сборки: компиляция, линковка, упаковка.
 *
 * Возвращает массив шагов, чтобы вызывающий код показывал прогресс и мог
 * остановиться на первой ошибке.
 */
function buildPlan({ projectPath, appName, toolchain = DEFAULT_TOOLCHAIN, arch = 'armv7', minVersion = '6.1' }) {
  const root = path.resolve(projectPath);
  const name = appName || path.basename(root);
  const workDir = path.join(root, 'build', 'ios6');
  const appDir = path.join(workDir, 'Payload', `${name}.app`);

  const sources = collectSources(root);
  const sdk = toWslPath(toolchain.sdk);
  const ld = toWslPath(toolchain.ld);
  const dispatch = toWslPath(toolchain.dispatch);
  const blocks = toWslPath(toolchain.blocks);

  const env = {
    LD_LIBRARY_PATH: `${dispatch}:${blocks}:/usr/libexec/swift/bin`,
  };

  const compile = sources.map((source, index) => {
    const object = path.join(workDir, `obj-${index}.o`);
    return {
      label: `компиляция ${path.basename(source)}`,
      command: [
        toolchain.clang,
        `-target ${arch}-apple-ios${minVersion}`,
        `-isysroot ${sdk}`,
        '-fobjc-arc',
        '-O0',
        '-c',
        `"${toWslPath(source)}"`,
        `-o "${toWslPath(object)}"`,
      ].join(' '),
      env,
      needs: path.dirname(object),
    };
  });

  const objects = sources.map((_, index) => path.join(workDir, `obj-${index}.o`));

  const link = {
    label: 'линковка',
    command: [
      ld,
      `-arch ${arch}`,
      `-ios_version_min ${minVersion}`,
      `-syslibroot "${sdk}"`,
      `-L"${sdk}/usr/lib"`,
      '-lSystem -lobjc',
      ...DEFAULT_FRAMEWORKS.map((framework) => `-framework ${framework}`),
      `-o "${toWslPath(path.join(appDir, name))}"`,
      ...objects.map((object) => `"${toWslPath(object)}"`),
    ].join(' '),
    env,
  };

  return {
    name,
    workDir,
    appDir,
    sources,
    steps: [...compile, link],
    infoPlist: readInfoPlist(root),
    generatedInfoPlist: makeInfoPlist({
      bundleId: `com.fcode.${name.replace(/[^A-Za-z0-9]/g, '').toLowerCase()}`,
      name,
    }),
  };
}

/**
 * Найти образ Xcode 4.6.3.
 *
 * Порядок: путь, выбранный в интерфейсе, затем переданный явно, затем
 * привычные места. Функция чистая — проверку существования передают снаружи,
 * поэтому её легко протестировать.
 *
 * @param {{saved?: string, extra?: string[], exists?: (p: string) => boolean}} [options]
 * @returns {string|null}
 */
function findDmg(options = {}) {
  const exists = options.exists || ((filePath) => fs.existsSync(filePath));
  const candidates = [
    options.saved,
    ...(options.extra || []),
    path.join(DEFAULT_ROOT, 'Xcode_4.6.3.dmg'),
    path.join(require('node:os').homedir(), 'Downloads', 'Xcode_4.6.3.dmg'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      /* недоступный путь просто пропускаем */
    }
  }

  return null;
}

/**
 * Найти распакованный SDK iOS внутри папки.
 *
 * Образы Xcode 4.6.x упакованы по-разному: где-то Xcode/Xcode.app/...,
 * где-то папка называется иначе. Поэтому жёсткий путь ненадёжен — ищем
 * каталог iPhoneOS*.sdk в дереве и возвращаем первый найденный.
 *
 * @param {string} rootDir
 * @param {{depth?: number, readdir?: Function, exists?: Function}} [options]
 * @returns {string|null}
 */
function findSdk(rootDir, options = {}) {
  const readdir = options.readdir || ((dir) => fs.readdirSync(dir, { withFileTypes: true }));
  const exists = options.exists || ((filePath) => fs.existsSync(filePath));
  const maxDepth = options.depth === undefined ? 12 : options.depth;

  if (!rootDir || !exists(rootDir)) return null;

  const queue = [{ dir: rootDir, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth > maxDepth) continue;

    let entries;
    try {
      entries = readdir(current.dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const name = entry.name || entry;
      const isDirectory = entry.isDirectory ? entry.isDirectory() : true;
      if (!isDirectory) continue;

      const full = path.join(current.dir, name);

      if (/^iPhoneOS.*\.sdk$/i.test(name)) return full;
      queue.push({ dir: full, depth: current.depth + 1 });
    }
  }

  return null;
}

module.exports = {
  DEFAULT_TOOLCHAIN,
  DEFAULT_FRAMEWORKS,
  collectSources,
  isLegacyProject,
  buildPlan,
  makeInfoPlist,
  readInfoPlist,
  toWslPath,
  findDmg,
  findSdk,
  toolchainPaths,
  DEFAULT_ROOT,
};

/** Запустить команду в WSL и вернуть её вывод. */
function runInWsl(command, { distro = 'Ubuntu', env = {}, timeout = 600000, user = null } = {}) {
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');

  const script = `${envPrefix ? `${envPrefix} ` : ''}${command}`;
  // Без -u: работаем от пользователя дистрибутива по умолчанию. Имя в WSL у
  // каждого своё, и жёстко прописывать его нельзя.
  const args = ['-d', distro];

  if (user) args.push('-u', user);
  args.push('--', 'bash', '-lc', script);

  const result = spawnSync('wsl.exe', args, { encoding: 'utf8', timeout, windowsHide: true });

  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/**
 * Собрать приложение под iOS 6 и упаковать в .ipa.
 *
 * @param {object} options
 * @param {string} options.projectPath папка проекта
 * @param {string} [options.appName] имя приложения
 * @param {string} [options.distro] дистрибутив WSL
 * @param {object} [options.toolchain] пути к SDK и линкеру
 * @param {(text: string) => void} [options.onOutput] вывод в консоль
 * @returns {{ok: boolean, ipaPath?: string, appPath?: string, error?: string}}
 */
async function build(options) {
  const { projectPath, appName, distro = 'Ubuntu', toolchain = DEFAULT_TOOLCHAIN, onOutput } = options;
  const log = onOutput || (() => {});

  if (!fs.existsSync(toolchain.sdk)) {
    return { ok: false, error: `не найден SDK iOS 6.1: ${toolchain.sdk}` };
  }
  if (!fs.existsSync(toolchain.ld)) {
    return { ok: false, error: `не найден линкер ld64: ${toolchain.ld}` };
  }

  const plan = buildPlan({ projectPath, appName, toolchain });
  if (plan.sources.length === 0) {
    return { ok: false, error: 'в проекте нет исходников Objective-C (.m)' };
  }

  log(`Objective-C под iOS 6.1: ${plan.sources.length} файлов\n`);

  fs.mkdirSync(plan.appDir, { recursive: true });

  for (const step of plan.steps) {
    log(`${step.label}\n`);
    const result = runInWsl(step.command, { distro, env: step.env });

    if (!result.ok) {
      const details = `${result.stdout}${result.stderr}`.trim();
      log(`${details}\n`);
      return { ok: false, error: `${step.label}: ${details.split('\n')[0] || 'ошибка'}` };
    }
  }

  const binary = path.join(plan.appDir, plan.name);
  if (!fs.existsSync(binary)) {
    return { ok: false, error: 'линковка прошла, но бинарник не создан' };
  }

  // Info.plist: свой из проекта или минимально достаточный.
  const infoPath = path.join(plan.appDir, 'Info.plist');
  if (plan.infoPlist) {
    fs.copyFileSync(plan.infoPlist, infoPath);
  } else {
    fs.writeFileSync(infoPath, plan.generatedInfoPlist, 'utf8');
  }

  runInWsl(`chmod +x "${toWslPath(binary)}"`, { distro });

  // Ресурсы проекта: иконки, картинки, локальные страницы. Кладём рядом с
  // бинарником — iOS 6 ищет Icon.png и прочее именно в корне .app.
  for (const folder of ['icons', 'Resources']) {
    const source = path.join(path.dirname(infoPath), '..', '..', '..', folder);
    const resolved = path.resolve(projectPath, folder);
    if (!fs.existsSync(resolved)) continue;

    for (const entry of fs.readdirSync(resolved)) {
      const from = path.join(resolved, entry);
      if (!fs.statSync(from).isFile()) continue;
      fs.copyFileSync(from, path.join(plan.appDir, entry));
    }
  }

  const payloadDir = path.join(plan.workDir, 'Payload');
  const ipaPath = path.join(plan.workDir, `${plan.name}.ipa`);

  const { zipDirectory } = require('./zip');
  await zipDirectory(plan.workDir, ipaPath, {
    include: (name) => name === 'Payload' || name.startsWith('Payload/'),
  });

  log(`готово: ${ipaPath}\n`);
  return { ok: true, ipaPath, appPath: plan.appDir };
}

module.exports.build = build;
module.exports.runInWsl = runInWsl;
