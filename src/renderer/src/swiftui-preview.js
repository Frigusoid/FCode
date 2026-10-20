/*
 * Приблизительный разбор SwiftUI для предпросмотра.
 *
 * Это НЕ симулятор: мы не исполняем код, а читаем текст вьюхи и рисуем эскиз
 * вёрстки. Задача — увидеть порядок и вложенность элементов, отступы и цвета, пока
 * приложение не собрано. Всё, что не удалось разобрать, показывается заглушкой
 * с именем элемента, чтобы не возникало ощущения «пусто».
 *
 * Разбор намеренно простой: идём по тексту, вылавливаем вызовы вида
 * `Имя(аргументы) { дети }.модификатор(…)`. Никакого SwiftSyntax — он бы
 * потребовал Swift-парсер внутри Electron.
 */

/** Контейнеры: их дети рисуются друг под другом или в ряд. */
const CONTAINERS = new Set([
  'VStack', 'LazyVStack', 'HStack', 'LazyHStack', 'ZStack', 'ScrollView',
  'List', 'Form', 'Section', 'Group', 'NavigationStack', 'NavigationView',
  'TabView', 'VGrid', 'LazyVGrid', 'LazyHGrid', 'Grid', 'DisclosureGroup',
]);

/** Элементы без детей. */
const LEAVES = new Set([
  'Text', 'Label', 'Image', 'Button', 'Link', 'Spacer', 'Divider', 'Color',
  'Rectangle', 'RoundedRectangle', 'Circle', 'Capsule', 'Ellipse',
  'ProgressView', 'Toggle', 'Slider', 'TextField', 'SecureField', 'Picker',
  'Stepper', 'AsyncImage', 'EmptyView', 'Symbol',
]);

/** Размеры шрифта SwiftUI в пикселях телефона. */
const FONT_SIZES = {
  largeTitle: 34, title: 28, title2: 22, title3: 20, headline: 17,
  body: 17, callout: 16, subheadline: 15, footnote: 13, caption: 12,
  caption2: 11,
};

/** Именованные цвета SwiftUI. */
const COLORS = {
  red: '#ff453a', blue: '#0a84ff', green: '#30d158', orange: '#ff9f0a',
  yellow: '#ffd60a', purple: '#bf5af2', pink: '#ff375f', teal: '#40c8e0',
  indigo: '#5e5ce6', mint: '#66d4cf', cyan: '#32ade6', brown: '#ac8e68',
  gray: '#8e8e93', secondary: '#8e8e93', primary: '#ffffff',
  white: '#ffffff', black: '#000000', clear: 'transparent',
};

/** Прочитать сбалансированный фрагмент, начиная с открывающей скобки. */
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
      if (depth === 0) return { text: text.slice(start + 1, i), end: i };
    }
  }
  return null;
}

/** Прочитать строковый литерал, начиная с кавычки. */
function readString(text, start) {
  if (text[start] !== '"') return null;
  let i = start + 1;
  let value = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { value += text[i + 1] || ''; i += 2; continue; }
    if (ch === '"') return { value, end: i };
    value += ch;
    i += 1;
  }
  return null;
}

/** Пропустить пробелы и переводы строк. */
function skipSpace(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

/**
 * Найти тело вьюхи: содержимое `var body: some View { … }`.
 * Если такого нет (например, открыт не тот файл) — берём весь текст.
 */
export function extractBody(source) {
  const match = /(?:var|let)\s+body\s*:\s*some\s+View\s*\{/.exec(source);
  if (!match) return { body: source, found: false };

  const braceIndex = source.indexOf('{', match.index + match[0].length - 1);
  const balanced = readBalanced(source, braceIndex, '{', '}');
  if (!balanced) return { body: source, found: false };

  return { body: balanced.text, found: true };
}

/** Разобрать цепочку модификаторов: .padding(8).font(.title) */
function parseModifiers(text, index) {
  const modifiers = [];
  let i = skipSpace(text, index);

  while (text[i] === '.') {
    const nameMatch = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i));
    if (!nameMatch) break;

    const name = nameMatch[1];
    i += nameMatch[0].length;

    let args = '';
    const parenStart = skipSpace(text, i);
    if (text[parenStart] === '(') {
      const paren = readBalanced(text, parenStart, '(', ')');
      if (paren) {
        args = paren.text;
        i = paren.end + 1;
      }
    }

    modifiers.push({ name, args: args.trim() });
    i = skipSpace(text, i);
  }

  return { modifiers, end: i };
}

/** Первое строковое значение из аргументов вызова. */
function firstString(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '"') {
      const parsed = readString(args, i);
      if (parsed) return parsed.value;
    }
  }
  return null;
}

/** Именованный аргумент: `systemName: "star"`. */
function namedString(args, name) {
  const pattern = new RegExp(`${name}\\s*:\\s*"`);
  const match = pattern.exec(args);
  if (!match) return null;
  const quoteIndex = args.indexOf('"', match.index + match[0].length - 1);
  const parsed = readString(args, quoteIndex);
  return parsed ? parsed.value : null;
}

/** Числовой аргумент модификатора: padding(16) или padding(.horizontal, 16). */
function numericArg(args) {
  const numbers = String(args).match(/-?\d+(\.\d+)?/g);
  if (!numbers) return null;
  return Number(numbers[numbers.length - 1]);
}

/**
 * Разобрать содержимое блока в список узлов.
 * Возвращает { nodes, warnings }.
 */
function parseBlock(text) {
  const nodes = [];
  const warnings = [];
  let i = 0;

  while (i < text.length) {
    i = skipSpace(text, i);
    if (i >= text.length) break;

    const ch = text[i];

    // Комментарии и запятые пропускаем.
    if (ch === ',' || ch === ';' || ch === ')') { i += 1; continue; }

    // Условные конструкции: показываем ветку «если».
    if (/^(if|switch|ForEach|for)\b/.test(text.slice(i))) {
      const keyword = /^(\w+)/.exec(text.slice(i))[1];
      const braceIndex = text.indexOf('{', i);
      const condition = text.slice(i + keyword.length, braceIndex === -1 ? undefined : braceIndex).trim();
      const balanced = braceIndex === -1 ? null : readBalanced(text, braceIndex, '{', '}');

      if (balanced) {
        const inner = parseBlock(balanced.text);
        nodes.push({
          kind: 'conditional',
          keyword,
          condition: condition.slice(0, 60),
          children: inner.nodes,
        });
        warnings.push(...inner.warnings);
        i = balanced.end + 1;
        continue;
      }
      i += keyword.length;
      continue;
    }

    // Обычный вызов: Имя(...) { дети } .модификаторы
    const nameMatch = /^([A-Z][A-Za-z0-9_]*)/.exec(text.slice(i));
    if (!nameMatch) {
      // Не смогли распознать — перешагиваем строку, чтобы не зациклиться.
      const nextBreak = text.indexOf('\n', i);
      i = nextBreak === -1 ? text.length : nextBreak + 1;
      continue;
    }

    const name = nameMatch[1];
    i += name.length;

    let args = '';
    let parenIndex = skipSpace(text, i);
    if (text[parenIndex] === '(') {
      const paren = readBalanced(text, parenIndex, '(', ')');
      if (paren) {
        args = paren.text;
        i = paren.end + 1;
      }
    }

    // Дети: фигурные скобки сразу после аргументов.
    let children = [];
    let braceIndex = skipSpace(text, i);
    if (text[braceIndex] === '{') {
      const balanced = readBalanced(text, braceIndex, '{', '}');
      if (balanced) {
        const inner = parseBlock(balanced.text);
        // Для Button/Link первый блок — это действие, а не разметка.
        const isAction = name === 'Button' || name === 'Link' || name === 'onTapGesture';
        const looksLikeAction = inner.nodes.length === 0;
        if (!isAction || looksLikeAction || /label\s*:/.test(args)) {
          children = inner.nodes;
          warnings.push(...inner.warnings);
        } else {
          // Внутри действия может быть своя разметка — показываем её как есть.
          children = inner.nodes;
          warnings.push(...inner.warnings);
        }
        i = balanced.end + 1;
      }
    }

    // Модификаторы могут идти до и после блока детей; поддерживаем один проход.
    const mods = parseModifiers(text, i);
    i = mods.end;

    nodes.push({
      kind: 'view',
      name,
      args: args.trim(),
      modifiers: mods.modifiers,
      children,
    });
  }

  return { nodes, warnings };
}

/** Цвет с прозрачностью: #rrggbb + альфа. */
function withAlpha(hex, alpha) {
  if (!hex || hex === 'transparent') return hex;
  const value = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
  return `${hex}${value}`;
}

/** Собрать узел в плоское описание, удобное для рисования. */
function describe(node) {
  if (node.kind === 'conditional') {
    return {
      kind: 'conditional',
      condition: node.condition,
      children: node.children.map(describe),
    };
  }

  const style = {
    padding: null,
    font: null,
    weight: null,
    color: null,
    background: null,
    radius: null,
    height: null,
    width: null,
    opacity: null,
    italic: false,
    lineLimit: null,
    bold: false,
  };

  for (const mod of node.modifiers) {
    switch (mod.name) {
      case 'padding':
        style.padding = numericArg(mod.args) ?? 8;
        break;
      case 'frame':
        style.height = /height\s*:/.test(mod.args) ? numericArg(mod.args) : style.height;
        style.width = /width\s*:/.test(mod.args) ? numericArg(mod.args) : style.width;
        if (/maxHeight\s*:\s*\.infinity/.test(mod.args)) style.fillHeight = true;
        break;
      case 'font': {
        const size = /\.(\w+)/.exec(mod.args);
        if (size && FONT_SIZES[size[1]]) style.font = FONT_SIZES[size[1]];
        else if (/system\(\s*size\s*:\s*(\d+)/.test(mod.args)) {
          style.font = Number(/system\(\s*size\s*:\s*(\d+)/.exec(mod.args)[1]);
        }
        if (/weight\s*:\s*\.bold/.test(mod.args)) style.weight = 700;
        if (/design\s*:\s*\.monospaced/.test(mod.args)) style.monospace = true;
        break;
      }
      case 'foregroundColor':
      case 'foregroundStyle':
      case 'tint': {
        const named = /\.(\w+)/.exec(mod.args);
        if (named && COLORS[named[1]]) style.color = COLORS[named[1]];
        break;
      }
      case 'background': {
        const named = /\.(\w+)/.exec(mod.args);
        if (named && COLORS[named[1]]) {
          // Фон в эскизе делаем приглушённым: сплошной Color.gray закрывает
          // текст, хотя в настоящем SwiftUI он выглядит как лёгкая плашка.
          style.background = withAlpha(COLORS[named[1]], 0.28);
        } else if (/Color\(/.test(mod.args)) {
          style.background = 'rgba(58, 58, 60, 0.6)';
        }
        break;
      }
      case 'cornerRadius':
        style.radius = numericArg(mod.args) ?? 8;
        break;
      case 'opacity':
        style.opacity = numericArg(mod.args);
        break;
      case 'bold':
        style.bold = true;
        style.weight = 700;
        break;
      case 'italic':
        style.italic = true;
        break;
      case 'lineLimit':
        style.lineLimit = numericArg(mod.args);
        break;
      default:
        break;
    }
  }

  return {
    kind: node.kind,
    name: node.name,
    args: node.args,
    label: labelFor(node),
    style,
    children: node.children.map(describe),
  };
}

/** Подпись элемента: текст для Text, имя символа для Image и т. п. */
function labelFor(node) {
  const args = node.args || '';

  if (node.name === 'Text' || node.name === 'Label' || node.name === 'Button'
    || node.name === 'Link' || node.name === 'TextField' || node.name === 'SecureField') {
    const text = firstString(args);
    if (text) return text;
  }

  if (node.name === 'Image') {
    const system = namedString(args, 'systemName');
    if (system) return system;
    const res = namedString(args, 'name') || firstString(args);
    if (res) return res;
    return 'image';
  }

  if (node.name === 'ProgressView') return 'loading';
  return null;
}

/**
 * Разобрать исходник файла.
 *
 * @param {string} source текст Swift-файла
 * @returns {{found: boolean, nodes: any[], warnings: string[]}}
 */
export function parseSwiftUI(source) {
  const { body, found } = extractBody(source);
  const parsed = parseBlock(body);
  const nodes = parsed.nodes.map(describe);

  const warnings = [...parsed.warnings];
  if (!found) warnings.push('в файле нет var body: some View');

  return { found, nodes, warnings };
}

/** Контейнер это или элемент. */
export function isContainer(name) {
  return CONTAINERS.has(name);
}

export function isLeaf(name) {
  return LEAVES.has(name);
}

/**
 * Нарисовать разобранное дерево в HTML.
 *
 * Стили inline: предпросмотр не зависит от основного CSS и его проще проверять.
 *
 * @param {any[]} nodes
 * @returns {string}
 */
export function renderPreview(nodes) {
  const escape = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const renderOne = (node) => {
    if (node.kind === 'conditional') {
      return (
        `<div class="pv-cond"><span class="pv-cond-label">если: ${escape(node.condition)}</span>` +
        `<div class="pv-cond-body">${node.children.map(renderOne).join('')}</div></div>`
      );
    }

    const style = node.style || {};
    const inline = [];
    if (style.padding !== null) inline.push(`padding:${style.padding}px`);
    if (style.font) inline.push(`font-size:${style.font}px`);
    if (style.weight) inline.push(`font-weight:${style.weight}`);
    if (style.color) inline.push(`color:${style.color}`);
    if (style.background) inline.push(`background:${style.background}`);
    if (style.radius !== null) inline.push(`border-radius:${style.radius}px`);
    if (style.height) inline.push(`height:${style.height}px`);
    if (style.width) inline.push(`width:${style.width}px`);
    if (style.opacity !== null) inline.push(`opacity:${style.opacity}`);
    if (style.italic) inline.push('font-style:italic');
    if (style.monospace) inline.push('font-family:ui-monospace,monospace');
    if (style.fillHeight) inline.push('flex:1 1 auto');
    const styleAttr = inline.length ? ` style="${inline.join(';')}"` : '';

    const children = (node.children || []).map(renderOne).join('');

    switch (node.name) {
      case 'VStack':
      case 'LazyVStack':
      case 'Form':
      case 'List':
      case 'Group':
      case 'Section':
      case 'NavigationStack':
      case 'NavigationView':
      case 'TabView':
      case 'ScrollView':
      case 'Grid':
      case 'VGrid':
      case 'LazyVGrid':
        return `<div class="pv-col pv-${node.name.toLowerCase()}"${styleAttr}>${children}</div>`;

      case 'HStack':
      case 'LazyHStack':
        return `<div class="pv-row"${styleAttr}>${children}</div>`;

      case 'ZStack':
        return `<div class="pv-stack"${styleAttr}>${children}</div>`;

      case 'Spacer':
        return `<div class="pv-spacer"${styleAttr}></div>`;

      case 'Divider':
        return `<div class="pv-divider"${styleAttr}></div>`;

      case 'Text':
        return `<div class="pv-text"${styleAttr}>${escape(node.label || 'Text')}</div>`;

      case 'Label':
        return `<div class="pv-label"${styleAttr}>▸ ${escape(node.label || 'Label')}</div>`;

      case 'Image':
        // Небольшой квадрат вместо текста: имя символа растягивало строку и
        // наезжало на соседний текст.
        return (
          `<div class="pv-image"${styleAttr} title="${escape(node.label || 'image')}">` +
          `<span class="pv-image-glyph">▣</span></div>`
        );

      case 'Button':
        return `<div class="pv-button"${styleAttr}>${escape(node.label || 'Button')}</div>`;

      case 'Link':
        return `<div class="pv-link"${styleAttr}>${escape(node.label || 'Link')}</div>`;

      case 'TextField':
      case 'SecureField':
        return `<div class="pv-field"${styleAttr}>${escape(node.label || 'поле ввода')}</div>`;

      case 'Toggle':
        return `<div class="pv-toggle"${styleAttr}>переключатель</div>`;

      case 'ProgressView':
        return `<div class="pv-progress"${styleAttr}>◌ загрузка</div>`;

      case 'Color':
      case 'Rectangle':
      case 'RoundedRectangle':
      case 'Circle':
      case 'Capsule':
      case 'Ellipse':
        return `<div class="pv-shape"${styleAttr}></div>`;

      case 'EmptyView':
        return '';

      case 'AsyncImage':
        return `<div class="pv-image"${styleAttr}>картинка по ссылке</div>`;

      default:
        // Неизвестный элемент: показываем заглушку, чтобы не терять структуру.
        return (
          `<div class="pv-unknown"${styleAttr}>${escape(node.name)}` +
          `<span class="pv-unknown-hint">не распознан</span></div>`
        );
    }
  };

  if (!nodes.length) {
    return '<div class="pv-empty">Нечего показать: в этом файле нет разметки SwiftUI.</div>';
  }

  return `<div class="pv-root">${nodes.map(renderOne).join('')}</div>`;
}
