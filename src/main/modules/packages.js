'use strict';
/*
 * Зависимости SwiftPM: чтение, добавление, удаление и скачивание.
 *
 * Package.swift — это Swift-код, а не данные. Полноценный разбор потребовал бы
 * SwiftSyntax, поэтому здесь аккуратный текстовый разбор: находим блок
 * `dependencies: [...]` и вызовы `.package(...)` с учётом вложенных скобок и
 * строк. Для правки этого достаточно, а ошибки разбора видно сразу: после
 * изменения проверяем, что скобки сошлись и блок зависимостей на месте.
 *
 * Правки пишутся в конец массива, а не пересобирают файл целиком: так проект
 * сохраняет свой стиль и комментарии.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Прочитать сбалансированный фрагмент, начиная с открывающего символа. */
function readBalanced(text, start, open, close) {
  if (text[start] !== open) return null;

  let depth = 0;
  let inString = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return { start, end: i, text: text.slice(start + 1, i) };
    }
  }

  return null;
}

/** Первая строка после `name:` внутри аргументов вызова. */
function stringArgument(args, key) {
  const pattern = new RegExp(`${key}\\s*:\\s*"`);
  const match = pattern.exec(args);
  if (!match) return null;

  let i = match.index + match[0].length;
  let value = '';
  while (i < args.length) {
    const ch = args[i];
    if (ch === '\\') { value += args[i + 1] || ''; i += 2; continue; }
    if (ch === '"') break;
    value += ch;
    i += 1;
  }
  return value || null;
}

/** Требование к версии: from, exact, branch, revision, upToNextMajor. */
function versionRequirement(args) {
  // Сначала составные виды: внутри `.upToNextMajor(from: "1.0")` тоже есть
  // `from`, и без этого порядка он перебивал бы составное требование.
  for (const kind of ['upToNextMajor', 'upToNextMinor']) {
    const match = new RegExp(`${kind}\\s*\\(\\s*from\\s*:\\s*"([^"]+)"`).exec(args);
    if (match) return { kind, value: match[1] };
  }

  // SwiftPM пишет короткие требования без метки: .from("1.0.0").
  const positional = /\.(from|exact)\s*\(\s*"([^"]+)"\s*\)/.exec(args);
  if (positional) return { kind: positional[1], value: positional[2] };

  const branch = stringArgument(args, 'branch');
  if (branch) return { kind: 'branch', value: branch };

  const revision = stringArgument(args, 'revision');
  if (revision) return { kind: 'revision', value: revision };

  const from = stringArgument(args, 'from');
  if (from) return { kind: 'from', value: from };

  const exact = stringArgument(args, 'exact');
  if (exact) return { kind: 'exact', value: exact };

  return { kind: 'any', value: null };
}

/** Имя пакета из адреса: последний кусок без .git. */
function nameFromUrl(url) {
  const tail = String(url || '').replace(/\/+$/, '').split('/').pop() || '';
  return tail.replace(/\.git$/i, '');
}

/** Все вызовы `.package(...)` внутри текста. */
function findPackageCalls(text) {
  const calls = [];
  let index = 0;

  while (index < text.length) {
    const at = text.indexOf('.package(', index);
    if (at === -1) break;

    const open = at + '.package'.length;
    const balanced = readBalanced(text, open, '(', ')');
    if (!balanced) break;

    calls.push({
      start: at,
      end: balanced.end + 1,
      args: balanced.text,
    });

    index = balanced.end + 1;
  }

  return calls;
}

/** Все вызовы `.product(name:package:)`. */
function findProductCalls(text) {
  const calls = [];
  let index = 0;

  while (index < text.length) {
    const at = text.indexOf('.product(', index);
    if (at === -1) break;

    const open = at + '.product'.length;
    const balanced = readBalanced(text, open, '(', ')');
    if (!balanced) break;

    calls.push({
      start: at,
      end: balanced.end + 1,
      name: stringArgument(balanced.text, 'name'),
      package: stringArgument(balanced.text, 'package'),
    });

    index = balanced.end + 1;
  }

  return calls;
}

/** Найти блок `dependencies: [...]` внутри манифеста. */
function findDependenciesBlock(text) {
  const match = /dependencies\s*:\s*\[/.exec(text);
  if (!match) return null;

  const open = text.indexOf('[', match.index);
  const balanced = readBalanced(text, open, '[', ']');
  if (!balanced) return null;

  return balanced;
}

/**
 * Прочитать зависимости проекта.
 *
 * @param {string} projectPath папка проекта
 * @returns {{exists: boolean, path: string, name: string|null,
 *            packages: Array<{url: string, name: string, requirement: object}>,
 *            products: Array<{name: string, package: string}>}}
 */
function read(projectPath) {
  const manifestPath = path.join(projectPath, 'Package.swift');
  if (!fs.existsSync(manifestPath)) {
    return { exists: false, path: manifestPath, name: null, packages: [], products: [] };
  }

  const text = fs.readFileSync(manifestPath, 'utf8');
  const nameMatch = /Package\s*\(\s*\n?\s*name\s*:\s*"([^"]+)"/.exec(text);
  const block = findDependenciesBlock(text);

  const packages = [];
  if (block) {
    for (const call of findPackageCalls(block.text)) {
      const url = stringArgument(call.args, 'url');
      if (!url) continue;
      packages.push({
        url,
        name: nameFromUrl(url),
        requirement: versionRequirement(call.args),
      });
    }
  }

  const products = findProductCalls(text)
    .filter((call) => call.name && call.package)
    .map((call) => ({ name: call.name, package: call.package }));

  return {
    exists: true,
    path: manifestPath,
    name: nameMatch ? nameMatch[1] : path.basename(projectPath),
    packages,
    products,
  };
}

/** Проверить, что файл не сломан: скобки сошлись, строки закрыты. */
function checkSyntax(text) {
  // Незакрытая кавычка ломает весь разбор, поэтому проверяем её первой.
  let quotes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '"') quotes += 1;
  }
  if (quotes % 2 !== 0) return 'не закрыта кавычка';

  const pairs = [['{', '}'], ['(', ')'], ['[', ']']];

  for (const [open, close] of pairs) {
    let depth = 0;
    let inString = false;

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === open) depth += 1;
      if (ch === close) {
        depth -= 1;
        if (depth < 0) return `${close} без пары`;
      }
    }

    if (depth !== 0) return `${open} не закрыт`;
  }

  return null;
}

/** Сделать резервную копию один раз за сессию правок. */
function backupOnce(manifestPath) {
  const backup = `${manifestPath}.bak`;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(manifestPath, backup);
  }
  return backup;
}

/**
 * Добавить зависимость.
 *
 * @param {string} projectPath
 * @param {{url: string, version?: string, product?: string,
 *          target?: string, kind?: string}} options
 */
function add(projectPath, options) {
  const url = String(options.url || '').trim();
  if (!url) throw new Error('не указан адрес пакета');

  const manifestPath = path.join(projectPath, 'Package.swift');
  if (!fs.existsSync(manifestPath)) throw new Error('в проекте нет Package.swift');

  let text = fs.readFileSync(manifestPath, 'utf8');

  const existing = read(projectPath).packages.map((pkg) => pkg.url.toLowerCase());
  if (existing.includes(url.toLowerCase())) {
    throw new Error('этот пакет уже подключён');
  }

  const block = findDependenciesBlock(text);
  if (!block) throw new Error('в Package.swift нет блока dependencies');

  const kind = options.kind || (options.version ? 'from' : 'branch');
  const version = String(options.version || '').trim();

  let requirement;
  if (kind === 'branch') requirement = `.branch("${version || 'main'}")`;
  else if (kind === 'exact') requirement = `.exact("${version}")`;
  else if (kind === 'upToNextMajor') requirement = `.upToNextMajor(from: "${version}")`;
  else requirement = `.from("${version || '1.0.0'}")`;

  const entry = `.package(url: "${url}", ${requirement}),`;
  const insertionPoint = block.start + 1 + block.text.length;

  // Перед закрывающей скобкой, с тем же отступом, что у соседних строк.
  const before = text.slice(0, insertionPoint);
  const indentMatch = /\n(\s*)[^\n]*$/.exec(before);
  const indent = indentMatch ? indentMatch[1] : '        ';

  const body = block.text.replace(/\s+$/, '');
  const closingBracket = text.lastIndexOf(']', insertionPoint);
  const needsComma = body.length > 0 && !/,\s*$/.test(body);

  text = needsComma && closingBracket > 0
    ? `${text.slice(0, closingBracket).replace(/\s+$/, '')},\n${indent}${entry}\n${indent.slice(0, Math.max(0, indent.length - 4))}${text.slice(closingBracket)}`
    : `${text.slice(0, insertionPoint)}\n${indent}${entry}${text.slice(insertionPoint)}`;

  // Продукт нужен, чтобы цель увидела модуль.
  const product = options.product || nameFromUrl(url);
  if (product) {
    const targetMatch = options.target
      ? new RegExp(`\\.target\\(\\s*name:\\s*"${options.target}"[^]*?dependencies\\s*:\\s*\\[`).exec(text)
      : /\.target\([^]*?dependencies\s*:\s*\[/.exec(text);

    if (targetMatch) {
      const open = text.indexOf('[', targetMatch.index);
      const targetBlock = readBalanced(text, open, '[', ']');
      if (targetBlock) {
        const productEntry = `.product(name: "${product}", package: "${nameFromUrl(url)}")`;
        const closing = open + 1 + targetBlock.text.length;
        const inner = targetBlock.text.replace(/\s+$/, '');
        const comma = inner.length > 0 && !/,\s*$/.test(inner) ? ',' : '';
        text = `${text.slice(0, closing)}${comma}\n                ${productEntry},\n            ${text.slice(closing)}`;
      }
    }
  }

  const broken = checkSyntax(text);
  if (broken) throw new Error(`правка сломала Package.swift: ${broken}`);

  backupOnce(manifestPath);
  fs.writeFileSync(manifestPath, text, 'utf8');

  return read(projectPath);
}

/**
 * Удалить зависимость вместе с продуктами, которые её использовали.
 *
 * @param {string} projectPath
 * @param {{url?: string, name?: string}} options
 */
function remove(projectPath, options) {
  const manifestPath = path.join(projectPath, 'Package.swift');
  if (!fs.existsSync(manifestPath)) throw new Error('в проекте нет Package.swift');

  const target = String(options.url || options.name || '').toLowerCase();
  if (!target) throw new Error('не указано, что удалять');

  let text = fs.readFileSync(manifestPath, 'utf8');
  const block = findDependenciesBlock(text);
  if (!block) throw new Error('в Package.swift нет блока dependencies');

  // Идём с конца, чтобы смещения оставались верными.
  const calls = findPackageCalls(block.text)
    .filter((call) => {
      const url = stringArgument(call.args, 'url');
      return url && url.toLowerCase() === target;
    })
    .reverse();

  if (!calls.length) throw new Error('такой пакет не найден');

  const removedName = nameFromUrl(stringArgument(calls[0].args, 'url'));

  for (const call of calls) {
    const from = block.start + 1 + call.start;
    const to = block.start + 1 + call.end;
    let rest = text.slice(to);
    // Съедаем запятую и пробелы до конца строки.
    rest = rest.replace(/^[ \t]*,/, '');
    const before = text.slice(0, from).replace(/[ \t]+$/, '');
    text = before + rest;
  }

  // Продукты этого пакета больше не нужны.
  const products = findProductCalls(text)
    .filter((call) => call.package && call.package.toLowerCase() === removedName.toLowerCase())
    .reverse();

  for (const call of products) {
    const before = text.slice(0, call.start).replace(/[ \t]+$/, '');
    const after = text.slice(call.end).replace(/^[ \t]*,/, '');
    text = before + after;
  }

  const broken = checkSyntax(text);
  if (broken) throw new Error(`правка сломала Package.swift: ${broken}`);

  backupOnce(manifestPath);
  fs.writeFileSync(manifestPath, text, 'utf8');

  return read(projectPath);
}

/**
 * Изменить версию уже подключённого пакета.
 *
 * Правка точечная: заменяем требование внутри нужного `.package(...)`, не
 * переписывая соседние строки.
 *
 * @param {string} projectPath
 * @param {{url: string, version: string, kind?: string}} options
 */
function setVersion(projectPath, options) {
  const url = String(options.url || '').toLowerCase();
  const version = String(options.version || '').trim();
  if (!url) throw new Error('не указан адрес пакета');
  if (!version) throw new Error('не указана версия');

  const manifestPath = path.join(projectPath, 'Package.swift');
  if (!fs.existsSync(manifestPath)) throw new Error('в проекте нет Package.swift');

  let text = fs.readFileSync(manifestPath, 'utf8');
  const block = findDependenciesBlock(text);
  if (!block) throw new Error('в Package.swift нет блока dependencies');

  const call = findPackageCalls(block.text).find((item) => {
    const found = stringArgument(item.args, 'url');
    return found && found.toLowerCase() === url;
  });
  if (!call) throw new Error('такой пакет не найден');

  const kind = options.kind || 'from';
  let requirement;
  if (kind === 'branch') requirement = `.branch("${version}")`;
  else if (kind === 'exact') requirement = `.exact("${version}")`;
  else if (kind === 'upToNextMajor') requirement = `.upToNextMajor(from: "${version}")`;
  else requirement = `.from("${version}")`;

  const from = block.start + 1 + call.start;
  const to = block.start + 1 + call.end;

  let args = call.args;
  // Убираем прежнее требование: и короткое .from("x"), и с метками.
  args = args.replace(/,\s*\.(from|exact|upToNextMajor|upToNextMinor)\s*\(\s*([^)]*)\)\s*$/, '');
  args = args.replace(/,\s*(from|exact|branch|revision)\s*:\s*"[^"]*"\s*$/, '');
  args = args.replace(/\s*$/, '');

  const replacement = `.package(${args}, ${requirement})`;
  text = text.slice(0, from) + replacement + text.slice(to);

  const broken = checkSyntax(text);
  if (broken) throw new Error(`правка сломала Package.swift: ${broken}`);

  backupOnce(manifestPath);
  fs.writeFileSync(manifestPath, text, 'utf8');

  return read(projectPath);
}

module.exports = {
  read,
  add,
  remove,
  setVersion,
  checkSyntax,
  nameFromUrl,
  versionRequirement,
  // для тестов
  findPackageCalls,
  findProductCalls,
};
