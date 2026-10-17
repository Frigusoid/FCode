/*
 * Редактор на CodeMirror 6 с оформлением под Xcode (тёмная фиолетовая тема).
 *
 * Один экземпляр EditorView на всё приложение: при переключении вкладок мы
 * подменяем EditorState. Так сохраняются история отмены и позиция курсора в
 * каждой открытой вкладке, и при этом не плодятся тяжёлые экземпляры редактора.
 *
 * Дополнительно подключается языковой сервер Swift (sourcekit-lsp):
 *   • diagnostics — подчёркивание ошибок и предупреждений;
 *   • complete    — автодополнение;
 *   • hover       — подсказка при наведении.
 * Все три приходят снаружи, поэтому редактор не знает, откуда они берутся.
 */

import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  hoverTooltip,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import {
  StreamLanguage,
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  foldGutter,
  foldKeymap,
} from '@codemirror/language';
import {
  linter,
  lintGutter,
  forceLinting,
  openLintPanel,
} from '@codemirror/lint';
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

import { swift } from '@codemirror/legacy-modes/mode/swift';
import { objectiveC, objectiveCpp, c, cpp } from '@codemirror/legacy-modes/mode/clike';
import { xml } from '@codemirror/legacy-modes/mode/xml';
import { javascript, json } from '@codemirror/legacy-modes/mode/javascript';
import { python } from '@codemirror/legacy-modes/mode/python';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { css } from '@codemirror/legacy-modes/mode/css';
import { properties } from '@codemirror/legacy-modes/mode/properties';

/** Язык подсветки по идентификатору из навигатора. */
function modeFor(language) {
  switch (language) {
    case 'swift':
      return swift;
    case 'objectivec':
      return objectiveC;
    case 'objectivecpp':
      return objectiveCpp;
    case 'c':
      return c;
    case 'cpp':
      return cpp;
    case 'xml':
      return xml;
    case 'json':
      return json;
    case 'javascript':
      return javascript;
    case 'python':
      return python;
    case 'shell':
      return shell;
    case 'yaml':
      return yaml;
    case 'ruby':
      return ruby;
    case 'css':
      return css;
    case 'strings':
      return properties;
    default:
      return null;
  }
}

/*
 * Палитра в духе Xcode, но в фиолетовой гамме: ключевые слова — сиреневые,
 * строки — тёплые, типы — голубые, функции — бирюзовые.
 */
const xcodeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: '#c792ea' },
  { tag: [t.self, t.null, t.atom], color: '#c792ea' },
  { tag: [t.string, t.special(t.string), t.character], color: '#f78c6c' },
  { tag: [t.regexp], color: '#f78c6c' },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: '#6d6588',
    fontStyle: 'italic',
  },
  { tag: [t.number, t.bool, t.integer, t.float], color: '#f2c97d' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: '#82d2ff' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#7fdbca' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: '#ece9f5' },
  { tag: [t.variableName, t.propertyName, t.attributeValue], color: '#ece9f5' },
  { tag: [t.tagName], color: '#7fdbca' },
  { tag: [t.attributeName], color: '#e0a458' },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: '#e0a458' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: '#bfb6d4' },
  { tag: [t.labelName], color: '#f2c97d' },
  { tag: [t.link], color: '#82d2ff', textDecoration: 'underline' },
  { tag: [t.heading], color: '#82d2ff', fontWeight: 'bold' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: 'bold' },
  { tag: [t.invalid], color: '#f87171' },
]);

const xcodeTheme = EditorView.theme(
  {
    '&': {
      color: '#ece9f5',
      backgroundColor: '#181322',
      height: '100%',
    },
    '.cm-content': {
      caretColor: '#c4b5fd',
      padding: '6px 0',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#c4b5fd', borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#3b2d5e',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.035)' },
    '.cm-gutters': {
      backgroundColor: '#181322',
      color: '#6b5f8c',
      border: 'none',
      borderRight: '1px solid #2a2040',
      paddingRight: '4px',
    },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.05)', color: '#a99fc4' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 10px', minWidth: '38px' },
    '.cm-foldGutter .cm-gutterElement': { color: '#6b5f8c' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'rgba(168,85,247,0.20)',
      outline: '1px solid rgba(168,85,247,0.45)',
    },
    '.cm-selectionMatch': { backgroundColor: 'rgba(255,214,10,0.14)' },
    '.cm-panels': { backgroundColor: '#221a33', color: '#ece9f5' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid #3d2f5c' },
    '.cm-searchMatch': { backgroundColor: 'rgba(255,159,10,0.28)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(255,159,10,0.5)' },
    '.cm-tooltip': {
      backgroundColor: '#231a35',
      border: '1px solid #3d2f5c',
      borderRadius: '6px',
      maxWidth: '640px',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: '#a855f7',
      color: '#fff',
    },
    '.cm-tooltip-autocomplete ul li': { padding: '2px 8px' },
    '.cm-completionDetail': { fontStyle: 'normal', color: '#a99fc4', marginLeft: '10px' },
    '.cm-diagnostic': { padding: '4px 8px', whiteSpace: 'pre-wrap' },
    '.cm-diagnostic-error': { borderLeft: '3px solid #f87171' },
    '.cm-diagnostic-warning': { borderLeft: '3px solid #fbbf24' },
    '.cm-diagnostic-info': { borderLeft: '3px solid #82d2ff' },
    '.cm-lintRange-error': { backgroundImage: 'none', borderBottom: '1px wavy #f87171' },
    '.cm-lintRange-warning': { backgroundImage: 'none', borderBottom: '1px wavy #fbbf24' },
    '.cm-tooltip-hover': { padding: '6px 10px' },
    '.cm-hover-doc': {
      fontFamily: "'Cascadia Code', Consolas, monospace",
      fontSize: '12px',
      whiteSpace: 'pre-wrap',
      maxWidth: '620px',
    },
  },
  { dark: true },
);

/**
 * Создать редактор в указанном контейнере.
 *
 * @param {HTMLElement} parent
 * @param {{
 *   onSave?: Function,
 *   onChange?: Function,
 *   diagnostics?: () => Array,
 *   complete?: (context: any) => Promise<any>,
 *   hover?: (view: any, pos: number, side: number) => Promise<any>,
 * }} handlers
 */
export function createEditor(parent, handlers = {}) {
  const buildExtensions = (language) => {
    const mode = modeFor(language);

    const extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      syntaxHighlighting(xcodeHighlight),
      xcodeTheme,
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            handlers.onSave?.();
            return true;
          },
        },
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      mode ? StreamLanguage.define(mode) : [],
      EditorView.updateListener.of((update) => {
        if (update.docChanged) handlers.onChange?.(update.state.doc.toString());
      }),
    ];

    // Языковой сервер: подчёркивания, автодополнение, подсказки.
    if (handlers.diagnostics) {
      extensions.push(lintGutter(), linter(() => handlers.diagnostics(), { delay: 400 }));
    }
    if (handlers.complete) {
      extensions.push(autocompletion({ override: [handlers.complete], activateOnTyping: true }));
    }
    if (handlers.hover) {
      extensions.push(
        hoverTooltip(async (view, pos, side) => {
          const result = await handlers.hover(view, pos, side);
          if (!result) return null;
          return {
            pos: result.from,
            end: result.to,
            above: true,
            create: () => {
              const dom = document.createElement('div');
              dom.className = 'cm-hover-doc';
              dom.textContent = result.text;
              return { dom };
            },
          };
        }),
      );
    }

    return extensions;
  };

  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: '', extensions: buildExtensions('text') }),
  });

  return {
    view,

    /** Создать состояние для нового документа (одно на вкладку). */
    createState(text, language) {
      return EditorState.create({ doc: text, extensions: buildExtensions(language) });
    },

    setState(state) {
      view.setState(state);
    },

    getState() {
      return view.state;
    },

    getText() {
      return view.state.doc.toString();
    },

    focus() {
      view.focus();
    },

    /** Заставить перечитать диагностику — когда сервер прислал новую. */
    refreshDiagnostics() {
      try {
        forceLinting(view);
      } catch {
        /* редактор без линтера */
      }
    },

    showProblemPanel() {
      try {
        openLintPanel(view);
      } catch {
        /* панель недоступна */
      }
    },

    /** Поставить курсор на строку — для перехода к определению и по проблемам. */
    scrollToLine(line, character = 0) {
      const total = view.state.doc.lines;
      const target = view.state.doc.line(Math.min(Math.max(line + 1, 1), total));
      const pos = Math.min(target.from + character, target.to);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    },

    /** Позиция курсора в виде {line, character} — как ждёт языковой сервер. */
    cursorPosition() {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { line: line.number - 1, character: head - line.from };
    },

    /** Смещение в документе -> позиция LSP. */
    positionAt(pos) {
      const line = view.state.doc.lineAt(pos);
      return { line: line.number - 1, character: pos - line.from };
    },

    openFind() {
      const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true });
      view.contentDOM.dispatchEvent(event);
      view.focus();
    },
  };
}

export { modeFor };
