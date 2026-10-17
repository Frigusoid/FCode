'use strict';
/*
 * zsign — подпись .ipa прямо на Windows, без Mac.
 *
 * Зачем это нужно. Сборка через xtool выдаёт приложение, подписанное сертификатом
 * разработчика: такой .ipa поставится только на устройства из профиля и только
 * пока профиль жив (у бесплатного Apple ID — 7 дней). Чтобы поставить сборку
 * на своё устройство или поделиться ею, нужна переподпись своим сертификатом.
 *
 * zsign (github.com/zhlynn/zsign) умеет это делать на разных платформах, и для
 * Windows у него есть готовый исполняемый файл. Компилировать ничего не нужно:
 * скачиваем архив нужной платформы и распаковываем в папку данных FCode.
 *
 * Что важно:
 *   - подписывать чужие приложения своим сертификатом можно только с разрешения
 *     правообладателя; FCode не проверяет это за пользователя;
 *   - пароль от сертификата хранится только в памяти на время подписи.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const https = require('node:https');

const { extractZip } = require('./zip');

/** Где искать готовые сборки zsign. */
const RELEASE_API = 'https://api.github.com/repos/zhlynn/zsign/releases/latest';

/** Имя исполняемого файла на текущей платформе. */
function binaryName() {
  return process.platform === 'win32' ? 'zsign.exe' : 'zsign';
}

/** Какой файл релиза подходит этой системе. */
function assetPattern() {
  if (process.platform === 'win32') return /win.*x64.*\.zip$/i;
  if (process.platform === 'darwin') return /macos.*\.tar\.gz$/i;
  return /linux-x86_64\.tar\.gz$/i;
}

/** Папка, куда FCode складывает скачанные инструменты. */
function toolsDir(userDataPath) {
  return path.join(userDataPath || path.join(os.homedir(), '.fcode'), 'tools', 'zsign');
}

/** Путь к исполняемому файлу zsign. */
function binaryPath(userDataPath) {
  return path.join(toolsDir(userDataPath), binaryName());
}

/**
 * Проверить, установлен ли zsign.
 * @returns {{available: boolean, path: string|null, version: string|null, source: string}}
 */
function check(userDataPath) {
  const bundled = binaryPath(userDataPath);
  const candidates = [
    { file: bundled, source: 'fcode' },
    { file: path.join(toolsDir(userDataPath), 'zsign'), source: 'fcode' },
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate.file)) {
      return { available: true, path: candidate.file, version: null, source: candidate.source };
    }
  }

  // Иногда zsign уже стоит в системе — тогда свой скачивать не нужно.
  const fromPath = process.env.PATH.split(path.delimiter)
    .map((dir) => path.join(dir, binaryName()))
    .find((file) => {
      try {
        return fs.existsSync(file);
      } catch {
        return false;
      }
    });

  if (fromPath) return { available: true, path: fromPath, version: null, source: 'system' };

  return { available: false, path: null, version: null, source: 'none' };
}

/** Скачать файл по ссылке. */
function download(url, destination, onProgress) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'FCode', Accept: 'application/octet-stream' } },
      (response) => {
        // GitHub отвечает перенаправлением на хранилище артефактов.
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          download(response.headers.location, destination, onProgress).then(resolve, reject);
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Сервер вернул код ${response.statusCode}`));
          return;
        }

        const total = Number(response.headers['content-length'] || 0);
        let received = 0;
        const file = fs.createWriteStream(destination);

        response.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total) onProgress(Math.round((received / total) * 100));
        });

        response.pipe(file);
        file.on('finish', () => file.close(() => resolve(destination)));
        file.on('error', reject);
      },
    );

    request.on('error', reject);
    request.setTimeout(120000, () => request.destroy(new Error('истекло время ожидания')));
  });
}

/** Узнать у GitHub последнюю версию и ссылку на нужный файл. */
function findAsset() {
  return new Promise((resolve, reject) => {
    const request = https.get(
      RELEASE_API,
      { headers: { 'User-Agent': 'FCode', Accept: 'application/vnd.github+json' } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`GitHub вернул код ${response.statusCode}`));
          return;
        }

        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            const release = JSON.parse(body);
            const pattern = assetPattern();
            const asset = (release.assets || []).find((item) => pattern.test(item.name));

            if (!asset) {
              reject(new Error(`в релизе ${release.tag_name} нет сборки для этой системы`));
              return;
            }

            resolve({ tag: release.tag_name, name: asset.name, url: asset.browser_download_url });
          } catch (error) {
            reject(new Error(`не удалось разобрать ответ GitHub: ${error.message}`));
          }
        });
      },
    );

    request.on('error', reject);
    request.setTimeout(60000, () => request.destroy(new Error('истекло время ожидания')));
  });
}

/**
 * Скачать и распаковать zsign.
 *
 * @param {{userDataPath?: string, onOutput?: Function}} options
 * @returns {Promise<{ok: boolean, path: string, version: string}>}
 */
async function install(options = {}) {
  const log = options.onOutput || (() => {});
  const target = toolsDir(options.userDataPath);

  fs.mkdirSync(target, { recursive: true });

  log(`Ищу последнюю версию zsign…\n`);
  const asset = await findAsset();
  log(`Найдена версия ${asset.tag}: ${asset.name}\n`);

  const archive = path.join(os.tmpdir(), `fcode-${asset.name}`);
  log(`Скачиваю ${asset.name}…\n`);

  let lastPercent = -1;
  await download(asset.url, archive, (percent) => {
    if (percent !== lastPercent && percent % 20 === 0) {
      lastPercent = percent;
      log(`  ${percent}%\n`);
    }
  });

  log(`Распаковываю…\n`);

  if (/\.zip$/i.test(asset.name)) {
    extractZip(archive, target);

    // Внутри архива может быть подпапка — поднимаем файлы наверх.
    const nested = path.join(target, asset.name.replace(/\.zip$/i, ''));
    if (fs.existsSync(nested)) {
      for (const entry of fs.readdirSync(nested)) {
        fs.renameSync(path.join(nested, entry), path.join(target, entry));
      }
      fs.rmSync(nested, { recursive: true, force: true });
    }
  } else {
    // tar.gz распаковываем системным tar: он есть и в Windows 10+, и в Linux.
    await new Promise((resolve, reject) => {
      execFile('tar', ['-xzf', archive, '-C', target], (error) => {
        if (error) reject(new Error(`не удалось распаковать архив: ${error.message}`));
        else resolve();
      });
    });
  }

  fs.rmSync(archive, { force: true });

  const binary = binaryPath(options.userDataPath);
  if (!fs.existsSync(binary)) {
    // Иногда имя внутри архива другое — ищем любой исполняемый файл.
    const found = fs
      .readdirSync(target)
      .find((name) => /^zsign(\.exe)?$/i.test(name));

    if (!found) throw new Error('в архиве не найден исполняемый файл zsign');
    return { ok: true, path: path.join(target, found), version: asset.tag };
  }

  // На Linux файлу нужен бит выполнения.
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(binary, 0o755);
    } catch {
      /* не критично */
    }
  }

  log(`zsign ${asset.tag} установлен: ${binary}\n`);
  return { ok: true, path: binary, version: asset.tag };
}

/**
 * Переподписать .ipa своим сертификатом.
 *
 * @param {{ipaPath: string, p12Path: string, provisionPath: string,
 *          password?: string, outputPath?: string, bundleId?: string,
 *          userDataPath?: string, onOutput?: Function}} options
 */
async function resign(options) {
  const tool = options.toolPath || check(options.userDataPath).path;
  if (!tool) throw new Error('zsign не установлен');

  if (!options.ipaPath || !fs.existsSync(options.ipaPath)) {
    throw new Error(`не найден файл .ipa: ${options.ipaPath}`);
  }
  if (!options.p12Path || !fs.existsSync(options.p12Path)) {
    throw new Error('не найден сертификат .p12');
  }
  if (!options.provisionPath || !fs.existsSync(options.provisionPath)) {
    throw new Error('не найден профиль .mobileprovision');
  }

  const output =
    options.outputPath ||
    path.join(
      path.dirname(options.ipaPath),
      `${path.basename(options.ipaPath, '.ipa')}-signed.ipa`,
    );

  const args = [
    '-k', options.p12Path,
    '-p', options.password || '',
    '-m', options.provisionPath,
    '-o', output,
  ];

  if (options.bundleId) args.push('-b', options.bundleId);
  // -z — сжатие уровня 9, -2 — подпись в формате SHA256.
  args.push('-z', '9', options.ipaPath);

  const result = await new Promise((resolve) => {
    execFile(tool, args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? error.code || 1 : 0,
        output: `${stdout || ''}${stderr || ''}`,
        error: error ? error.message : null,
      });
    });
  });

  if (options.onOutput) options.onOutput(result.output);

  return { ...result, outputPath: output };
}

/** Краткая справка zsign — для окна «о инструменте». */
async function version(userDataPath) {
  const tool = check(userDataPath).path;
  if (!tool) return null;

  return new Promise((resolve) => {
    execFile(tool, ['-v'], { timeout: 15000 }, (error, stdout) => {
      resolve(error ? null : String(stdout || '').trim());
    });
  });
}

module.exports = {
  check,
  install,
  resign,
  version,
  binaryPath,
  toolsDir,
  findAsset,
  assetPattern,
  RELEASE_API,
};
