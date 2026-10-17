'use strict';
/*
 * Помощники для тестов.
 *
 * Ключевая идея: эталонные значения готовит Python (plistlib, zipfile), а не наш
 * код. Иначе тест проверял бы нашу реализацию нашей же реализацией. Так мы
 * независимо подтверждаем и разбор бинарного plist, и — что важнее всего —
 * что Unix-права (0755 на исполняемом файле) действительно записаны в .ipa.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PYTHON = process.env.FCODE_PYTHON || 'python';

// Windows-консоль по умолчанию cp1251, и Python падает на выводе эмодзи/кириллицы.
// Дочерние процессы наследуют переменные окружения, поэтому достаточно выставить здесь.
process.env.PYTHONIOENCODING = 'utf-8';

function makeTempDir(prefix = 'fcode-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

/**
 * Записать plist в бинарном формате (bplist00) через Python plistlib.
 * Специальные ключи для типов, которых нет в JSON:
 *   {"__bytes__": "<base64>"} и {"__date__": "<iso без таймзоны>"}
 */
function writeBinaryPlistViaPython(target, value) {
  const jsonPath = `${target}.input.json`;
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(value), 'utf8');

  const script = `
import base64, datetime, json, plistlib, sys

def dec(o):
    if isinstance(o, dict):
        if '__bytes__' in o and len(o) == 1:
            return base64.b64decode(o['__bytes__'])
        if '__date__' in o and len(o) == 1:
            return datetime.datetime.fromisoformat(o['__date__'])
        return {k: dec(v) for k, v in o.items()}
    if isinstance(o, list):
        return [dec(v) for v in o]
    return o

with open(sys.argv[1], 'r', encoding='utf-8') as f:
    data = json.load(f)
with open(sys.argv[2], 'wb') as f:
    plistlib.dump(dec(data), f, fmt=plistlib.FMT_BINARY, sort_keys=False)
`;
  execFileSync(PYTHON, ['-c', script, jsonPath, target], { stdio: 'pipe' });
  fs.unlinkSync(jsonPath);
  return fs.readFileSync(target);
}

/**
 * Прочитать plist через Python и привести к сравнимому виду:
 * bytes -> {"__bytes__": base64}, datetime -> {"__date_ms__": epoch_ms}.
 */
function readPlistViaPython(target) {
  const script = `
import base64, datetime, json, plistlib, sys

def enc(o):
    if isinstance(o, bytes):
        return {'__bytes__': base64.b64encode(o).decode()}
    if isinstance(o, datetime.datetime):
        if o.tzinfo is None:
            o = o.replace(tzinfo=datetime.timezone.utc)
        return {'__date_ms__': int(o.timestamp() * 1000)}
    if isinstance(o, dict):
        return {k: enc(v) for k, v in o.items()}
    if isinstance(o, list):
        return [enc(v) for v in o]
    return o

with open(sys.argv[1], 'rb') as f:
    data = plistlib.load(f)
print(json.dumps(enc(data), ensure_ascii=False))
`;
  const out = execFileSync(PYTHON, ['-c', script, target], { encoding: 'utf8' });
  return JSON.parse(out);
}

/** Привести значение нашего парсера к тому же виду, что выдаёт readPlistViaPython. */
function normalizeOurs(value) {
  if (Buffer.isBuffer(value)) return { __bytes__: value.toString('base64') };
  if (value instanceof Date) return { __date_ms__: value.getTime() };
  if (Array.isArray(value)) return value.map(normalizeOurs);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = normalizeOurs(value[key]);
    return out;
  }
  return value;
}

/**
 * Оглавление .ipa глазами Python zipfile: имя, Unix-права, размеры.
 * Это независимая проверка того, что права попали в архив.
 */
function inspectIpaViaPython(ipaPath) {
  const script = `
import json, sys, zipfile
out = []
with zipfile.ZipFile(sys.argv[1]) as z:
    for info in z.infolist():
        out.append({
            'name': info.filename,
            'mode': (info.external_attr >> 16) & 0xFFFF,
            'isDir': info.is_dir(),
            'size': info.file_size,
            'compressSize': info.compress_size,
            'crc': info.CRC,
        })
print(json.dumps(out))
`;
  const out = execFileSync(PYTHON, ['-c', script, ipaPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/** Проверить CRC всех записей архива через Python. */
function testZipViaPython(ipaPath) {
  const script = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
print('OK' if bad is None else 'BAD:' + str(bad))
`;
  return execFileSync(PYTHON, ['-c', script, ipaPath], { encoding: 'utf8' }).trim();
}

/** Извлечь одну запись архива через Python — независимая распаковка. */
function extractEntryViaPython(ipaPath, entryName, destPath) {
  const script = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    with z.open(sys.argv[2]) as src, open(sys.argv[3], 'wb') as dst:
        dst.write(src.read())
`;
  execFileSync(PYTHON, ['-c', script, ipaPath, entryName, destPath], { stdio: 'pipe' });
  return fs.readFileSync(destPath);
}

/** Создать файл с сигнатурой Mach-O (fat binary) — для проверки прав 0755. */
function writeFakeMachO(target, payloadSize = 512) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const header = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
  const body = Buffer.alloc(payloadSize, 0x41);
  fs.writeFileSync(target, Buffer.concat([header, body]));
  return target;
}

function writeFile(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

/** Есть ли Python с нужными модулями. */
function pythonAvailable() {
  try {
    execFileSync(PYTHON, ['-c', 'import plistlib, zipfile, json, base64, datetime'], {
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  PYTHON,
  makeTempDir,
  rmrf,
  writeBinaryPlistViaPython,
  readPlistViaPython,
  normalizeOurs,
  inspectIpaViaPython,
  testZipViaPython,
  extractEntryViaPython,
  writeFakeMachO,
  writeFile,
  pythonAvailable,
};
