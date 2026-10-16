'use strict';
/*
 * Определение дистрибутива Linux и выбор подходящей сборки Swift.
 *
 * Смысл модуля — не зависеть от конкретной версии Ubuntu. Всё, что раньше было
 * таблицей «версия → ссылка», теперь вычисляется:
 *
 *   1. определяем, что за дистрибутив и какая версия;
 *   2. если в его репозитории есть пакет swiftlang — ставим пакетом (самый
 *      надёжный путь, работает на любой версии, где пакет есть);
 *   3. иначе запрашиваем у swift.org список всех релизов и выбираем НОВЕЙШИЙ
 *      релиз, у которого есть сборка для Ubuntu не новее нашей. Сборка под
 *      старую версию работает на новой (glibc совместима снизу вверх),
 *      а обратное — нет, поэтому именно «не новее».
 *
 * Так поддерживаются и будущие версии Ubuntu, о которых мы ещё не знаем.
 */

const wslExec = require('./wsl-exec');

const SWIFT_RELEASES_URL = 'https://www.swift.org/api/v1/install/releases.json';
const MIN_SWIFT = [6, 1, 0];

/** Разобрать «Ubuntu 24.04» в числа. */
function parseUbuntuName(name) {
  const match = /^Ubuntu\s+(\d+)\.(\d+)/i.exec(String(name || '').trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return {
    major,
    minor,
    // Удобное сравнение: 24.04 -> 2404
    key: major * 100 + minor,
    // Ведущий ноль значим: «24.04», а не «24.4».
    label: `${major}.${String(minor).padStart(2, '0')}`,
  };
}

/** Сравнить версии вида «6.1.3». */
function compareVersions(a, b) {
  const left = String(a).split('.').map((part) => parseInt(part, 10) || 0);
  const right = String(b).split('.').map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Собрать ссылку на официальный тулчейн. */
function buildSwiftUrl(tag, ubuntu) {
  // Каталог без точки (ubuntu2404), имя файла с точкой (ubuntu24.04) —
  // так устроен сайт swift.org, и это надо повторить точно.
  const dir = `ubuntu${ubuntu.major}${String(ubuntu.minor).padStart(2, '0')}`;
  const file = `ubuntu${ubuntu.major}.${String(ubuntu.minor).padStart(2, '0')}`;
  return `https://download.swift.org/${tag.toLowerCase()}/${dir}/${tag}/${tag}-${file}.tar.gz`;
}

/**
 * Выбрать сборку Swift для конкретной версии Ubuntu.
 *
 * @param {Array} releases содержимое SWIFT_RELEASES_URL
 * @param {{versionId: string, arch?: string, minVersion?: string}} target
 * @returns {{tag: string, version: string, platformName: string, url: string, exact: boolean}|null}
 */
function pickSwiftBuild(releases, target) {
  const wanted = parseUbuntuName(`Ubuntu ${target.versionId}`);
  if (!wanted) return null;

  const arch = target.arch || 'x86_64';
  const minVersion = target.minVersion || MIN_SWIFT.join('.');
  const candidates = [];

  for (const release of releases || []) {
    if (compareVersions(release.name, minVersion) < 0) continue;

    for (const platform of release.platforms || []) {
      if (platform.platform !== 'Linux') continue;
      const ubuntu = parseUbuntuName(platform.name);
      if (!ubuntu) continue;
      // Сборка для более новой Ubuntu на нашей не заработает.
      if (ubuntu.key > wanted.key) continue;
      if (Array.isArray(platform.archs) && !platform.archs.includes(arch)) continue;

      candidates.push({
        release,
        ubuntu,
        platform,
        exact: ubuntu.key === wanted.key,
      });
    }
  }

  if (candidates.length === 0) return null;

  // Сначала самый новый релиз, при равенстве — самая близкая версия Ubuntu.
  candidates.sort((a, b) => {
    const byVersion = compareVersions(b.release.name, a.release.name);
    if (byVersion !== 0) return byVersion;
    return b.ubuntu.key - a.ubuntu.key;
  });

  const best = candidates.find((item) => item.exact) || candidates[0];

  return {
    tag: best.release.tag,
    version: best.release.name,
    platformName: best.platform.name,
    url: buildSwiftUrl(best.release.tag, best.ubuntu),
    exact: best.exact,
  };
}

/** Запросить список релизов у swift.org. */
async function fetchSwiftReleases(timeout = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(SWIFT_RELEASES_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`swift.org ответил ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Узнать, что за дистрибутив установлен.
 * Возвращает данные, по которым принимаются все дальнейшие решения.
 */
async function detect(distro) {
  const script = `
set -e
. /etc/os-release 2>/dev/null || true
echo "ID=$ID"
echo "VERSION_ID=$VERSION_ID"
echo "VERSION_CODENAME=$VERSION_CODENAME"
echo "PRETTY=$PRETTY_NAME"
echo "ARCH=$(uname -m)"
echo "WSL_VERSION=$WSL_DISTRO_NAME"
if grep -qi microsoft /proc/version 2>/dev/null; then
  if [ -e /dev/vsock ] || [ -d /run/WSL ]; then echo "WSL=2"; else echo "WSL=1"; fi
else
  echo "WSL=0"
fi
# FUSE нужен для запуска AppImage; в WSL его обычно нет
if [ -e /dev/fuse ]; then echo "FUSE=yes"; else echo "FUSE=no"; fi
command -v apt-get >/dev/null 2>&1 && echo "APT=yes" || echo "APT=no"
`;

  const result = await wslExec.run({ distro, script });
  const values = {};
  for (const line of result.output.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }

  const ubuntu = parseUbuntuName(`Ubuntu ${values.VERSION_ID || ''}`);

  return {
    reachable: result.ok || Boolean(values.ID),
    id: values.ID || null,
    versionId: values.VERSION_ID || null,
    codename: values.VERSION_CODENAME || null,
    prettyName: values.PRETTY || null,
    arch: values.ARCH || 'x86_64',
    wslVersion: values.WSL ? Number(values.WSL) : null,
    hasFuse: values.FUSE === 'yes',
    hasApt: values.APT === 'yes',
    isUbuntu: (values.ID || '').toLowerCase() === 'ubuntu',
    isDebianLike: ['ubuntu', 'debian', 'pop', 'linuxmint', 'zorin'].includes(
      (values.ID || '').toLowerCase(),
    ),
    ubuntuVersion: ubuntu ? ubuntu.label : null,
    // Предупреждения, которые интерфейс показывает пользователю.
    warnings: [
      values.WSL === '1'
        ? 'WSL1 не поддерживает USB и usbmuxd — нужен WSL2 (wsl --set-version <дистрибутив> 2)'
        : null,
      (values.ID || '').toLowerCase() !== 'ubuntu'
        ? `Дистрибутив «${values.PRETTY || values.ID}» не Ubuntu — установка Swift может потребовать ручных шагов`
        : null,
      values.FUSE !== 'yes' ? 'FUSE недоступен — AppImage будет распакован, а не запущен напрямую' : null,
    ].filter(Boolean),
  };
}

/**
 * Решить, как ставить Swift, и подготовить всё для установки.
 * @returns {{method: 'apt'|'tarball'|'none', url?: string, version?: string, note: string}}
 */
async function resolveSwift(distro) {
  const info = await detect(distro);

  // 1. Пакет из репозитория — самый надёжный путь и не зависит от версии.
  const apt = await wslExec.probe(
    distro,
    'apt-cache show swiftlang >/dev/null 2>&1 && echo YES || echo NO',
  );
  if (info.hasApt && /YES/.test(apt.output)) {
    return {
      method: 'apt',
      version: null,
      note: 'Пакет swiftlang есть в репозитории дистрибутива',
      distro: info,
    };
  }

  if (!info.isUbuntu) {
    return {
      method: 'none',
      note: `Автоматическая установка Swift поддерживается только для Ubuntu, а установлен «${info.prettyName || info.id}»`,
      distro: info,
    };
  }

  // 2. Официальный тулчейн — версию подбираем по списку релизов.
  try {
    const releases = await fetchSwiftReleases();
    const build = pickSwiftBuild(releases, {
      versionId: info.versionId,
      arch: info.arch,
    });

    if (!build) {
      return {
        method: 'none',
        note: `Для Ubuntu ${info.versionId} (${info.arch}) нет подходящей сборки Swift`,
        distro: info,
      };
    }

    return {
      method: 'tarball',
      url: build.url,
      version: build.version,
      note: build.exact
        ? `Официальная сборка Swift ${build.version} для ${build.platformName}`
        : `Для Ubuntu ${info.versionId} отдельной сборки нет — беру Swift ${build.version} для ${build.platformName} (сборки для более старых версий работают на новых)`,
      distro: info,
    };
  } catch (error) {
    return {
      method: 'none',
      note: `Не удалось получить список релизов Swift: ${error.message}`,
      distro: info,
    };
  }
}

module.exports = {
  detect,
  resolveSwift,
  pickSwiftBuild,
  parseUbuntuName,
  buildSwiftUrl,
  compareVersions,
  fetchSwiftReleases,
  SWIFT_RELEASES_URL,
  MIN_SWIFT,
};
