'use strict';
/*
 * Согласование версий: iOS SDK и компилятор Swift.
 *
 * Зачем это нужно. SDK внутри Xcode содержит готовые интерфейсы Swift
 * (.swiftinterface), записанные тем компилятором, которым собран Xcode. Если наш
 * компилятор старше, он не понимает новый синтаксис в этих файлах и падает с
 * «unknown attribute» или «this SDK is not supported by the compiler».
 *
 * Проверено на практике: SDK от Xcode 26.6 (внутри Swift 6.3.2) не собирается
 * компилятором 6.1.3 — сборка разваливается на тысячах ошибок в Swift.swiftmodule.
 *
 * Обратное направление работает: компилятор НОВЕЕ SDK читает старые интерфейсы
 * нормально. Поэтому правило простое — компилятор не должен быть старше SDK.
 *
 * Здесь же лежит таблица соответствия версий Xcode и Swift, чтобы пользователь
 * получал ровно ту связку, которая проверена, а не подбирал её сам.
 *
 * Важно про deployment target: свежий SDK НЕ мешает собирать под старые iOS.
 * Один SDK покрывает много версий — например, iPhoneOS26.5.sdk официально
 * поддерживает цели от iOS 12.0 до 26.5. Минимальную версию задаёт
 * IPHONEOS_DEPLOYMENT_TARGET в проекте, а не версия SDK.
 */

const fs = require('node:fs');
const wslExec = require('./wsl-exec');
const path = require('node:path');

/**
 * Проверенные связки: версия Xcode -> версия Swift для Linux.
 *
 * xcode    — версия Xcode, из которого берётся SDK;
 * swift    — минимально достаточная версия компилятора;
 * ubuntu   — для каких выпусков Ubuntu есть готовый тулчейн;
 * date     — когда Xcode вышел (для порядка сортировки).
 */
const TOOLCHAINS = [
  { xcode: '27.0', swift: '6.4.1', ubuntu: ['26.04', '24.04', '22.04'], date: '2026-10' },
  { xcode: '26.6', swift: '6.4.1', ubuntu: ['26.04', '24.04', '22.04'], date: '2026-09' },
  { xcode: '26.5', swift: '6.3.2', ubuntu: ['24.04', '22.04'], date: '2026-08' },
  { xcode: '26.4', swift: '6.3', ubuntu: ['24.04', '22.04'], date: '2026-07' },
  { xcode: '26.3', swift: '6.2.4', ubuntu: ['24.04', '22.04'], date: '2026-06' },
  { xcode: '26.2', swift: '6.2.3', ubuntu: ['24.04', '22.04'], date: '2026-05' },
  { xcode: '26.1', swift: '6.2.1', ubuntu: ['24.04', '22.04'], date: '2026-04' },
  { xcode: '26.0', swift: '6.2', ubuntu: ['24.04', '22.04'], date: '2026-03' },
  { xcode: '16.4', swift: '6.1.3', ubuntu: ['24.04', '22.04', '20.04'], date: '2025-09' },
  { xcode: '16.3', swift: '6.1', ubuntu: ['24.04', '22.04', '20.04'], date: '2025-03' },
  { xcode: '16.2', swift: '6.0.3', ubuntu: ['24.04', '22.04', '20.04'], date: '2024-12' },
  { xcode: '16.1', swift: '6.0.2', ubuntu: ['24.04', '22.04', '20.04'], date: '2024-10' },
  { xcode: '16.0', swift: '6.0', ubuntu: ['24.04', '22.04', '20.04'], date: '2024-09' },
];

/** Ubuntu для скачивания тулчейнов: 26.04 зовётся resolute, 24.04 — noble. */
const UBUNTU_CODENAMES = {
  '26.04': 'resolute',
  '25.10': 'questing',
  '25.04': 'plucky',
  '24.04': 'noble',
  '23.10': 'mantic',
  '22.04': 'jammy',
  '20.04': 'focal',
};

/** Разобрать версию в массив чисел. */
function parseVersion(value) {
  return String(value || '')
    .split(/[^\d]+/)
    .filter(Boolean)
    .map(Number);
}

/**
 * Сравнить версии.
 * @returns {number} 1 если a > b, -1 если a < b, 0 если равны
 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** Ближайшая (не новее указанной) запись таблицы для версии Xcode. */
function toolchainForXcode(xcodeVersion) {
  const exact = TOOLCHAINS.find((item) => item.xcode === String(xcodeVersion));
  if (exact) return exact;

  // Если точной версии нет, берём ближайшую младшую: она точно совместима.
  const older = TOOLCHAINS.filter((item) => compareVersions(item.xcode, xcodeVersion) <= 0);
  return older[0] || null;
}

/** Ссылка на тулчейн Swift для указанной версии и выпуска Ubuntu. */
function swiftTarballUrl(swiftVersion, ubuntuVersion) {
  const codename = UBUNTU_CODENAMES[ubuntuVersion];
  if (!codename) return null;
  return `https://download.swift.org/swift-${swiftVersion}-release/${codename.replace(/\./g, '')}/swift-${swiftVersion}-RELEASE/swift-${swiftVersion}-RELEASE-ubuntu${ubuntuVersion}.tar.gz`;
}

/**
 * Прочитать версию Xcode из установленного SDK.
 *
 * xtool кладёт SDK в ~/.swiftpm/swift-sdks/darwin.artifactbundle и сохраняет
 * исходный Xcode внутри — по нему и узнаём версию.
 */
function detectXcodeVersion(bundlePath) {
  if (!bundlePath || !fs.existsSync(bundlePath)) return null;

  // Путь вида .../Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS26.5.sdk
  const sdkDir = path.join(bundlePath, 'Developer', 'Platforms', 'iPhoneOS.platform', 'Developer', 'SDKs');
  if (!fs.existsSync(sdkDir)) return null;

  const names = fs.readdirSync(sdkDir).filter((name) => /^iPhoneOS[\d.]+\.sdk$/.test(name));
  if (names.length === 0) return null;

  const ios = names[0].replace(/^iPhoneOS/, '').replace(/\.sdk$/, '');

  // Версия iOS -> версия Xcode: у Xcode 26.6 SDK iOS 26.5.
  const major = Number(ios.split('.')[0]);
  const candidates = TOOLCHAINS.filter((item) => {
    const xcodeMajor = Number(String(item.xcode).split('.')[0]);
    return xcodeMajor === major || (major >= 26 && xcodeMajor >= 26);
  });

  return { iosVersion: ios, sdkDir, xcode: candidates[0] ? candidates[0].xcode : null, sdkName: names[0] };
}

/** Поддерживаемые цели развёртывания из SDKSettings.plist (обычный XML или бинарный). */
function readDeploymentTargets(bundlePath) {
  const info = detectXcodeVersion(bundlePath);
  if (!info) return [];

  const plist = path.join(info.sdkDir, 'SDKSettings.plist');
  if (!fs.existsSync(plist)) return [];

  try {
    // В XML-виде список лежит обычным текстом — этого достаточно для чтения.
    const text = fs.readFileSync(plist, 'latin1');
    const block = /DEPLOYMENT_TARGET_SUGGESTED_VALUES[\s\S]{0,4000}?<\/array>/.exec(text);
    if (!block) return [];
    return [...block[0].matchAll(/<string>([\d.]+)<\/string>/g)].map((match) => match[1]);
  } catch {
    return [];
  }
}

/**
 * Согласованы ли компилятор и SDK.
 *
 * @param {{swiftVersion: string, xcodeVersion?: string, iosVersion?: string}} input
 * @returns {{ok: boolean, required: string|null, message: string, fix: object|null}}
 */
function checkCompatibility(input) {
  const swift = input.swiftVersion;
  const xcode = input.xcodeVersion || (input.iosVersion ? null : null);

  // Если версия Xcode неизвестна, определяем требуемый Swift по версии SDK.
  let entry = xcode ? toolchainForXcode(xcode) : null;

  if (!entry && input.iosVersion) {
    const iosMajor = Number(String(input.iosVersion).split('.')[0]);
    const guessXcode = iosMajor >= 26 ? '26.6' : `${Math.max(16, iosMajor)}.0`;
    entry = toolchainForXcode(guessXcode);
  }

  if (!entry) {
    return {
      ok: true,
      required: null,
      message: 'Версию Xcode определить не удалось — проверка совместимости пропущена.',
      fix: null,
    };
  }

  // Компилятор не должен быть старше того, которым собран SDK.
  const sufficient = compareVersions(swift, entry.swift) >= 0;

  if (sufficient) {
    return {
      ok: true,
      required: entry.swift,
      message: `Swift ${swift} подходит для SDK от Xcode ${entry.xcode} (нужно ${entry.swift} и новее).`,
      fix: null,
    };
  }

  return {
    ok: false,
    required: entry.swift,
    message:
      `Swift ${swift} старше, чем нужно для SDK от Xcode ${entry.xcode}. ` +
      `SDK внутри собран компилятором ${entry.swift} и содержит синтаксис, которого ${swift} не понимает. ` +
      `Нужен Swift ${entry.swift} или новее.`,
    fix: {
      swift: entry.swift,
      ubuntu: entry.ubuntu,
      tarball: swiftTarballUrl(entry.swift, null),
    },
  };
}

/**
 * Рекомендуемая связка.
 *
 * Выбрана осознанно: Swift 6.1.3 ставится одной командой apt и уже проверен,
 * а бандл SDK, который строит xtool 1.17.0, рассчитан именно на этот SwiftPM.
 * Более свежий Xcode 26.6 тянет за собой Swift 6.4.1, с которым xtool пока
 * не работает («unable to find platform for 'iphoneos'»).
 */
const RECOMMENDED = {
  xcode: '16.4',
  iosSdk: '18',
  swift: '6.1.3',
  // Прямая ссылка на файл. Требует входа в учётную запись Apple —
  // без сессии developer.apple.com сервер отвечает перенаправлением.
  url: 'https://download.developer.apple.com/Developer_Tools/Xcode_16.4/Xcode_16.4.xip',
  needsAuth: true,
};

/** Ссылки на конкретные версии Xcode, которые мы проверяли. */
const XCODE_URLS = {
  '16.4': RECOMMENDED.url,
  '26.6': 'https://download.developer.apple.com/Developer_Tools/Xcode_26.6/Xcode_26.6_Universal.xip',
};

/**
 * Привести метаданные SDK в соответствие с компилятором.
 *
 * Сборки Swift для Linux различаются vendor-частью хост-трипа: компилятор
 * из apt-пакета сообщает x86_64-pc-linux-gnu, а бандл SDK объявляет
 * x86_64-unknown-linux-gnu. SwiftPM сравнивает трипы посимвольно и без
 * точного совпадения отказывается видеть SDK. Дописываем фактический трип.
 *
 * @param {string} infoPath путь к info.json внутри бандла SDK
 * @param {string} hostTriple трип текущего компилятора
 * @returns {{changed: boolean, triples: string[]}}
 */
function alignHostTriple(infoPath, hostTriple) {
  if (!fs.existsSync(infoPath) || !hostTriple) {
    return { changed: false, triples: [] };
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  } catch {
    return { changed: false, triples: [] };
  }

  let changed = false;
  let triples = [];

  for (const artifact of Object.values(data.artifacts || {})) {
    for (const variant of artifact.variants || []) {
      const list = variant.supportedTriples || [];
      triples = list;

      // Если совпадения нет, добавляем трип компилятора.
      if (!list.includes(hostTriple)) {
        variant.supportedTriples = [...list, hostTriple];
        triples = variant.supportedTriples;
        changed = true;
      }
    }
  }

  if (changed) {
    fs.writeFileSync(infoPath, JSON.stringify(data, null, 4), 'utf8');
  }

  return { changed, triples };
}

/** Прочитать хост-трип текущего компилятора Swift. */
async function hostTriple(options = {}) {
  const result = await wslExec.run({
    distro: options.distro || "Ubuntu",
    user: null,
    script: "swift -print-target-info 2>/dev/null | head -20",
  });

  const match = /"triple"\s*:\s*"([^"]+)"/.exec(result.output || "");
  return match ? match[1] : null;
}

/** Путь к метаданным установленного SDK. */
function sdkInfoPath() {
  return "~/.swiftpm/swift-sdks/darwin.artifactbundle/info.json";
}
module.exports = {
  alignHostTriple,
  hostTriple,
  sdkInfoPath,
  RECOMMENDED,
  XCODE_URLS,
  TOOLCHAINS,
  UBUNTU_CODENAMES,
  compareVersions,
  parseVersion,
  toolchainForXcode,
  swiftTarballUrl,
  detectXcodeVersion,
  readDeploymentTargets,
  checkCompatibility,
};
