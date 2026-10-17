'use strict';
/*
 * Чтение/запись plist: binary (bplist00) и XML.
 *
 * Понадобилось потому, что Info.plist внутри уже собранного .app почти всегда
 * бинарный, а из него нужно достать CFBundleIdentifier / CFBundleExecutable /
 * MinimumOSVersion, чтобы правильно собрать Payload и проверить .ipa.
 * Внешние пакеты не тянем — формат маленький и стабильный.
 */

const fs = require('fs');
const { t } = require('../../shared/i18n');

const BPLIST_MAGIC = 'bplist00';
const APPLE_EPOCH_OFFSET = 978307200; // 2001-01-01 относительно Unix epoch

// ---------------------------------------------------------------- binary plist

const BPLIST_TYPES = {
  NULL: 0x0,
  FALSE: 0x08,
  TRUE: 0x09,
  FILL: 0x0f,
  INT: 0x1,
  REAL: 0x2,
  DATE: 0x3,
  DATA: 0x4,
  ASCII: 0x5,
  UTF16: 0x6,
  UID: 0x8,
  ARRAY: 0xa,
  SET: 0xc,
  DICT: 0xd,
};

function parseBinaryPlist(buffer) {
  if (buffer.length < 40 || buffer.toString('latin1', 0, 8) !== BPLIST_MAGIC) {
    throw new Error(t('plist.notBinary'));
  }

  // Trailer — последние 32 байта файла.
  const trailer = buffer.subarray(buffer.length - 32);
  const offsetIntSize = trailer.readUInt8(6);
  const objectRefSize = trailer.readUInt8(7);
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const offsetTableOffset = Number(trailer.readBigUInt64BE(24));

  if (offsetIntSize < 1 || offsetIntSize > 8) throw new Error(t('plist.badOffsetSize'));

  const readSizedInt = (buf, pos, size) => {
    let value = 0;
    for (let i = 0; i < size; i += 1) value = value * 256 + buf[pos + i];
    return value;
  };

  const offsets = new Array(numObjects);
  for (let i = 0; i < numObjects; i += 1) {
    offsets[i] = readSizedInt(buffer, offsetTableOffset + i * offsetIntSize, offsetIntSize);
  }

  const cache = new Map();

  function parseObject(index) {
    if (index < 0 || index >= numObjects) throw new Error(t('plist.badObjectRef', { index }));
    if (cache.has(index)) return cache.get(index);

    const pos = offsets[index];
    const marker = buffer.readUInt8(pos);
    const type = marker >> 4;
    let length = marker & 0x0f;
    let cursor = pos + 1;

    // 0xF в младшем полубайте = длина записана отдельным целым следом.
    // У типа 0x0 (null/true/false/fill) полезной нагрузки нет — длину не читаем.
    if (length === 0x0f && type !== BPLIST_TYPES.NULL) {
      const lengthMarker = buffer.readUInt8(cursor);
      const intSize = 1 << (lengthMarker & 0x0f);
      length = readSizedInt(buffer, cursor + 1, intSize);
      cursor += 1 + intSize;
    }

    let value;
    switch (type) {
      case BPLIST_TYPES.NULL:
        // 0x08/0x09 — это МАРКЕРЫ целиком, а не типы: тип у них общий, 0x0.
        // Различать нужно по полному байту маркера, иначе true/false читаются как null.
        if (marker === 0x08) value = false;
        else if (marker === 0x09) value = true;
        else value = null;
        break;
      case BPLIST_TYPES.INT: {
        const intSize = 1 << length;
        // Старший бит выставлен — число отрицательное (two's complement).
        // Для 8-байтовых значений арифметика в Number теряет точность (2^64
        // не представимо), поэтому считаем через BigInt и сужаем к Number,
        // только если результат безопасен.
        if (intSize <= 6) {
          value = readSizedInt(buffer, cursor, intSize);
          if (buffer.readUInt8(cursor) & 0x80) value -= 2 ** (intSize * 8);
        } else {
          let big = 0n;
          for (let i = 0; i < intSize; i += 1) big = (big << 8n) | BigInt(buffer[cursor + i]);
          if (buffer.readUInt8(cursor) & 0x80) big -= 1n << BigInt(intSize * 8);
          value =
            big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(big)
              : big;
        }
        break;
      }
      case BPLIST_TYPES.REAL: {
        const realSize = 1 << length;
        value = realSize === 4 ? buffer.readFloatBE(cursor) : buffer.readDoubleBE(cursor);
        break;
      }
      case BPLIST_TYPES.DATE: {
        const seconds = buffer.readDoubleBE(cursor);
        value = new Date((seconds + APPLE_EPOCH_OFFSET) * 1000);
        break;
      }
      case BPLIST_TYPES.DATA:
        value = Buffer.from(buffer.subarray(cursor, cursor + length));
        break;
      case BPLIST_TYPES.ASCII:
        value = buffer.toString('utf8', cursor, cursor + length);
        break;
      case BPLIST_TYPES.UTF16:
        // Node умеет только utf16le, в plist же порядок big-endian:
        // копируем байты (subarray делит память!) и меняем порядок в каждой паре.
        value = Buffer.from(buffer.subarray(cursor, cursor + length * 2))
          .swap16()
          .toString('utf16le');
        break;
      case BPLIST_TYPES.UID: {
        const uidSize = length + 1;
        value = readSizedInt(buffer, cursor, uidSize);
        break;
      }
      case BPLIST_TYPES.ARRAY:
      case BPLIST_TYPES.SET: {
        const arr = [];
        cache.set(index, arr); // защита от циклов
        for (let i = 0; i < length; i += 1) {
          const ref = readSizedInt(buffer, cursor + i * objectRefSize, objectRefSize);
          arr.push(parseObject(ref));
        }
        value = arr;
        break;
      }
      case BPLIST_TYPES.DICT: {
        const dict = {};
        cache.set(index, dict);
        for (let i = 0; i < length; i += 1) {
          const keyRef = readSizedInt(buffer, cursor + i * objectRefSize, objectRefSize);
          const valRef = readSizedInt(
            buffer,
            cursor + (length + i) * objectRefSize,
            objectRefSize,
          );
          dict[String(parseObject(keyRef))] = parseObject(valRef);
        }
        value = dict;
        break;
      }

      default:
        throw new Error(t('plist.unknownType', { type: type.toString(16) }));
    }

    cache.set(index, value);
    return value;
  }

  const root = parseObject(topObject);
  return { format: 'binary', value: root };
}

// ------------------------------------------------------------------- XML plist

const XML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXmlEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(XML_ENTITIES, entity) ? XML_ENTITIES[entity] : match;
  });
}

function parseXmlPlist(text) {
  const cleaned = text
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const tokens = [];
  const tagRe = /<([/?!]?)([A-Za-z0-9_:\-]+)((?:\s+[^>]*?)?)(\/?)>/g;
  let match;
  let lastIndex = 0;

  while ((match = tagRe.exec(cleaned)) !== null) {
    const textBetween = cleaned.slice(lastIndex, match.index);
    if (textBetween.trim()) tokens.push({ kind: 'text', value: textBetween });
    lastIndex = tagRe.lastIndex;
    if (match[1] === '?') continue;
    if (match[4] === '/') tokens.push({ kind: 'selfclose', name: match[2] });
    else if (match[1] === '/') tokens.push({ kind: 'close', name: match[2] });
    else tokens.push({ kind: 'open', name: match[2] });
  }

  let cursor = 0;

  function parseValue() {
    while (cursor < tokens.length && tokens[cursor].kind === 'text') cursor += 1;
    if (cursor >= tokens.length) return null;
    const token = tokens[cursor];

    if (token.kind === 'selfclose') {
      cursor += 1;
      switch (token.name) {
        case 'true':
          return true;
        case 'false':
          return false;
        case 'array':
          return [];
        case 'dict':
          return {};
        case 'string':
          return '';
        case 'data':
          return Buffer.alloc(0);
        case 'integer':
        case 'real':
          return 0;
        default:
          // <date/> и прочее без содержимого смысла не имеют.
          return null;
      }
    }

    if (token.kind === 'open') {
      cursor += 1;
      switch (token.name) {
        case 'dict': {
          const dict = {};
          for (;;) {
            while (cursor < tokens.length && tokens[cursor].kind === 'text') cursor += 1;
            if (cursor >= tokens.length || tokens[cursor].kind === 'close') {
              cursor += 1;
              break;
            }
            const keyToken = tokens[cursor];
            cursor += 1;
            let key = '';
            if (keyToken.name === 'key') {
              key = readTextUntilClose('key');
            }
            dict[key] = parseValue();
          }
          return dict;
        }
        case 'array': {
          const arr = [];
          for (;;) {
            while (cursor < tokens.length && tokens[cursor].kind === 'text') cursor += 1;
            if (cursor >= tokens.length || tokens[cursor].kind === 'close') {
              cursor += 1;
              break;
            }
            arr.push(parseValue());
          }
          return arr;
        }
        case 'string':
          return decodeXmlEntities(readTextUntilClose('string'));
        case 'integer':
        case 'i':
          return parseInt(readTextUntilClose(token.name), 10);
        case 'real':
        case 'r':
          return parseFloat(readTextUntilClose('real'));
        case 'data':
          return Buffer.from(readTextUntilClose('data').replace(/\s+/g, ''), 'base64');
        case 'date':
          return new Date(readTextUntilClose('date'));
        case 'true':
          skipToClose('true');
          return true;
        case 'false':
          skipToClose('false');
          return false;
        case 'null':
          cursor += 1;
          return null;
        default:
          return parseValue();
      }
    }

    cursor += 1;
    return null;
  }

  function readTextUntilClose(name) {
    let out = '';
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if (token.kind === 'text') {
        out += token.value;
        cursor += 1;
      } else if (token.kind === 'close' && token.name === name) {
        cursor += 1;
        return out;
      } else {
        // Вложенный тег там, где ожидался только текст — пропускаем.
        return out;
      }
    }
    return out;
  }

  function skipToClose(name) {
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      cursor += 1;
      if (token.kind === 'close' && token.name === name) return;
    }
  }

  // Пропускаем до корневого <plist>, затем разбираем его единственного ребёнка.
  while (cursor < tokens.length && !(tokens[cursor].kind === 'open' && tokens[cursor].name === 'plist')) {
    cursor += 1;
  }
  if (cursor >= tokens.length) {
    // Нет <plist> — пробуем разобрать как есть.
    cursor = 0;
  } else {
    cursor += 1;
  }

  const value = parseValue();
  return { format: 'xml', value };
}

// ------------------------------------------------------------------- публичное

function isBinaryPlist(buffer) {
  return buffer.length >= 8 && buffer.toString('latin1', 0, 8) === BPLIST_MAGIC;
}

/** Прочитать plist из файла (автоопределение формата через сигнатуру). */
function readPlistFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length === 0) return { format: 'empty', value: null };
  if (isBinaryPlist(buffer)) return parseBinaryPlist(buffer);
  const text = buffer.toString('utf8');
  if (text.trimStart().startsWith('{')) {
    // Некоторые инструменты кладут рядом JSON-подобный OpenStep plist — не наш случай.
    throw new Error(t('plist.openStepUnsupported'));
  }
  return parseXmlPlist(text);
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Сериализовать значение в XML plist (для iTunesMetadata.plist и патчей). */
function toXmlPlist(value, indent = 0) {
  const pad = '  '.repeat(indent);
  const padInner = '  '.repeat(indent + 1);

  if (value === null || value === undefined) return `${pad}<string></string>`;
  if (typeof value === 'boolean') return `${pad}<${value ? 'true' : 'false'}/>`;
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? `${pad}<integer>${value}</integer>`
      : `${pad}<real>${value}</real>`;
  }
  if (typeof value === 'string') return `${pad}<string>${escapeXml(value)}</string>`;
  if (value instanceof Date) return `${pad}<date>${value.toISOString()}</date>`;
  if (Buffer.isBuffer(value)) {
    const base64 = value.toString('base64').replace(/(.{68})/g, '$1\n');
    return `${pad}<data>\n${base64}\n${pad}</data>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}<array/>`;
    const items = value.map((item) => toXmlPlist(item, indent + 1)).join('\n');
    return `${pad}<array>\n${items}\n${pad}</array>`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${pad}<dict/>`;
    const items = keys
      .map(
        (key) =>
          `${padInner}<key>${escapeXml(key)}</key>\n${toXmlPlist(value[key], indent + 1)}`,
      )
      .join('\n');
    return `${pad}<dict>\n${items}\n${pad}</dict>`;
  }
  throw new Error(t('plist.cannotSerialize', { type: typeof value }));
}

function writeXmlPlistFile(filePath, value) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${toXmlPlist(
    value,
  )}\n</plist>\n`;
  fs.writeFileSync(filePath, xml, 'utf8');
  return xml;
}

module.exports = {
  parseBinaryPlist,
  parseXmlPlist,
  readPlistFile,
  isBinaryPlist,
  toXmlPlist,
  writeXmlPlistFile,
};
