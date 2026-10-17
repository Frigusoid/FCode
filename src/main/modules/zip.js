'use strict';
/*
 * Минимальный потоковый ZIP-writer.
 *
 * Зачем свой, а не archiver/adm-zip: .ipa обязан сохранять Unix-права внутри
 * архива. Mach-O исполняемый файл должен лежать с mode 0755, иначе installd на
 * устройстве откажется ставить приложение, а codesign на Mac сочтёт подпись
 * битой. Большинство JS-библиотек пишут external_attr = 0, и .ipa получается
 * нерабочим "молча".
 *
 * Дополнительно поддерживаются симлинки (mode 0120777, содержимое = цель).
 * Без этого разваливаются .framework, где Versions/Current -> A.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Writable } = require('stream');
const { pipeline } = require('stream/promises');
const { t } = require('../../shared/i18n');

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const VERSION_MADE_BY_UNIX = 0x031e; // Unix (3), spec 3.0
const VERSION_NEEDED = 20; // 2.0 — deflate + data descriptor

const MAX_ZIP32 = 0xffffffff - 1; // оставляем запас до 4 GiB

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32Init() {
  return -1;
}

function crc32Update(crc, buf) {
  let c = crc;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c;
}

function crc32Final(crc) {
  return (crc ^ -1) >>> 0;
}

function crc32(buf) {
  return crc32Final(crc32Update(crc32Init(), buf));
}

/** Дата в формате MS-DOS (2-секундное разрешение, эпоха 1980). */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/** Запись в файловый дескриптор по явной позиции — без гонок с потоками. */
class FdWriter {
  constructor(fd) {
    this.fd = fd;
    this.pos = 0;
  }

  write(buf) {
    let off = 0;
    while (off < buf.length) {
      off += fs.writeSync(this.fd, buf, off, buf.length - off, this.pos + off);
    }
    this.pos += buf.length;
  }

  /** Writable для pipeline(): считает записанное, чтобы знать размер сжатых данных. */
  sink(onBytes) {
    const self = this;
    return new Writable({
      write(chunk, _enc, cb) {
        try {
          self.write(chunk);
          if (onBytes) onBytes(chunk.length);
          cb();
        } catch (err) {
          cb(err);
        }
      },
    });
  }
}

class ZipWriter {
  /**
   * @param {string} outPath путь итогового архива
   * @param {{level?: number}} [options] level=0 — без сжатия (store)
   */
  constructor(outPath, options = {}) {
    this.outPath = outPath;
    this.level = options.level === undefined ? 6 : options.level;
    this.compress = this.level > 0;
    this.fd = fs.openSync(outPath, 'w');
    this.writer = new FdWriter(this.fd);
    this.entries = [];
    this.closed = false;
  }

  /**
   * @param {string} name путь внутри архива (прямые слэши, без ведущего /)
   * @param {number} mode Unix-права, напр. 0o755 / 0o644
   */
  addDirectory(name, mode = 0o755, mtime = new Date()) {
    const entryName = name.endsWith('/') ? name : `${name}/`;
    this._writeEntry({
      name: entryName,
      mode,
      isDirectory: true,
      mtime,
      data: Buffer.alloc(0),
    });
  }

  /** Добавить файл с диска потоково (память не растёт на гигабайтных файлах). */
  async addFileFromPath(name, filePath, mode, mtime) {
    const stat = fs.statSync(filePath);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(filePath);
      this.addSymlink(name, target, mtime);
      return;
    }
    if (stat.size > MAX_ZIP32) {
      throw new Error(
        t('zip.fileTooBig', { name, size: (stat.size / 2 ** 30).toFixed(2) }),
      );
    }
    await this._writeFileStreamed(name, filePath, stat, mode, mtime);
  }

  addSymlink(name, target, mtime = new Date()) {
    const data = Buffer.from(target, 'utf8');
    this._writeEntry({
      name,
      mode: 0o120777,
      isDirectory: false,
      mtime,
      data,
      store: true, // симлинки всегда без сжатия
    });
  }

  addBuffer(name, buffer, mode = 0o644, mtime = new Date()) {
    this._writeEntry({ name, mode, isDirectory: false, mtime, data: buffer });
  }

  /** Заголовок + (сжатые) данные, без центрального каталога. */
  _writeEntry({ name, mode, isDirectory, mtime, data, store = false }) {
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime(mtime);
    const useStore = store || !this.compress || data.length === 0;
    const method = useStore ? METHOD_STORE : METHOD_DEFLATE;
    const payload = useStore ? data : zlib.deflateRawSync(data, { level: this.level });
    const checksum = crc32(data);

    this._checkLimits(name, payload.length, data.length);

    // bit 3 (data descriptor) не нужен: размеры известны заранее.
    const localOffset = this.writer.pos;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    this.writer.write(header);
    this.writer.write(nameBuf);
    if (payload.length) this.writer.write(payload);

    this.entries.push({
      name: nameBuf,
      mode,
      isDirectory,
      time,
      date,
      method,
      crc: checksum,
      compressedSize: payload.length,
      uncompressedSize: data.length,
      localOffset,
    });
  }

  /** Тот же формат, но данные читаются с диска потоком. */
  async _writeFileStreamed(name, filePath, stat, mode, mtime) {
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime(mtime);
    const useStore = !this.compress || stat.size === 0;
    const method = useStore ? METHOD_STORE : METHOD_DEFLATE;

    const localOffset = this.writer.pos;

    // Пишем заголовок заранее, но с нулевыми размерами и включаем bit 3:
    // точные размеры узнаем только после прохода потока. Дескриптор допишем следом.
    const flags = 0x0008;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(0, 18);
    header.writeUInt32LE(0, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    this.writer.write(header);
    this.writer.write(nameBuf);

    let crc = crc32Init();
    let uncompressedSize = 0;
    let compressedSize = 0;

    const source = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
    source.on('data', (chunk) => {
      crc = crc32Update(crc, chunk);
      uncompressedSize += chunk.length;
    });

    const sink = this.writer.sink((n) => {
      compressedSize += n;
    });

    if (useStore) {
      await pipeline(source, sink);
    } else {
      await pipeline(source, zlib.createDeflateRaw({ level: this.level }), sink);
    }

    const checksum = crc32Final(crc);
    this._checkLimits(name, compressedSize, uncompressedSize);

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0);
    descriptor.writeUInt32LE(checksum, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(uncompressedSize, 12);
    this.writer.write(descriptor);

    this.entries.push({
      name: nameBuf,
      mode,
      isDirectory: false,
      time,
      date,
      method,
      crc: checksum,
      compressedSize,
      uncompressedSize,
      localOffset,
      usesDescriptor: true,
    });
  }

  _checkLimits(name, compressedSize, uncompressedSize) {
    if (compressedSize > MAX_ZIP32 || uncompressedSize > MAX_ZIP32) {
      throw new Error(
        t('zip.exceedsLimit', { name }),
      );
    }
  }

  /** Центральный каталог + EOCD. Обязателен в конце. */
  close() {
    if (this.closed) return;
    const cdStart = this.writer.pos;

    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(SIG_CENTRAL, 0);
      header.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
      header.writeUInt16LE(VERSION_NEEDED, 6);
      header.writeUInt16LE(entry.usesDescriptor ? 0x0008 : 0, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressedSize, 20);
      header.writeUInt32LE(entry.uncompressedSize, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(0, 30); // extra
      header.writeUInt16LE(0, 32); // comment
      header.writeUInt16LE(0, 34); // disk
      header.writeUInt16LE(0, 36); // internal attrs
      // external attrs: старшие 16 бит — Unix-режим, младший бит 0x10 — каталог
      const fileType = entry.isDirectory ? 0x10 : 0;
      // Для симлинков режим 0o120777, и сдвиг << 16 выходит за знак int32.
      // Без >>> 0 запись в буфер падает с ERR_OUT_OF_RANGE.
      header.writeUInt32LE((((entry.mode & 0xffff) << 16) | fileType) >>> 0, 38);
      header.writeUInt32LE(entry.localOffset, 42);
      this.writer.write(header);
      this.writer.write(entry.name);
    }

    const cdSize = this.writer.pos - cdStart;
    if (this.entries.length > 0xffff || cdSize > MAX_ZIP32 || cdStart > MAX_ZIP32) {
      throw new Error(t('zip.tooManyEntries'));
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    this.writer.write(eocd);

    fs.closeSync(this.fd);
    this.closed = true;
    return { entries: this.entries.length, size: this.writer.pos };
  }
}

module.exports = {
  ZipWriter,
  crc32,
  METHOD_STORE,
  METHOD_DEFLATE,
  MAX_ZIP32,
  _internal: { crc32Init, crc32Update, crc32Final, dosDateTime },
};

/** Собрать .zip из обычной папки (используется для тестов и экспорта проекта). */
async function zipDirectory(sourceDir, outPath, options = {}) {
  const writer = new ZipWriter(outPath, options);
  const root = path.resolve(sourceDir);

  const walk = async (dir, prefix) => {
    const dirents = fs.readdirSync(dir, { withFileTypes: true });
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      const name = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        writer.addSymlink(name, fs.readlinkSync(full), stat.mtime);
      } else if (stat.isDirectory()) {
        writer.addDirectory(name, stat.mode & 0o7777, stat.mtime);
        await walk(full, name);
      } else if (stat.isFile()) {
        await writer.addFileFromPath(name, full, stat.mode & 0o7777, stat.mtime);
      }
    }
  };

  await walk(root, '');
  return writer.close();
}

module.exports.zipDirectory = zipDirectory;

/**
 * Прочитать центральный каталог zip-файла.
 * Нужно для проверки готового .ipa: структура, права, наличие подписи.
 * ZIP64 здесь сознательно не поддерживается — свои архивы мы пишем без него.
 */
function readZipDirectory(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) throw new Error(t('zip.tooSmall'));

    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 <= tail.length) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw new Error(t('zip.noEocd'));

    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);

    if (cdOffset + cdSize > size) throw new Error(t('zip.cdOutOfRange'));

    const cd = Buffer.alloc(cdSize);
    if (cdSize > 0) fs.readSync(fd, cd, 0, cdSize, cdOffset);

    const entries = [];
    let p = 0;
    for (let i = 0; i < total; i += 1) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) {
        throw new Error(t('zip.corruptCd'));
      }
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compressedSize = cd.readUInt32LE(p + 20);
      const uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const externalAttr = cd.readUInt32LE(p + 38);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      const mode = (externalAttr >>> 16) & 0xffff;

      entries.push({
        name,
        mode,
        isDirectory: name.endsWith('/') || (externalAttr & 0x10) !== 0,
        isSymlink: (mode & 0o170000) === 0o120000,
        method,
        flags,
        crc,
        compressedSize,
        uncompressedSize,
        localOffset,
      });

      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports.readZipDirectory = readZipDirectory;

/**
 * Распаковать zip-архив.
 *
 * Нужно, чтобы открывать .xcarchive, скачанный одним zip-файлом. Внешних
 * библиотек не требуем: заголовки читаем сами, данные разворачиваем через zlib.
 *
 * Отдельная тонкость — символические ссылки. Внутри .framework их обычно
 * несколько (Versions/Current -> A). Windows без специальных прав symlink не
 * создаёт, поэтому при неудаче ссылка материализуется копией: функционально
 * фреймворк остаётся целым. Ссылки делаются вторым проходом — цель может
 * находиться в архиве позже самой ссылки.
 *
 * @param {string} zipPath путь к архиву
 * @param {string} destDir куда распаковать
 * @returns {{files: number, directories: number, symlinks: number, copied: number}}
 */
function extractZip(zipPath, destDir) {
  const entries = readZipDirectory(zipPath);
  const fd = fs.openSync(zipPath, 'r');

  const stats = { files: 0, directories: 0, symlinks: 0, copied: 0 };
  const links = [];

  const targetFor = (name) => path.join(destDir, name.replace(/\//g, path.sep));

  try {
    for (const entry of entries) {
      const target = targetFor(entry.name);

      if (entry.isDirectory) {
        fs.mkdirSync(target, { recursive: true });
        stats.directories += 1;
        continue;
      }

      // Данные лежат сразу за локальным заголовком, длины имени и extra
      // в нём могут отличаться от центрального каталога.
      const header = Buffer.alloc(30);
      fs.readSync(fd, header, 0, 30, entry.localOffset);
      const nameLength = header.readUInt16LE(26);
      const extraLength = header.readUInt16LE(28);
      const dataOffset = entry.localOffset + 30 + nameLength + extraLength;

      let data = Buffer.alloc(0);
      if (entry.compressedSize > 0) {
        const raw = Buffer.alloc(entry.compressedSize);
        fs.readSync(fd, raw, 0, entry.compressedSize, dataOffset);
        if (entry.method === METHOD_STORE) data = raw;
        else if (entry.method === METHOD_DEFLATE) data = zlib.inflateRawSync(raw);
        else throw new Error(`Неподдерживаемый метод сжатия: ${entry.method} (${entry.name})`);
      }

      if (entry.isSymlink) {
        links.push({ target, linkTarget: data.toString('utf8') });
        stats.symlinks += 1;
        continue;
      }

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      stats.files += 1;
    }

    // Второй проход: ссылки, когда все цели уже на месте.
    for (const { target, linkTarget } of links) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const resolved = path.resolve(path.dirname(target), linkTarget);
      try {
        fs.symlinkSync(linkTarget, target, fs.statSync(resolved).isDirectory() ? 'dir' : 'file');
      } catch {
        // Нет прав на symlink — копируем, чтобы фреймворк остался рабочим.
        if (!fs.existsSync(resolved)) continue;
        if (fs.statSync(resolved).isDirectory()) fs.cpSync(resolved, target, { recursive: true });
        else fs.copyFileSync(resolved, target);
        stats.copied += 1;
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return stats;
}

module.exports.extractZip = extractZip;
