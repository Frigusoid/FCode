'use strict';
/*
 * Зеркало проекта внутри файловой системы Linux.
 *
 * Зачем это нужно. Проекты лежат на дисках Windows (C:, D:), а внутри WSL они
 * видны как монтирование 9p (/mnt/c, /mnt/d). SwiftPM через 9p работать не
 * может: он падает на блокировке файла состояния сборки —
 *
 *   error: invalid access to /tmp/_mnt_c_..._workspace-state.json.lock
 *
 * Проверено: тот же код внутри файловой системы Linux собирается без нареканий.
 * Поэтому перед сборкой проект копируется в ~/fcode-build/<ключ>, собирается
 * там, а пути в сообщениях компилятора переводятся обратно в формат Windows —
 * чтобы ошибки открывались в редакторе по правильным файлам.
 *
 * Копирование идёт через tar: он есть всегда, в отличие от rsync.
 */

const crypto = require('crypto');
const path = require('path');
const wslExec = require('./wsl-exec');

/**
 * Каталог зеркал.
 *
 * Именно /tmp, а не домашний каталог: он доступен и внутри Linux, и с Windows
 * по UNC-пути \\wsl$\<дистрибутив>\tmp\..., что понадобится языковому серверу.
 */
const MIRROR_ROOT = '/tmp/fcode-build';

/** Короткий устойчивый ключ по пути проекта — чтобы зеркала не смешивались. */
function mirrorKey(windowsPath) {
  return crypto.createHash('sha1').update(path.resolve(windowsPath)).digest('hex').slice(0, 12);
}

/** Windows-путь -> путь внутри WSL (/mnt/...). */
function toWslPath(windowsPath) {
  const resolved = path.resolve(windowsPath);
  const match = /^([A-Za-z]):\\(.*)$/.exec(resolved);
  if (!match) return resolved.replace(/\\/g, '/');
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

/**
 * Скопировать проект в зеркало.
 *
 * @param {{windowsPath: string, distro?: string, onOutput?: Function}} options
 * @returns {Promise<{mirrorPath: string, sourcePath: string, key: string}>}
 */
async function sync(options) {
  const distro = options.distro || 'Ubuntu';
  const source = toWslPath(options.windowsPath);
  const key = mirrorKey(options.windowsPath);

  // Пути передаём в base64: в имени папки может оказаться обратный апостроф,
  // $ или кавычка, и тогда bash истолкует их как часть команды.
  const source64 = Buffer.from(source, 'utf8').toString('base64');
  const dest64 = Buffer.from(`${MIRROR_ROOT}/${key}`, 'utf8').toString('base64');

  const script = `
set -e
SRC=$(printf %s '${source64}' | base64 -d)
DEST=$(printf %s '${dest64}' | base64 -d)

if [ ! -d "$SRC" ]; then
  echo "MIRROR_ERROR: исходный каталог недоступен: $SRC" >&2
  exit 2
fi

mkdir -p "$DEST"
rm -rf "$DEST"/* "$DEST"/.[!.]* 2>/dev/null || true

# .build и .git не копируем: первый — артефакты, второй не нужен для сборки.
cd "$SRC"
tar --exclude=./.build --exclude=./.git --exclude=./.swiftpm --exclude=./DerivedData -cf - . \\
  | (cd "$DEST" && tar -xf -)

echo "MIRROR_PATH=$DEST"
`;

  const result = await wslExec.run({ distro, script, onOutput: options.onOutput });
  if (!result.ok) {
    throw new Error(
      result.output.includes('MIRROR_ERROR')
        ? result.output.split('MIRROR_ERROR:')[1].trim().split('\n')[0]
        : `не удалось подготовить зеркало проекта`,
    );
  }

  const match = /MIRROR_PATH=(.+)/.exec(result.output);
  if (!match) throw new Error('не удалось определить путь зеркала');

  return { mirrorPath: match[1].trim(), sourcePath: source, key };
}

/**
 * Перевести путь внутри зеркала обратно в путь Windows.
 * Если путь не из зеркала, возвращается как есть.
 */
function mirrorToWindows(mirrorPathValue, mirrorRoot, windowsProjectPath) {
  const normalizedMirror = mirrorPathValue.replace(/\/+$/, '');
  const normalizedRoot = String(mirrorRoot).replace(/\/+$/, '');

  if (!normalizedMirror.startsWith(normalizedRoot)) return mirrorPathValue;

  const relative = normalizedMirror.slice(normalizedRoot.length).replace(/^\/+/, '');
  const projectRoot = path.resolve(windowsProjectPath);
  if (!relative) return projectRoot;

  return path.join(projectRoot, relative.replace(/\//g, path.sep));
}

module.exports = { sync, mirrorKey, mirrorToWindows, toWslPath, MIRROR_ROOT };
