/*
 * Интерфейс Fcode: навигатор, вкладки, редактор, консоль, инспектор,
 * мастер создания проектов и панель сборки без Xcode.
 *
 * Все операции с диском идут через window.fcode (preload-мост) — прямого доступа
 * к файловой системе у интерфейса нет. Все строки берутся из словаря через t().
 */

import { createEditor } from './editor.js';
import { mountIcons, icon } from './icons.js';
import { openSignIn } from './signin.js';
import {
  t,
  setLanguage,
  getLanguage,
  loadStoredLanguage,
  storeLanguage,
  applyStaticTranslations,
} from './i18n.js';

const api = window.fcode;

// ------------------------------------------------------------------ утилиты

const $ = (id) => document.getElementById(id);

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function fmtDate(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(getLanguage() === 'ru' ? 'ru-RU' : 'en-US');
}

function kv(rows) {
  return `<dl class="kv">${rows
    .filter(Boolean)
    .map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`)
    .join('')}</dl>`;
}

function chip(ok, okText, badText) {
  return ok
    ? `<span class="chip ok">${esc(okText)}</span>`
    : `<span class="chip bad">${esc(badText)}</span>`;
}

// ------------------------------------------------------------------ состояние

const state = {
  workspace: null,
  tabs: [],
  activeTabPath: null,
  archive: null,
  expanded: new Set(),
  selectedPath: null,
  busy: false,
  lspRunning: false,
  /** Проблемы от компилятора — отдельно от подсказок языкового сервера. */
  buildDiagnostics: new Map(),
  projectIssues: [],
  /** Папка, куда пользователь положит Xcode.app (выбирается в окне iOS SDK). */
  sdkFolder: null,
  /** Открытые проекты: у каждого своё дерево, вкладки и раскрытые папки. */
  projects: [],
  activeProjectPath: null,
  /** Сведения о программе: заполняются при запуске. */
  appInfo: null,
  searchState: { query: '', caseSensitive: false, wholeWord: false, regex: false, replaceMode: false },
  searchResults: null,
  /** @type {Map<string, Array>} проблемы по файлам */
  diagnostics: new Map(),
  problemsVisible: false,
  xtool: null,
  xtoolDistro: null,
  lastInspector: null,
};

let editor = null;

// ------------------------------------------------------------------- консоль

const consoleEl = $('console-output');
const statusPill = $('status-pill');

function log(text, kind = 'info') {
  const line = document.createElement('div');
  line.className = `log-line log-${kind}`;
  const time = new Date().toLocaleTimeString(getLanguage() === 'ru' ? 'ru-RU' : 'en-GB', {
    hour12: false,
  });
  line.innerHTML = `<span class="log-time">${time}</span><span class="log-text">${esc(text)}</span>`;
  consoleEl.appendChild(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

const logHead = (text) => log(text, 'head');

let statusKey = 'status.ready';
let statusKind = '';

function setStatusKey(key, kind = '') {
  statusKey = key;
  statusKind = kind;
  statusPill.textContent = t(key);
  statusPill.className = `status-pill ${kind}`;
}

function refreshStatusText() {
  statusPill.textContent = t(statusKey);
}

function setBusy(busy, statusKeyName) {
  state.busy = busy;
  $('btn-build').disabled = busy;
  $('btn-verify').disabled = busy;
  $('btn-pick-archive').disabled = busy;
  $('btn-new-project').disabled = busy;
  if (busy) setStatusKey(statusKeyName || 'status.busy', 'busy');
  else setStatusKey('status.ready');
}

// ------------------------------------------------------------------ прогресс

const progressEl = $('progress');
const progressBar = $('progress-bar');
const progressText = $('progress-text');

function showProgress(current, total, label) {
  progressEl.classList.remove('hidden');
  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  progressBar.style.width = `${percent}%`;
  progressText.textContent = `${label} — ${percent}%`;
}

const hideProgress = () => {
  progressEl.classList.add('hidden');
  progressBar.style.width = '0';
};

api.on('ipa:progress', (payload) => {
  if (payload.phase === 'start') {
    showProgress(0, 1, '…');
  } else if (payload.phase === 'pack') {
    showProgress(payload.current, payload.total, `${payload.files}/${payload.totalFiles}`);
  } else if (payload.phase === 'done') {
    showProgress(1, 1, '100%');
    setTimeout(hideProgress, 700);
  }
});

// ------------------------------------------------------------------ модальные

function modal({ title, body, buttons = [], onRender = null }) {
  return new Promise((resolve) => {
    const box = $('modal');
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = body;

    const foot = $('modal-foot');
    foot.innerHTML = '';

    const finish = (value) => {
      box.classList.add('hidden');
      $('modal-close').onclick = null;
      resolve(value);
    };

    buttons.forEach((btn) => {
      const node = document.createElement('button');
      node.className = `tb-btn${btn.primary ? ' primary' : ''}`;
      node.textContent = btn.label;
      // Значение может быть функцией: для форм результат зависит от введённого.
      node.onclick = () => finish(typeof btn.value === 'function' ? btn.value() : btn.value);
      foot.appendChild(node);
    });

    $('modal-close').onclick = () => finish(null);
    box.classList.remove('hidden');
    if (onRender) onRender({ root: $('modal-body'), finish });
  });
}

// ------------------------------------------------------------------ навигатор

const FILE_ICONS = {
  swift: ['S', 'swift'],
  objectivec: ['M', 'objc'],
  objectivecpp: ['M+', 'objc'],
  c: ['C', 'c'],
  cpp: ['C+', 'cpp'],
  xml: ['P', 'plist'],
  json: ['{}', 'json'],
  javascript: ['JS', 'js'],
  typescript: ['TS', 'ts'],
  python: ['Py', 'py'],
  shell: ['$', 'sh'],
  yaml: ['Y', 'yaml'],
  ruby: ['Rb', 'rb'],
  css: ['#', 'css'],
  html: ['<>', 'html'],
  markdown: ['M', 'md'],
  strings: ['"', 'strings'],
  makefile: ['Mk', 'mk'],
  text: ['·', 'text'],
};

/** Имя PNG для типа файла — см. src/renderer/icons/README.md */
const FILE_ICON_NAMES = {
  swift: 'file-swift',
  objectivec: 'file-objc',
  objectivecpp: 'file-objc',
  c: 'file-c',
  cpp: 'file-cpp',
  xml: 'file-plist',
  json: 'file-json',
  javascript: 'file-js',
  typescript: 'file-ts',
  python: 'file-python',
  shell: 'file-shell',
  yaml: 'file-yaml',
  ruby: 'file-ruby',
  css: 'file-css',
  html: 'file-html',
  markdown: 'file-markdown',
  strings: 'file-strings',
  makefile: 'file-makefile',
  text: 'file-text',
};

function iconFor(node) {
  if (node.type === 'dir') {
    return node.bundle
      ? '<span class="f-icon bundle" data-icon="bundle" data-fallback="◈"></span>'
      : '<span class="f-icon dir" data-icon="folder" data-fallback="▸"></span>';
  }
  if (node.type === 'symlink') {
    return '<span class="f-icon link" data-icon="symlink" data-fallback="↗"></span>';
  }
  const [label, variant] = FILE_ICONS[node.language] || FILE_ICONS.text;
  const name = FILE_ICON_NAMES[node.language] || 'file-text';
  // Класс f-icon остаётся: он рисует цветной квадрат, пока PNG не подставлен.
  return `<span class="f-icon ${variant}" data-icon="${name}" data-fallback="${esc(label)}"></span>`;
}

function renderTree() {
  const host = $('tree');
  host.innerHTML = '';
  if (!state.workspace) return;
  host.appendChild(buildTreeDom(state.workspace.tree, 0));
  mountIcons(host);
}

function buildTreeDom(node, depth) {
  const fragment = document.createDocumentFragment();

  for (const child of node.children || []) {
    const hasChildren = child.type === 'dir' && child.children && child.children.length > 0;
    const isOpen = state.expanded.has(child.path);

    const row = document.createElement('div');
    row.className = 'tree-row';
    if (child.bundle) row.classList.add('bundle');
    if (child.type === 'truncated') row.classList.add('truncated');
    if (state.selectedPath === child.path) row.classList.add('selected');
    row.style.paddingLeft = `${6 + depth * 13}px`;
    row.title = child.path;

    const arrow = hasChildren
      ? `<span class="tree-arrow${isOpen ? ' open' : ''}" data-icon="chevron" data-fallback="▶"></span>`
      : '<span class="tree-arrow"></span>';

    const name =
      child.type === 'truncated' ? t('tree.truncated', { count: child.count || '' }) : child.name;

    row.innerHTML = `${arrow}${iconFor(child)}<span class="tree-name">${esc(name)}</span>`;

    row.oncontextmenu = (event) => {
      event.preventDefault();
      state.selectedPath = child.path;
      openContextMenu(event, child);
    };

    row.onclick = () => {
      state.selectedPath = child.path;
      if (child.type === 'dir' && hasChildren) {
        if (isOpen) state.expanded.delete(child.path);
        else state.expanded.add(child.path);
        renderTree();
      } else if (child.type === 'file') {
        openFile(child);
        renderTree();
      }
    };

    fragment.appendChild(row);
    if (child.type === 'dir' && isOpen && hasChildren) {
      fragment.appendChild(buildTreeDom(child, depth + 1));
    }
  }

  return fragment;
}

function findFile(node, predicate) {
  if (!node) return null;
  if (node.type === 'file' && predicate(node)) return node;
  for (const child of node.children || []) {
    const found = findFile(child, predicate);
    if (found) return found;
  }
  return null;
}

function expandTo(node, maxDepth, depth = 0) {
  if (node.type !== 'dir' || depth >= maxDepth) return;
  state.expanded.add(node.path);
  (node.children || []).forEach((child) => {
    if (child.type === 'dir') expandTo(child, maxDepth, depth + 1);
  });
}

// ------------------------------------------------------------------- вкладки

const activeTab = () => state.tabs.find((tab) => tab.path === state.activeTabPath) || null;

function renderTabs() {
  const host = $('tabs');
  host.innerHTML = '';

  state.tabs.forEach((tab) => {
    const node = document.createElement('div');
    node.className = `tab${tab.path === state.activeTabPath ? ' active' : ''}`;
    node.title = tab.path;
    node.innerHTML = `
      ${tab.dirty ? '<span class="tab-dot">•</span>' : ''}
      <span class="tab-name">${esc(tab.name)}</span>
      <span class="tab-close" data-close="1">✕</span>
    `;
    node.onclick = (event) => {
      if (event.target.dataset.close) closeTab(tab.path);
      else activateTab(tab.path);
    };
    host.appendChild(node);
  });

  mountIcons(host);
}

const showWelcome = (visible) => $('welcome').classList.toggle('hidden', !visible);

function activateTab(path) {
  const previous = activeTab();
  if (previous && editor) previous.editorState = editor.getState();

  state.activeTabPath = path;
  const tab = state.tabs.find((item) => item.path === path);
  if (!tab) {
    renderTabs();
    showWelcome(true);
    updatePathBar(null);
    return;
  }

  editor.setState(tab.editorState);
  editor.focus();
  renderTabs();
  showWelcome(false);
  updatePathBar(tab);
}

function updatePathBar(tab) {
  let bar = document.querySelector('.editor-path');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'editor-path';
    document.querySelector('.editor-area').insertBefore(bar, $('editor-host'));
  }
  bar.textContent = tab ? tab.path : '';
}

async function openFile(node) {
  const existing = state.tabs.find((tab) => tab.path === node.path);
  if (existing) {
    activateTab(node.path);
    return;
  }

  try {
    const file = await api.file.read(node.path);
    const tab = {
      path: node.path,
      name: node.name,
      language: node.language,
      dirty: false,
      editorState: null,
    };
    tab.editorState = editor.createState(file.text, node.language);
    state.tabs.push(tab);
    activateTab(node.path);

    if (state.lspRunning) {
      api.lsp.didOpen(node.path, file.text).catch(() => {});
    }
    log(
      t('log.openedFile', { name: node.relative || node.name, size: fmtBytes(file.bytes) }),
      'dim',
    );
  } catch (err) {
    log(t('log.openFileFailed', { name: node.name, error: err.message }), 'error');
  }
}

async function closeTab(path) {
  const index = state.tabs.findIndex((tab) => tab.path === path);
  if (index === -1) return;
  const tab = state.tabs[index];

  if (tab.dirty) {
    const answer = await modal({
      title: t('log.unsavedTitle'),
      body: `<p>${t('log.unsavedBody', { name: tab.name })}</p>`,
      buttons: [
        { label: t('log.saveAndClose'), value: 'save', primary: true },
        { label: t('log.closeWithoutSaving'), value: 'discard' },
        { label: t('modal.cancel'), value: null },
      ],
    });
    if (answer === null) return;
    if (answer === 'save') await saveTab(tab);
  }

  if (state.lspRunning) {
    api.lsp.didClose(path).catch(() => {});
  }
  state.diagnostics.delete(path);
  renderProblems();

  state.tabs.splice(index, 1);
  if (state.activeTabPath === path) {
    const next = state.tabs[Math.max(0, index - 1)];
    if (next) activateTab(next.path);
    else {
      state.activeTabPath = null;
      renderTabs();
      showWelcome(true);
      updatePathBar(null);
    }
  } else {
    renderTabs();
  }
}

async function saveTab(tab) {
  const text = tab.path === state.activeTabPath ? editor.getText() : tab.editorState.doc.toString();
  await api.file.save(tab.path, text);
  tab.dirty = false;
  renderTabs();
  log(t('log.saved', { name: tab.name }), 'ok');
}

async function saveActive() {
  const tab = activeTab();
  if (!tab) return;
  try {
    await saveTab(tab);
  } catch (err) {
    log(t('log.saveFailed', { error: err.message }), 'error');
  }
}

// ------------------------------------------------------------------ инспектор

function showInspector(title, html) {
  $('inspector').classList.remove('hidden');
  $('inspector-title').textContent = title;
  $('inspector-body').innerHTML = html;
  state.lastInspector = { title, html };
}

function renderArchiveInspector(archive) {
  const b = archive.bundle || {};
  const profile = b.profile;

  let html = kv([
    [t('inspector.path'), archive.appPath],
    [t('inspector.bundleId'), b.bundleId || '—'],
    [t('inspector.name'), b.displayName || '—'],
    [t('inspector.version'), b.shortVersion || '—'],
    [t('inspector.buildNumber'), b.buildVersion || '—'],
    [t('inspector.minOs'), b.minimumOSVersion || '—'],
    [t('inspector.platform'), b.platform || '—'],
    [t('inspector.executable'), b.executable || '—'],
    [
      t('inspector.plistFormat'),
      b.plistFormat === 'binary' ? t('inspector.binary') : t('inspector.xml'),
    ],
    [t('inspector.signature'), b.isSigned ? t('inspector.yes') : t('inspector.no')],
    [t('inspector.swiftLibs'), String((archive.swiftDylibs || []).length)],
    [t('inspector.dsym'), String((archive.dsyms || []).length)],
  ]);

  if (archive.archiveSummary) {
    html += `<div class="section-title">${esc(t('inspector.archive'))}</div>`;
    html += kv([
      [t('inspector.scheme'), archive.archiveSummary.scheme || '—'],
      [t('inspector.created'), fmtDate(archive.archiveSummary.creationDate)],
    ]);
  }

  if (profile) {
    const days = profile.daysLeft;
    html += `<div class="section-title">${esc(t('inspector.profile'))}</div>`;
    html += kv([
      [t('inspector.profileName'), profile.name || '—'],
      [t('inspector.team'), `${profile.teamName || '—'} (${profile.teamId || '—'})`],
      [t('inspector.expires'), `${fmtDate(profile.expirationDate)} · ${days !== null ? `${days} d` : '—'}`],
      [t('inspector.devices'), String(profile.provisionedDevices || 0)],
      [
        t('inspector.profileType'),
        profile.isEnterprise
          ? t('inspector.enterprise')
          : profile.getTaskAllow
            ? t('inspector.development')
            : t('inspector.adhoc'),
      ],
    ]);
    if (days !== null && days <= 7 && days >= 0) {
      html += `<p class="chip warn">${esc(t('inspector.expiringSoon'))}</p>`;
    }
  }

  if (b.issues && b.issues.length) {
    html += `<div class="section-title">${esc(t('inspector.issues'))}</div>`;
    html += `<ul class="issue-list">${b.issues.map((issue) => `<li>${esc(issue)}</li>`).join('')}</ul>`;
  }

  showInspector(t('inspector.archive'), html);
}

function renderBuildInspector(result, report) {
  let html = kv([
    [t('inspector.path'), result.outputPath],
    [t('inspector.bundleId'), result.bundle.bundleId || '—'],
    [
      t('inspector.version'),
      `${result.bundle.shortVersion || '—'} (${result.bundle.buildVersion || '—'})`,
    ],
    [
      t('inspector.mode'),
      result.mode === 'appstore' ? t('inspector.modeAppStore') : t('inspector.modeDevice'),
    ],
    [t('inspector.files'), String(result.totalFiles)],
    [t('inspector.contents'), fmtBytes(result.uncompressedBytes)],
    [t('inspector.ipaSize'), fmtBytes(result.ipaBytes)],
  ]);

  html += `<div class="section-title">${esc(t('inspector.check'))}</div>`;
  html += report.ok
    ? `<p>${chip(true, t('inspector.validIpa'), '')}</p>`
    : `<ul class="issue-list">${report.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;

  if (report.notes && report.notes.length) {
    html += `<ul class="issue-list">${report.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
  }

  showInspector(t('inspector.build'), html);
}

// ----------------------------------------------- несколько проектов

/**
 * Сохранить состояние текущего проекта в его запись.
 *
 * Вызывается перед переключением: без этого открытые файлы и раскрытые
 * папки потерялись бы при возврате к проекту.
 */
function stashCurrentProject() {
  if (!state.activeProjectPath || !state.workspace) return;

  const record = state.projects.find((item) => item.path === state.activeProjectPath);
  if (!record) return;

  record.workspace = state.workspace;
  record.tabs = state.tabs;
  record.activeTabPath = state.activeTabPath;
  record.expanded = new Set(state.expanded);
  record.searchResults = state.searchResults;
}

/**
 * Переключиться на проект.
 *
 * Состояние прежнего проекта сохраняется, у нового — восстанавливается,
 * включая открытые файлы и раскрытые папки.
 *
 * @param {string} projectPath путь к папке проекта
 */
async function switchProject(projectPath) {
  if (projectPath === state.activeProjectPath) return;

  let record = state.projects.find((item) => item.path === projectPath);

  // Проект ещё не открывали — загружаем дерево.
  if (!record || !record.workspace) {
    try {
      const payload = await api.workspace.load(projectPath);
      if (!payload) return;

      if (!record) {
        record = { path: projectPath, name: payload.name };
        state.projects.push(record);
      }
      record.workspace = payload;
      record.name = payload.name;
    } catch (error) {
      log(t('projects.loadFailed', { error: error.message }), 'error');
      return;
    }
  }

  stashCurrentProject();
  state.activeProjectPath = projectPath;

  // Восстанавливаем состояние выбранного проекта.
  state.tabs = record.tabs || [];
  state.activeTabPath = record.activeTabPath || null;
  state.expanded = record.expanded ? new Set(record.expanded) : new Set([record.workspace.tree.path]);
  state.searchResults = record.searchResults || null;

  applyWorkspace(record.workspace);

  renderTabs();
  renderSearchResults();
  renderProjects();

  if (state.activeTabPath) await activateTab(state.activeTabPath);
  else editor.clear();

  logHead(t('projects.switched', { name: record.name }));
}

/** Открыть проект отдельной записью и перейти на него. */
async function openProjectTab(payload) {
  const existing = state.projects.find((item) => item.path === payload.path);

  if (existing) {
    existing.workspace = payload;
    existing.name = payload.name;
    await switchProject(payload.path);
    return;
  }

  stashCurrentProject();

  const record = {
    path: payload.path,
    name: payload.name,
    workspace: payload,
    tabs: [],
    activeTabPath: null,
    expanded: new Set([payload.tree.path]),
    searchResults: null,
  };

  state.projects.push(record);
  state.activeProjectPath = payload.path;
  state.tabs = [];
  state.activeTabPath = null;
  state.expanded = record.expanded;
  state.searchResults = null;

  applyWorkspace(payload);
  renderTabs();
  renderSearchResults();
  renderProjects();
}

/** Закрыть проект вместе с его открытыми файлами. */
async function closeProject(projectPath) {
  const index = state.projects.findIndex((item) => item.path === projectPath);
  if (index === -1) return;

  const record = state.projects[index];

  // Предупреждаем о несохранённых файлах.
  const dirty = (record.tabs || []).filter((tab) => tab.dirty);
  if (dirty.length > 0) {
    const answer = await modal({
      title: t('projects.closeTitle'),
      body: `<p>${esc(t('projects.closeDirty', { count: dirty.length }))}</p>`,
      buttons: [
        { label: t('projects.closeAnyway'), value: true },
        { label: t('modal.cancel'), value: null, primary: true },
      ],
    });
    if (!answer) return;
  }

  const wasActive = state.activeProjectPath === projectPath;
  state.projects.splice(index, 1);

  if (!wasActive) {
    renderProjects();
    return;
  }

  // Закрыли активный — переходим на соседний либо очищаем окно.
  if (state.projects.length > 0) {
    const next = state.projects[Math.max(0, index - 1)];
    state.activeProjectPath = null;
    await switchProject(next.path);
    renderProjects();
    return;
  }

  clearWorkspaceState();
}

/** Очистить окно, когда открытых проектов не осталось. */
function clearWorkspaceState() {
  state.workspace = null;
  state.tabs = [];
  state.activeTabPath = null;
  state.expanded = new Set();
  state.searchResults = null;
  state.activeProjectPath = null;

  $('project-name').textContent = t('toolbar.noProject');
  $('project-kind').textContent = t('tree.noProjectKind');

  const schemeSelect = $('scheme-select');
  schemeSelect.innerHTML = '';
  const option = document.createElement('option');
  option.value = '';
  option.textContent = t('toolbar.noSchemes');
  schemeSelect.appendChild(option);

  renderTree();
  renderTabs();
  renderSearchResults();
  renderProjects();
  editor.clear();
}

/** Нарисовать список открытых проектов. */
function renderProjects() {
  const host = $('projects');
  if (!host) return;

  // Один проект — список не нужен, он только занимал бы место.
  const visible = state.projects.length > 1;
  host.classList.toggle('hidden', !visible);
  if (!visible) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML = state.projects
    .map((project) => {
      const active = project.path === state.activeProjectPath;
      const dirty = (project.tabs || []).some((tab) => tab.dirty);
      return (
        `<div class="project-item ${active ? 'active' : ''}" data-path="${esc(project.path)}" title="${esc(project.path)}">` +
        `<span class="project-dot"></span>` +
        `<span class="project-title">${esc(project.name)}${dirty ? ' •' : ''}</span>` +
        `<button class="project-close" data-close="${esc(project.path)}">×</button>` +
        `</div>`
      );
    })
    .join('');

  // Строка переключает проект, крестик закрывает.
  host.querySelectorAll('.project-item').forEach((row) => {
    row.onclick = (event) => {
      if (event.target.closest('[data-close]')) return;
      switchProject(row.dataset.path);
    };
  });

  host.querySelectorAll('[data-close]').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      closeProject(button.dataset.close);
    };
  });
}

// ------------------------------------------------------------------- сценарии

async function handleOpenWorkspace() {
  try {
    const payload = await api.workspace.choose();
    if (!payload) return;

    // Уже открыт — просто переходим на него, не теряя открытые файлы.
    const known = state.projects.find((item) => item.path === payload.path);
    if (known) {
      await switchProject(payload.path);
      return;
    }

    await openProjectTab(payload);
    logHead(t('log.projectOpened', { path: payload.path }));
    if (payload.projects.length) {
      log(t('log.projectsFound', { list: payload.projects.join(', ') }), 'dim');
    }
    if (payload.workspaces.length) {
      log(t('log.workspacesFound', { list: payload.workspaces.join(', ') }), 'dim');
    }
    payload.suggestions.forEach((s) => log(s.note, s.kind === 'none' ? 'warn' : 'dim'));
  } catch (err) {
    log(t('log.openProjectFailed', { error: err.message }), 'error');
  }
}

function applyWorkspace(payload, options = {}) {
  state.workspace = payload;
  if (!options.silent) state.expanded = new Set([payload.tree.path]);

  $('project-name').textContent = payload.name;

  // Проект нашёлся не в той папке, которую выбирали, а на уровень выше:
  // говорим прямо, иначе кажется, что открылось не то.
  if (payload.elevatedFrom) {
    log(
      t('workspace.elevated', { path: payload.path, from: payload.elevatedFrom }),
      'warn',
    );
  }

  // Кнопка переноса показывается, только если найден .xcodeproj.
  const xcodeButton = $('btn-xcode-project');
  if (xcodeButton) {
    const found = (payload.projects || []).length > 0;
    xcodeButton.classList.toggle('hidden', !found);
    if (found) {
      const name = String(payload.projects[0]).split(/[\\/]/).pop().replace(/\.xcodeproj$/i, '');
      xcodeButton.textContent = t('xcode.found', { name, targets: payload.projects.length });
    }
  }

  const kinds = [];
  if (payload.xtoolProjects && payload.xtoolProjects.length) {
    kinds.push(t('tree.kinds.xtool', { count: payload.xtoolProjects.length }));
  }
  if (payload.workspaces.length) {
    kinds.push(t('tree.kinds.workspace', { count: payload.workspaces.length }));
  }
  if (payload.projects.length) {
    kinds.push(t('tree.kinds.projects', { count: payload.projects.length }));
  }
  if (payload.swiftPackages.length) {
    kinds.push(t('tree.kinds.swiftpm', { count: payload.swiftPackages.length }));
  }
  $('project-kind').textContent = kinds.length ? kinds.join(' · ') : t('tree.noProjectKind');

  const schemeSelect = $('scheme-select');
  schemeSelect.innerHTML = '';

  // Схема нужна для сборки. У xtool-проекта нет .xcodeproj, поэтому берём
  // имя пакета из Package.swift — это и есть будущая схема.
  const xtoolCandidates = (payload.xtoolProjects || []).map((item) => ({
    value: item.path,
    label: item.name,
    hint: item.bundleId,
  }));
  const candidates = [...payload.workspaces, ...payload.projects];
  if (candidates.length === 0 && xtoolCandidates.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = t('toolbar.noSchemes');
    schemeSelect.appendChild(option);
  } else {
    xtoolCandidates.forEach((candidate) => {
      const option = document.createElement('option');
      option.value = candidate.value;
      option.textContent = candidate.label;
      if (candidate.hint) option.title = candidate.hint;
      schemeSelect.appendChild(option);
    });

    candidates.forEach((candidate) => {
      const option = document.createElement('option');
      option.value = candidate;
      option.textContent = candidate
        .split(/[\\/]/)
        .pop()
        .replace(/\.(xcodeproj|xcworkspace)$/i, '');
      schemeSelect.appendChild(option);
    });
  }

  renderTree();
  renderProjects();

  // Результаты поиска относились к прежнему проекту.
  state.searchResults = null;
  renderSearchResults();

  // Языковой сервер привязан к папке проекта — при смене перезапускаем.
  if (!options.silent) {
    state.diagnostics.clear();
    renderProblems();
    scheduleLanguageServer();
  }
}

/** Показать разобранный архив: и после диалога, и после перетаскивания. */
function applyArchive(picked) {
  state.archive = picked;
  renderArchiveInspector(picked);
  logHead(t('log.archivePicked', { path: picked.path }));
  log(
    t('log.bundleLine', {
      bundleId: picked.bundle.bundleId || '—',
      version: picked.bundle.shortVersion || '—',
    }),
    'dim',
  );
  picked.bundle.issues.forEach((issue) => log(t('log.issue', { issue }), 'warn'));
  setStatusKey('status.archiveSelected', 'ok');
}

async function handlePickArchive() {
  try {
    const picked = await api.archive.choose();
    if (!picked) return;
    applyArchive(picked);
  } catch (err) {
    log(t('log.archiveFailed', { error: err.message }), 'error');
  }
}

/**
 * Архив перетащили в окно.
 *
 * Это самый надёжный способ: он не зависит от того, как системный диалог
 * показывает .xcarchive — папкой или файлом.
 */
async function handleDroppedFiles(paths) {
  if (!paths || paths.length === 0) return;
  const target = paths[0];

  logHead(t('archive.dropped', { name: target.split(/[\\/]/).pop() }));
  setBusy(true, 'status.loadingArchive');

  try {
    const picked = await api.archive.open(target);
    applyArchive(picked);
  } catch (err) {
    log(t('log.archiveFailed', { error: err.message }), 'error');
    setStatusKey('status.error', 'err');
  } finally {
    setBusy(false);
  }
}

async function askMode() {
  return modal({
    title: t('mode.title'),
    body: `
      <div class="limits-grid">
        <div class="limit-card yes">
          <h4>${esc(t('mode.devTitle'))}</h4>
          <p>${esc(t('mode.devBody'))}</p>
        </div>
        <div class="limit-card">
          <h4>${esc(t('mode.storeTitle'))}</h4>
          <p>${t('mode.storeBody')}</p>
        </div>
      </div>`,
    buttons: [
      { label: t('mode.dev'), value: 'development', primary: true },
      { label: t('mode.store'), value: 'appstore' },
      { label: t('modal.cancel'), value: null },
    ],
  });
}

/**
 * Собрать .ipa из открытого проекта: исходники -> .xcarchive -> .ipa.
 *
 * Так же, как в Xcode. Архив остаётся на диске, и из него можно собрать .ipa
 * повторно — например, после смены подписи.
 */
async function handleBuildFromSource() {
  if (state.busy) return;

  if (!state.workspace) {
    log(t('search.needProject'), 'warn');
    return;
  }

  const mode = await askMode();
  if (!mode) return;

  setBusy(true, null);
  setStatusKey('status.building', 'busy');
  logHead(t('pipeline.building'));

  try {
    const result = await api.build.fromSource({
      distro: state.xtoolDistro,
      mode,
      configuration: state.configuration || 'debug',
    });

    if (!result.ok) {
      log(t('build.failed', { errors: 1, warnings: 0 }), 'error');
      setStatusKey('status.error', 'err');
      return;
    }

    log(t('pipeline.archiveFirst', { path: result.archivePath }), 'dim');
    log(t('pipeline.done', { ipa: result.ipaPath }), 'ok');

    // Архив показываем в инспекторе — с ним дальше работают подпись и проверка.
    try {
      const info = await api.archive.inspect(result.archivePath);
      applyArchive({ ...info, path: result.archivePath, source: 'build' });
    } catch {
      /* инспектор не критичен для результата сборки */
    }

    setStatusKey('status.ready', 'ok');
  } catch (error) {
    log(t('build.error', { error: error.message }), 'error');
    setStatusKey('status.error', 'err');
  } finally {
    setBusy(false);
  }
}

/**
 * Кнопка «Собрать .ipa».
 *
 * Если открыт проект — собираем из исходников через архив. Если загружен
 * только готовый архив — упаковываем .ipa прямо из него.
 */
/** Простой вопрос с двумя кнопками — общий помощник для подтверждений. */
function askConfirm(title, body, okKey = 'common.yes') {
  return modal({
    title,
    body: `<p>${esc(body)}</p>`,
    buttons: [
      { label: t(okKey), value: true, primary: true },
      { label: t('common.cancel'), value: false },
    ],
  });
}

async function handleBuildClick() {
  if (state.workspace) {
    // Проект Xcode сам по себе xtool не соберёт: у него нет Package.swift.
    // Предлагаем конвертацию сразу, иначе сборка упадёт с невнятной ошибкой.
    const path = state.workspace.path;
    const probe = await api.xcode.probe(path).catch(() => ({ kind: 'plain' }));
    if (probe && probe.needsConversion) {
      const agreed = await askConfirm(t('convert.title'), t('convert.offerBody'), 'convert.run');
      if (!agreed) return;
      await handleConvertProject();
      return;
    }
    return handleBuildFromSource();
  }
  return handleBuild();
}

/**
 * Выбрать иконку приложения.
 *
 * xtool не компилирует каталоги ресурсов в Assets.car, поэтому иконка не может
 * попасть в приложение штатным путём. Fcode запоминает картинку и встраивает
 * её в готовый .ipa сразу после сборки.
 */
async function handlePickAppIcon() {
  const picked = await api.icon.choose();
  if (!picked) return;

  state.appIcon = picked;
  log(t('icon.chosen', { path: picked }), 'ok');
  log(t('icon.hint'), 'dim');
}


/**
 * Конвертировать открытый проект Xcode в SwiftPM-пакет.
 *
 * Результат кладётся в папку рядом с исходной: сам проект не меняется, поэтому
 * пользователь всегда может вернуться к исходному виду.
 */
async function handleConvertProject() {
  if (!state.workspace) {
    log(t('convert.noProject'), 'warn');
    return;
  }

  const path = state.workspace.path || state.workspace.root;
  logHead(t('convert.start'));
  setStatusKey('convert.running', 'busy');

  try {
    const result = await api.xcode.convertFull({ projectPath: path, overwrite: true });

    log(t('convert.done', { path: result.outputDir }), 'ok');
    for (const note of result.notes || []) log(`  · ${note}`, 'dim');

    // Сразу открываем результат: собирать дальше нужно именно его.
    const open = await askConfirm(
      t('convert.title'),
      t('convert.openBody', { path: result.outputDir }),
      'convert.open',
    );
    if (open) {
      const payload = await api.workspace.load(result.outputDir);
      if (payload) {
        await openProjectTab(payload);
        logHead(t('log.projectOpened', { path: payload.path }));
      }
    }
  } catch (error) {
    log(t('convert.failed', { error: error.message || String(error) }), 'error');
  } finally {
    setStatusKey('status.ready', 'ok');
  }
}

async function handleBuild() {
  if (state.busy) return;

  try {
    if (!state.archive) {
      log(t('log.noArchive'), 'warn');
      const picked = await api.archive.choose();
      if (!picked) return;
      state.archive = picked;
      renderArchiveInspector(picked);
    }

    const mode = await askMode();
    if (!mode) return;

    const baseName = state.archive.path
      .split(/[\\/]/)
      .pop()
      .replace(/\.(xcarchive|app)$/i, '');
    const outputPath = await api.ipa.saveDialog(`${baseName}.ipa`);
    if (!outputPath) return;

    setBusy(true, null);
    setStatusKey('status.packing', 'busy');
    logHead(t('log.packing', { mode: mode === 'appstore' ? t('mode.store') : t('mode.dev') }));

    const result = await api.ipa.build({
      archivePath: state.archive.path,
      outputPath,
      mode,
      includeSymbols: mode === 'appstore',
    });

    log(t('log.done', { path: result.outputPath }), 'ok');
    log(
      t('log.packSummary', {
        files: result.totalFiles,
        contents: fmtBytes(result.uncompressedBytes),
        size: fmtBytes(result.ipaBytes),
      }),
      'dim',
    );
    if (result.swiftDylibsMoved) log(t('log.swiftMoved'), 'dim');

    const report = await api.ipa.verify(outputPath);
    if (report.ok) log(t('log.verifyPassed'), 'ok');
    else report.issues.forEach((issue) => log(t('log.problem', { issue }), 'warn'));

    renderBuildInspector(result, report);
    setStatusKey('status.ready', 'ok');
    await api.shell.reveal(outputPath);
  } catch (err) {
    log(t('log.packFailed', { error: err.message }), 'error');
    setStatusKey('status.error', 'err');
  } finally {
    setBusy(false);
  }
}

async function handleVerify() {
  if (state.busy) return;
  try {
    const picked = await api.ipa.chooseFile();
    if (!picked) return;
    logHead(t('log.verifyingFile', { path: picked.path }));

    const report = picked.report;
    if (report.ok) log(t('log.verifyStructureOk'), 'ok');
    else report.issues.forEach((issue) => log(t('log.problem', { issue }), 'error'));
    if (report.notes) report.notes.forEach((note) => log(note, 'dim'));
    log(t('log.totalEntries', { count: report.totalEntries }), 'dim');

    const html =
      kv([
        [t('inspector.path'), report.path],
        [t('inspector.app'), report.appRoot || '—'],
        [t('inspector.ipaSize'), fmtBytes(report.sizeBytes)],
        [t('inspector.records'), String(report.totalEntries)],
        [
          t('inspector.result'),
          report.ok
            ? chip(true, t('inspector.correct'), '')
            : chip(false, '', t('inspector.hasProblems')),
        ],
      ]) +
      (report.issues.length
        ? `<div class="section-title">${esc(t('inspector.problems'))}</div><ul class="issue-list">${report.issues
            .map((i) => `<li>${esc(i)}</li>`)
            .join('')}</ul>`
        : '');

    showInspector(t('inspector.verify'), html);
  } catch (err) {
    log(t('log.verifyFailed', { error: err.message }), 'error');
  }
}

async function handleDiagnostics() {
  try {
    const info = await api.tools.check();
    const app = await api.app.info();
    const dash = t('diag.noValue');

    const toolRows = info.tools
      .map(
        (tool) => `<tr>
          <td>${esc(t(`tool.${tool.id}.label`))}${tool.required ? ` <span class="chip bad">${esc(t('diag.required'))}</span>` : ''}</td>
          <td>${tool.available ? chip(true, t('diag.present'), '') : chip(false, '', t('diag.missing'))}</td>
          <td class="mono">${esc(tool.version || dash)}</td>
          <td class="mono">${esc(tool.location || dash)}</td>
        </tr>`,
      )
      .join('');

    const capability = (ok, yesKey, noKey) =>
      ok
        ? `<span class="chip ok">${esc(t(yesKey))}</span>`
        : `<span class="chip warn">${esc(t(noKey))}</span>`;

    const body = `
      <div class="section-title">${esc(t('diag.fcode'))}</div>
      ${kv([
        [t('diag.version'), app.version],
        ['Electron', app.electron],
        ['Node', app.node],
        [t('diag.system'), `${info.platform} / ${info.arch}`],
        [t('diag.dataDir'), `${info.dataDir}${info.dataDirWritable ? '' : ` (${t('diag.noAccess')})`}`],
      ])}

      <div class="section-title">${esc(t('diag.capabilities'))}</div>
      <dl class="kv">
        <dt>${esc(t('diag.ipaPackaging'))}</dt><dd><span class="chip ok">${esc(t('diag.ipaPackagingValue'))}</span></dd>
        <dt>${esc(t('diag.resigning'))}</dt><dd>${capability(info.capabilities.localSigning, 'diag.resigningOk', 'diag.resigningNo')}</dd>
        <dt>${esc(t('diag.cloudBuild'))}</dt><dd>${capability(info.capabilities.cloudBuild, 'diag.cloudBuildOk', 'diag.cloudBuildNo')}</dd>
        <dt>${esc(t('diag.remoteBuild'))}</dt><dd>${capability(info.capabilities.remoteBuild, 'diag.remoteBuildOk', 'diag.remoteBuildNo')}</dd>
      </dl>

      <div class="section-title">${esc(t('diag.tools'))}</div>
      <table class="tool-table">
        <thead><tr>
          <th>${esc(t('diag.tool'))}</th><th>${esc(t('diag.status'))}</th>
          <th>${esc(t('diag.version'))}</th><th>${esc(t('diag.location'))}</th>
        </tr></thead>
        <tbody>${toolRows}</tbody>
      </table>

      ${
        info.missingOptional.length
          ? `<div class="section-title">${esc(t('diag.missingHeading'))}</div><ul class="issue-list">${info.missingOptional
              .map(
                (tool) =>
                  `<li><strong>${esc(t(`tool.${tool.id}.label`))}</strong> — ${esc(t(`tool.${tool.id}.why`))}</li>`,
              )
              .join('')}</ul>`
          : ''
      }
    `;

    modal({
      title: t('diag.title'),
      body,
      buttons: [{ label: t('modal.ok'), value: true, primary: true }],
    });
    logHead(t('diag.done'));
    info.missingOptional.forEach((tool) =>
      log(
        t('log.toolMissing', { label: t(`tool.${tool.id}.label`), why: t(`tool.${tool.id}.why`) }),
        'warn',
      ),
    );
  } catch (err) {
    log(t('diag.failed', { error: err.message }), 'error');
  }
}

async function showLimitations() {
  const card = (kind, titleKey, bodyKey) =>
    `<div class="limit-card ${kind}"><h4>${esc(t(titleKey))}</h4><p>${t(bodyKey)}</p></div>`;

  const body = `
    <p>${esc(t('limits.intro'))}</p>
    <div class="section-title">${esc(t('limits.windows'))}</div>
    <div class="limits-grid">
      ${card('yes', 'limits.packTitle', 'limits.packBody')}
      ${card('yes', 'limits.verifyTitle', 'limits.verifyBody')}
      ${card('yes', 'limits.editTitle', 'limits.editBody')}
    </div>
    <div class="section-title">${esc(t('limits.macOnly'))}</div>
    <div class="limits-grid">
      ${card('no', 'limits.compileTitle', 'limits.compileBody')}
      ${card('no', 'limits.signTitle', 'limits.signBody')}
      ${card('no', 'limits.simTitle', 'limits.simBody')}
    </div>
    <div class="section-title">${esc(t('limits.howTitle'))}</div>
    <div class="limit-card">
      <p>${t('limits.howBody')}</p>
      <p style="margin-top:8px">${t('limits.howBody2')}</p>
      <p style="margin-top:8px">${t('limits.howBody3')}</p>
    </div>
  `;

  modal({
    title: t('limits.title'),
    body,
    buttons: [{ label: t('modal.ok'), value: true, primary: true }],
  });
}

// --------------------------------------------- создание проектов

async function handleNewProject() {
  if (state.busy) return;

  let templates;
  try {
    templates = await api.project.templates();
  } catch (err) {
    log(t('wizard.templatesFailed', { error: err.message }), 'error');
    return;
  }

  const defaultParent = state.workspace ? state.workspace.path : '';

  const body = `
    <div class="wizard">
      <label class="wizard-row">
        <span>${esc(t('wizard.template'))}</span>
        <select id="np-template" class="field-input wide">
          ${templates
            .map(
              (item) =>
                `<option value="${esc(item.id)}">${esc(t(`template.${item.id}.label`))}</option>`,
            )
            .join('')}
        </select>
      </label>
      <div id="np-desc" class="wizard-desc"></div>

      <label class="wizard-row">
        <span>${esc(t('wizard.name'))}</span>
        <input id="np-name" class="field-input wide" placeholder="HelloWorld" autocomplete="off" spellcheck="false" />
      </label>

      <label class="wizard-row">
        <span>${esc(t('wizard.bundleId'))}</span>
        <input id="np-bundle" class="field-input wide" placeholder="com.example.helloworld" autocomplete="off" spellcheck="false" />
      </label>

      <label class="wizard-row">
        <span>${esc(t('wizard.where'))}</span>
        <span class="wizard-path">
          <input id="np-parent" class="field-input wide" readonly value="${esc(defaultParent)}" />
          <button id="np-browse" class="tb-btn small">${esc(t('wizard.browse'))}</button>
        </span>
      </label>

      <div id="np-preview" class="wizard-preview">${esc(t('wizard.fillFirst'))}</div>
    </div>
  `;

  let created = null;

  const answer = await modal({
    title: t('wizard.title'),
    body,
    buttons: [
      {
        label: t('wizard.create'),
        primary: true,
        value: async () => {
          const name = $('np-name').value.trim();
          const parentDir = $('np-parent').value.trim();
          if (!name || !parentDir) return null;

          setBusy(true, 'status.creating');
          try {
            created = await api.project.create({
              parentDir,
              name,
              bundleId: $('np-bundle').value.trim(),
              templateId: $('np-template').value,
            });
            logHead(
              t('wizard.created', {
                name: created.name,
                template: t(`template.${created.template}.label`),
              }),
            );
            log(`${t('inspector.bundleId')}: ${created.bundleId}`, 'dim');
            created.files.forEach((file) => log(t('wizard.fileCreated', { file }), 'dim'));
          } catch (err) {
            log(t('wizard.createFailed', { error: err.message }), 'error');
            setStatusKey('status.error', 'err');
          } finally {
            setBusy(false);
          }
          return true;
        },
      },
      { label: t('modal.cancel'), value: null },
    ],
    onRender: ({ root }) => {
      const nameInput = root.querySelector('#np-name');
      const bundleInput = root.querySelector('#np-bundle');
      const parentInput = root.querySelector('#np-parent');
      const templateSelect = root.querySelector('#np-template');
      const desc = root.querySelector('#np-desc');
      const preview = root.querySelector('#np-preview');

      const updateDesc = () => {
        desc.textContent = t(`template.${templateSelect.value}.description`);
      };

      let timer = null;
      const updatePreview = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          updateDesc();
          const name = nameInput.value.trim();
          if (!name || !parentInput.value.trim()) {
            preview.textContent = t('wizard.fillFirst');
            return;
          }
          try {
            const info = await api.project.preview({
              parentDir: parentInput.value.trim(),
              name,
              bundleId: bundleInput.value.trim(),
              templateId: templateSelect.value,
            });
            const lines = [`${esc(t('wizard.path'))}: <code>${esc(info.path)}</code>`];
            if (info.nameError) lines.push(`<span class="err">${esc(info.nameError)}</span>`);
            else lines.push(`${esc(t('wizard.module'))}: <code>${esc(info.moduleName)}</code>`);
            if (info.bundleIdError) lines.push(`<span class="err">${esc(info.bundleIdError)}</span>`);
            else if (info.bundleId) {
              lines.push(`${esc(t('inspector.bundleId'))}: <code>${esc(info.bundleId)}</code>`);
            }
            if (info.alreadyExists) lines.push(`<span class="err">${esc(t('wizard.exists'))}</span>`);
            if (!info.writable) lines.push(`<span class="err">${esc(t('wizard.notWritable'))}</span>`);
            preview.innerHTML = lines.join('<br />');
          } catch (err) {
            preview.innerHTML = `<span class="err">${esc(err.message)}</span>`;
          }
        }, 150);
      };

      templateSelect.onchange = updatePreview;
      [nameInput, bundleInput].forEach((input) => input.addEventListener('input', updatePreview));

      root.querySelector('#np-browse').onclick = async () => {
        try {
          const chosen = await api.project.chooseParent();
          if (chosen) {
            parentInput.value = chosen;
            updatePreview();
          }
        } catch (err) {
          log(t('wizard.browseFailed', { error: err.message }), 'error');
        }
      };

      updateDesc();
      nameInput.focus();
    },
  });

  if (!answer || !created) return;

  applyWorkspace(created.workspace);
  expandTo(created.workspace.tree, 2);
  renderTree();

  const firstSource =
    findFile(created.workspace.tree, (node) => node.name.endsWith('App.swift')) ||
    findFile(created.workspace.tree, (node) => node.name.endsWith('.swift'));
  if (firstSource) await openFile(firstSource);

  setStatusKey('status.projectCreated', 'ok');
  log(t('wizard.nextStep'), 'dim');
}

// ------------------------------------------- панель сборки без Xcode

const linuxPanel = () => $('linux-panel');

async function openLinuxPanel() {
  linuxPanel().classList.remove('hidden');
  $('inspector').classList.add('hidden');
  await refreshLinux();
}

async function refreshLinux() {
  setStatusKey('status.checkingLinux', 'busy');
  logHead(t('linux.checking'));
  try {
    const env = await api.xtool.check(state.xtoolDistro || undefined);
    state.xtool = env;
    if (env.distro) state.xtoolDistro = env.distro;
    renderLinuxPanel(env);

    env.steps.forEach((step) =>
      log(`${step.done ? '✓' : '·'} ${step.title}: ${step.detail}`, step.done ? 'dim' : 'warn'),
    );
    if (!env.ready) log(`${t('linux.blocker')}: ${env.blocker}`, 'warn');

    setStatusKey(env.ready ? 'status.xtoolReady' : 'status.needsSetup', env.ready ? 'ok' : '');

    // Если учетная запись не подключена — говорим об этом прямо.
    try {
      const account = await api.auth.status(state.xtoolDistro);
      if (!account.loggedIn && env.ready) {
        log(t('account.signedOutBody'), 'warn');
      }
    } catch {
      /* сведения об учетной записи не критичны для проверки окружения */
    }
    return env;
  } catch (err) {
    log(t('linux.checkFailed', { error: err.message }), 'error');
    setStatusKey('status.error', 'err');
    $('linux-steps').innerHTML =
      `<div class="linux-step todo"><div class="linux-step-detail">${esc(err.message)}</div></div>`;
    return null;
  }
}

function renderLinuxPanel(env) {
  $('linux-summary').innerHTML = env.ready
    ? `<span class="chip ok">${esc(t('linux.ready'))}</span>`
    : `<span class="chip bad">${esc(t('linux.blocker'))}</span> ${esc(env.blocker || t('linux.unknown'))}`;

  const host = $('linux-steps');
  host.innerHTML = '';

  env.steps.forEach((step, index) => {
    const node = document.createElement('div');
    node.className = `linux-step ${step.done ? 'done' : 'todo'}`;
    node.innerHTML = `
      <div class="linux-step-head">
        <span class="linux-dot"></span>
        <span class="linux-step-title">${esc(step.title)}</span>
        ${step.admin ? `<span class="chip bad">${esc(t('linux.admin'))}</span>` : ''}
        ${step.needsReboot ? `<span class="chip warn">${esc(t('linux.reboot'))}</span>` : ''}
      </div>
      <div class="linux-step-detail">${esc(step.detail)}</div>
      ${step.hint ? `<div class="linux-step-hint">${esc(step.hint)}</div>` : ''}
      ${step.command ? `<div class="linux-step-cmd">${esc(step.command)}</div>` : ''}
    `;

    // Шаг iOS SDK: кнопка починки видна всегда, даже когда SDK «зарегистрирован».
    // Имя бандла (darwin) ничего не говорит о triple внутри, поэтому проверить
    // и поправить нужно уметь в любой момент, а не только при красной строке.
    if (step.id === 'ios-sdk') {
      const actionRow = document.createElement('div');
      actionRow.className = 'linux-step-buttons';

      const fix = document.createElement('button');
      fix.className = 'tb-btn small primary';
      fix.textContent = t('req.fixSdkHost');
      fix.onclick = () => handleFixSdkHost();
      actionRow.appendChild(fix);

      if (!step.done) {
        const install = document.createElement('button');
        install.className = 'tb-btn small';
        install.textContent = t('sdk.title');
        install.onclick = () => handleSdk();
        actionRow.appendChild(install);
      }

      node.appendChild(actionRow);
    } else if (step.id === 'apple-id') {
      // Вход только через настоящий терминал: xtool сам спросит пароль и код
      // двухфакторной проверки. Своё окно этот диалог вело плохо — Apple
      // отвечала -80045 или вообще не доходило до ввода кода.
      const actionRow = document.createElement('div');
      actionRow.className = 'linux-step-buttons';

      const consoleSignIn = document.createElement('button');
      consoleSignIn.className = 'tb-btn small primary';
      consoleSignIn.textContent = t('auth.signInConsole');
      consoleSignIn.onclick = () => {
        log(t('auth.consoleOpening'), 'dim');
        openWslTerminal('xtool auth login');
      };
      actionRow.appendChild(consoleSignIn);

      const status = document.createElement('button');
      status.className = 'tb-btn small';
      status.textContent = t('linux.check');
      status.onclick = () => refreshLinux();
      actionRow.appendChild(status);

      node.appendChild(actionRow);
    } else if (step.action && !step.done) {
      // Шаг с действием открывает окно: интерактивную команду нельзя запускать
      // вслепую в фоне — ей некому задать вопрос.
      const actionRow = document.createElement('div');
      actionRow.className = 'linux-step-buttons';

      const openDialog = document.createElement('button');
      openDialog.className = 'tb-btn small primary';
      openDialog.textContent = step.action === 'sdk' ? t('sdk.title') : t('account.signIn');
      openDialog.onclick = () => (step.action === 'sdk' ? handleSdk() : startSignIn());
      actionRow.appendChild(openDialog);

      node.appendChild(actionRow);
    } else if (step.command && !step.done) {
      const row = document.createElement('div');
      row.className = 'linux-step-buttons';

      // sudo asks for a password and a background process has no terminal,
      // so those steps are better run in a real WSL console.
      if (/\bsudo\b/.test(step.command) || step.admin) {
        const term = document.createElement('button');
        term.className = 'tb-btn small';
        term.textContent = t('linux.openTerminal');
        term.onclick = () => openWslTerminal(step.command);
        row.appendChild(term);
      } else {
        const run = document.createElement('button');
        run.className = 'tb-btn small primary';
        run.textContent = t('linux.run');
        run.onclick = () => runStep(index);
        row.appendChild(run);
      }

      const copy = document.createElement('button');
      copy.className = 'tb-btn small';
      copy.textContent = t('linux.copy');
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(step.command);
          log(t('linux.copied'), 'dim');
        } catch {
          log(t('linux.copyFailed'), 'warn');
        }
      };
      row.appendChild(copy);

      node.appendChild(row);
    }

    host.appendChild(node);
  });

  mountIcons(host);
}

async function runStep(index) {
  const env = state.xtool;
  if (!env) return;
  const step = env.steps[index];
  if (!step || !step.command) return;

  logHead(t('linux.stepHeading', { title: step.title }));
  setBusy(true, 'status.busy');
  try {
    const result = await api.xtool.run(step.command, state.xtoolDistro);
    log(
      result.ok ? t('linux.commandOk') : t('linux.commandFailed', { code: result.code }),
      result.ok ? 'ok' : 'error',
    );
  } catch (err) {
    log(t('linux.runFailed', { error: err.message }), 'error');
  } finally {
    setBusy(false);
    await refreshLinux();
  }
}

/**
 * Одна кнопка: пройти по всем шагам установки, пропуская уже выполненные.
 * Windows-шаги выполняются с правами администратора, Linux-шаги — от root.
 */
async function runAutoSetup() {
  if (state.busy) return;

  logHead(t('linux.autoStarted'));
  log(t('linux.elevateNote'), 'dim');
  setBusy(true, 'status.busy');

  try {
    const result = await api.xtool.runAll({ distro: state.xtoolDistro });

    if (result.stopped) {
      const reasons = {
        reboot: ['linux.autoReboot', 'warn'],
        cancelled: ['linux.autoCancelled', 'error'],
        'no-distro': ['linux.autoFailed', 'error'],
        'first-run': ['linux.autoFirstRun', 'warn'],
      };
      const entry = reasons[result.stopped.reason];
      if (entry) log(t(entry[0], { step: result.stopped.id }), entry[1]);
      else log(t('linux.autoFailed', { step: result.stopped.id }), 'error');
    }

    const manual = (result.results || []).filter((item) => item.status === 'manual');
    if (manual.length) {
      log(t('linux.autoManual', { what: manual.map((item) => item.needs).join(', ') }), 'warn');
    } else if (!result.stopped) {
      log(t('linux.autoFinished'), 'ok');
    }

    setBusy(false);

    // Автоматическая часть закончилась — доводим дело до конца диалогами.
    // Если была нужна перезагрузка или пользователь отказал, не продолжаем.
    if (!result.stopped) {
      const environment = await refreshLinux();
      await continueSetupInteractively(environment);
    }
  } catch (err) {
    log(t('linux.autoFailed', { step: err.message }), 'error');
    setBusy(false);
    await refreshLinux();
  }
}

async function openWslTerminal(command) {
  try {
    await api.xtool.terminal(command, state.xtoolDistro);
    log(t('linux.terminalOpened'), 'dim');
  } catch (err) {
    log(t('linux.terminalFailed', { error: err.message }), 'error');
  }
}

async function runXtoolAction(action) {
  if (state.busy) return;

  if (action === 'devices') {
    logHead(t('linux.deviceList'));
    try {
      const result = await api.xtool.devices(state.xtoolDistro);
      if (!result.devices.length) log(t('linux.noDevices'), 'warn');
      else result.devices.forEach((line) => log(line, 'info'));
    } catch (err) {
      log(t('linux.deviceListFailed', { error: err.message }), 'error');
    }
    return;
  }

  if (action === 'install') {
    const picked = await api.ipa.chooseFile();
    if (!picked) return;
    logHead(t('linux.installing', { path: picked.path }));
    setBusy(true, 'status.installing');
    try {
      const result = await api.xtool.install({ ipaPath: picked.path, distro: state.xtoolDistro });
      log(
        result.ok ? t('linux.installed') : t('linux.installFailed', { code: result.code }),
        result.ok ? 'ok' : 'error',
      );
    } catch (err) {
      log(t('linux.installError', { error: err.message }), 'error');
    } finally {
      setBusy(false);
    }
    return;
  }

  if (!state.workspace) {
    log(t('linux.needProject'), 'warn');
    return;
  }

  if (action === 'new') {
    logHead(t('linux.creating'));
    setBusy(true, 'status.creating');
    try {
      const result = await api.xtool.create({
        projectPath: state.workspace.path,
        distro: state.xtoolDistro,
      });
      log(
        result.ok ? t('linux.created') : t('linux.createFailed', { code: result.code }),
        result.ok ? 'ok' : 'error',
      );
    } catch (err) {
      log(t('linux.createError', { error: err.message }), 'error');
    } finally {
      setBusy(false);
    }
    return;
  }

  await runXtoolBuild();
}

async function runXtoolBuild() {
  if (!state.workspace) {
    log(t('linux.needProject'), 'warn');
    return;
  }
  if (state.busy) return;

  logHead(`xtool: ${state.workspace.path}`);
  setBusy(true, 'status.busy');
  try {
    const result = await api.xtool.build({
      projectPath: state.workspace.path,
      distro: state.xtoolDistro,
      action: 'dev',
      // Иконка встраивается после сборки: xtool каталоги ресурсов не компилирует.
      iconPath: state.appIcon || null,
    });
    if (result.ok) {
      log(t('linux.commandOk'), 'ok');
      setStatusKey('status.built', 'ok');
    } else {
      log(t('linux.commandFailed', { code: result.code }), 'error');
      setStatusKey('status.error', 'err');
    }
  } catch (err) {
    log(t('linux.runFailed', { error: err.message }), 'error');
    setStatusKey('status.error', 'err');
  } finally {
    setBusy(false);
  }
}

/** Пояснение к панели: то же, что раньше показывалось в модальном окне. */
async function showXtoolInfo() {
  const body = `
    <p>${esc(t('linux.overview'))}</p>
    <div class="limit-card">${t('linux.overviewBody')}</div>
    <div class="limit-card" style="margin-top:10px">${t('linux.license')}</div>
    <div class="limit-card" style="margin-top:10px"><p>${esc(t('linux.sudoNote'))}</p></div>
  `;
  return modal({
    title: t('linux.title'),
    body,
    buttons: [{ label: t('modal.ok'), value: true, primary: true }],
  });
}

// ------------------------------------------- поиск, файлы, сборка, формат

let searchTimer = null;

/** Показать нужную вкладку навигатора. */
function showSidebarTab(name) {
  const current = name === 'problems' || name === 'search' ? name : 'files';
  // Без этой строки панель показывалась, но список не заполнялся:
  // renderProblems выходит раньше, если вкладка считается невидимой.
  state.problemsVisible = current === 'problems';
  $('tab-files').classList.toggle('active', current === 'files');
  $('tab-search').classList.toggle('active', current === 'search');
  $('tab-problems').classList.toggle('active', current === 'problems');

  $('tree').classList.toggle('hidden', current !== 'files');
  $('project-kind').classList.toggle('hidden', current !== 'files');
  $('problems').classList.toggle('hidden', current !== 'problems');
  $('search').classList.toggle('hidden', current !== 'search');

  if (current === 'problems') renderProblems();
  if (current === 'search') {
    $('search-input').focus();
    renderSearchResults();
  }
}

function toggleSearchOption(name) {
  state.searchState[name] = !state.searchState[name];
  const button = {
    caseSensitive: 'search-case',
    wholeWord: 'search-word',
    regex: 'search-regex',
    replaceMode: 'search-replace-toggle',
  }[name];
  if (button) $(button).classList.toggle('active', state.searchState[name]);
  if (name === 'replaceMode') {
    $('search-replace-row').classList.toggle('hidden', !state.searchState.replaceMode);
    if (state.searchState.replaceMode) $('search-replacement').focus();
  }
  scheduleSearch();
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
}

/** Найти совпадения по всему проекту. */
async function runSearch() {
  const query = $('search-input').value;
  state.searchState.query = query;

  if (!state.workspace || !query) {
    state.searchResults = null;
    renderSearchResults();
    return;
  }

  try {
    const result = await api.search.project({
      query,
      caseSensitive: state.searchState.caseSensitive,
      wholeWord: state.searchState.wholeWord,
      regex: state.searchState.regex,
    });
    state.searchResults = result;
    renderSearchResults();
  } catch (err) {
    state.searchResults = null;
    $('search-summary').textContent = err.message;
    $('search-results').innerHTML = '';
  }
}

function renderSearchResults() {
  const host = $('search-results');
  const summary = $('search-summary');
  const result = state.searchResults;

  if (!result) {
    summary.textContent = state.workspace ? t('search.hint') : t('search.needProject');
    host.innerHTML = '';
    return;
  }

  if (result.matches.length === 0) {
    summary.textContent = t('search.nothing', { files: result.filesScanned, ms: result.took });
    host.innerHTML = '';
    return;
  }

  summary.textContent = t('search.summary', {
    matches: result.matches.length,
    files: result.filesMatched,
    ms: result.took,
  }) + (result.truncated ? ` · ${t('search.truncated')}` : '');

  const byFile = new Map();
  for (const match of result.matches) {
    if (!byFile.has(match.path)) byFile.set(match.path, []);
    byFile.get(match.path).push(match);
  }

  const html = [];
  for (const [filePath, list] of byFile) {
    const label = list[0].relative;
    html.push(`<div class="search-file" title="${esc(filePath)}">${esc(label)}</div>`);
    for (const match of list) {
      // Подсвечиваем найденное прямо в строке результата.
      let marked = '';
      let cursor = 0;
      for (const column of match.columns) {
        marked += esc(match.text.slice(cursor, column.start));
        marked += `<mark>${esc(match.text.slice(column.start, column.end))}</mark>`;
        cursor = column.end;
      }
      marked += esc(match.text.slice(cursor));

      html.push(
        `<div class="search-hit" data-path="${esc(match.path)}" data-line="${match.line}" data-char="${match.columns[0] ? match.columns[0].start : 0}">` +
          `<span class="search-line-number">${match.line + 1}</span>` +
          `<span class="search-hit-text">${marked}</span></div>`,
      );
    }
  }
  host.innerHTML = html.join('');

  host.querySelectorAll('.search-hit').forEach((row) => {
    row.onclick = async () => {
      await openPath(row.dataset.path);
      editor.scrollToLine(Number(row.dataset.line), Number(row.dataset.char));
    };
  });
}

/** Заменить все найденные вхождения. */
async function replaceAll() {
  const query = $('search-input').value;
  if (!state.workspace || !query) return;

  const replacement = $('search-replacement').value;
  const answer = await modal({
    title: t('search.replaceTitle'),
    body: `<p>${t('search.replaceConfirm', { query: esc(query), count: state.searchResults ? state.searchResults.matches.length : 0 })}</p>`,
    buttons: [
      { label: t('search.replaceAll'), value: true, primary: true },
      { label: t('modal.cancel'), value: null },
    ],
  });
  if (!answer) return;

  try {
    const result = await api.search.replace({
      query,
      replacement,
      caseSensitive: state.searchState.caseSensitive,
      wholeWord: state.searchState.wholeWord,
      regex: state.searchState.regex,
    });
    logHead(t('search.replaced', { files: result.totalFiles, changes: result.touched.reduce((sum, item) => sum + item.changes, 0) }));
    result.touched.slice(0, 10).forEach((item) => log(`  ${item.relative} — ${item.changes}`, 'dim'));
    result.failed.forEach((item) => log(`  ${item.path}: ${item.error}`, 'error'));

    // Перечитываем открытые вкладки: их содержимое на диске изменилось.
    for (const tab of state.tabs) {
      const node = findFile(state.workspace.tree, (item) => item.path === tab.path);
      if (!node) continue;
      try {
        const fresh = await api.file.read(tab.path);
        tab.editorState = editor.createState(fresh.text, tab.language);
        tab.dirty = false;
      } catch {
        /* файл мог исчезнуть */
      }
    }
    renderTabs();
    if (state.activeTabPath) activateTab(state.activeTabPath);

    await runSearch();
  } catch (err) {
    log(t('search.replaceFailed', { error: err.message }), 'error');
  }
}

// ------------------------------------------------------------ файлы в дереве

function closeContextMenu() {
  const existing = document.getElementById('context-menu');
  if (existing) existing.remove();
}

function openContextMenu(event, node) {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'context-menu';

  const items = [];
  if (node.type === 'dir') {
    items.push({ label: t('tree.newFile'), action: () => createEntry(node.path, false) });
    items.push({ label: t('tree.newFolder'), action: () => createEntry(node.path, true) });
    items.push({ separator: true });
  }
  items.push({ label: t('tree.rename'), action: () => renameEntry(node) });
  items.push({ label: t('tree.reveal'), action: () => api.shell.reveal(node.path) });
  items.push({ separator: true });
  items.push({ label: t('tree.delete'), danger: true, action: () => deleteEntry(node) });

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-sep';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = `context-item${item.danger ? ' danger' : ''}`;
    row.innerHTML = `<span>${esc(item.label)}</span>`;
    row.onclick = () => {
      closeContextMenu();
      item.action();
    };
    menu.appendChild(row);
  }

  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 210)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - menu.childElementCount * 30 - 20)}px`;
  document.body.appendChild(menu);

  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
    document.addEventListener('contextmenu', closeContextMenu, { once: true });
    window.addEventListener('blur', closeContextMenu, { once: true });
  }, 0);
}

/** Спросить строку у пользователя — для имени файла и переименования. */
function promptInput(title, value = '') {
  return modal({
    title,
    body: `<div class="wizard"><label class="wizard-row"><span>${esc(t('tree.name'))}</span>
      <input id="prompt-input" class="field-input wide" value="${esc(value)}" autocomplete="off" spellcheck="false" /></label></div>`,
    buttons: [
      {
        label: t('modal.ok'),
        primary: true,
        value: () => {
          const input = $('prompt-input');
          return input && input.value.trim() ? input.value.trim() : null;
        },
      },
      { label: t('modal.cancel'), value: null },
    ],
    onRender: ({ root }) => {
      const input = root.querySelector('#prompt-input');
      input.focus();
      input.select();
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') $('modal-foot').querySelector('.tb-btn.primary').click();
      });
    },
  });
}

async function createEntry(parentPath, isDirectory) {
  const name = await promptInput(isDirectory ? t('tree.newFolder') : t('tree.newFile'));
  if (!name) return;

  const target = parentPath + (parentPath.endsWith('\\') ? '' : '\\') + name;
  try {
    if (isDirectory) await api.file.createDir(target);
    else await api.file.create(target);
    log(isDirectory ? t('tree.folderCreated', { name }) : t('tree.fileCreated', { name }), 'ok');
    await refreshTree();
  } catch (err) {
    log(t('tree.createFailed', { error: err.message }), 'error');
  }
}

async function renameEntry(node) {
  const name = await promptInput(t('tree.rename'), node.name);
  if (!name || name === node.name) return;

  const parent = node.path.slice(0, node.path.length - node.name.length);
  const target = parent + name;
  try {
    await api.file.rename(node.path, target);
    log(t('tree.renamed', { from: node.name, to: name }), 'ok');
    // Открытая вкладка переезжает вместе с файлом.
    const tab = state.tabs.find((item) => item.path === node.path);
    if (tab) {
      if (state.lspRunning) api.lsp.didClose(tab.path).catch(() => {});
      tab.path = target;
      tab.name = name;
      if (state.activeTabPath === node.path) state.activeTabPath = target;
      renderTabs();
    }
    await refreshTree();
  } catch (err) {
    log(t('tree.renameFailed', { error: err.message }), 'error');
  }
}

async function deleteEntry(node) {
  const answer = await modal({
    title: t('tree.delete'),
    body: `<p>${t('tree.deleteConfirm', { name: esc(node.name) })}
      ${node.type === 'dir' ? `<br /><strong>${esc(t('tree.deleteFolderWarning'))}</strong>` : ''}</p>`,
    buttons: [
      { label: t('tree.delete'), value: true },
      { label: t('modal.cancel'), value: null, primary: true },
    ],
  });
  if (!answer) return;

  try {
    await api.file.remove(node.path);
    log(t('tree.deleted', { name: node.name }), 'ok');
    const tab = state.tabs.find((item) => item.path === node.path);
    if (tab) await closeTab(tab.path);
    await refreshTree();
  } catch (err) {
    log(t('tree.deleteFailed', { error: err.message }), 'error');
  }
}

async function refreshTree() {
  try {
    const payload = await api.workspace.refresh();
    if (payload) applyWorkspace(payload, { silent: true });
  } catch (err) {
    log(t('tree.refreshFailed', { error: err.message }), 'error');
  }
}

// -------------------------------------------------- сборка и форматирование

/** Собрать проект и показать ошибки компилятора в панели «Проблемы». */
async function buildSwiftProject() {
  if (!state.workspace) {
    log(t('search.needProject'), 'warn');
    return;
  }
  if (state.busy) return;

  logHead(t('build.running'));
  setBusy(true, 'status.building');

  try {
    const result = await api.swift.build({ distro: state.xtoolDistro, command: 'swift build' });
    if (result.ok) {
      log(t('build.succeeded'), 'ok');
      setStatusKey('status.built', 'ok');
    } else {
      log(t('build.failed', { errors: result.errors, warnings: result.warnings }), 'error');
      setStatusKey('status.error', 'err');
    }
    if (result.errors + result.warnings > 0) {
      showSidebarTab('problems');
      log(t('build.problemsInPanel'), 'dim');
    }
  } catch (err) {
    log(t('build.error', { error: err.message }), 'error');
    setStatusKey('status.error', 'err');
  } finally {
    setBusy(false);
  }
}

/** Отформатировать активный файл через swift-format. */
async function formatActiveDocument() {
  const tab = activeTab();
  if (!tab) return;

  const before = editor.getText();
  logHead(t('format.running', { name: tab.name }));

  try {
    const result = await api.swift.format({ text: before, distro: state.xtoolDistro });
    if (!result.ok) {
      log(t('format.failed', { error: result.error }), 'error');
      return;
    }
    if (!result.changed) {
      log(t('format.alreadyFormatted'), 'dim');
      return;
    }

    // Заменяем всё содержимое одним действием — так работает отмена.
    editor.view.dispatch({
      changes: { from: 0, to: editor.view.state.doc.length, insert: result.formatted },
    });
    tab.dirty = true;
    renderTabs();
    log(t('format.done'), 'ok');
  } catch (err) {
    log(t('format.failed', { error: err.message }), 'error');
  }
}

// ------------------------------------------------ учетная запись Apple

/** Показать состояние учетной записи; если вход не выполнен — предложить войти. */
async function handleAccount() {
  let status;
  try {
    status = await api.auth.status(state.xtoolDistro);
  } catch (err) {
    log(t('account.failed', { error: err.message }), 'error');
    return;
  }

  if (!status.loggedIn) {
    const answer = await modal({
      title: t('account.signedOutTitle'),
      body: `<p>${esc(t('account.signedOutBody'))}</p>`,
      buttons: [
        { label: t('account.signIn'), value: 'signin', primary: true },
        { label: t('modal.cancel'), value: null },
      ],
    });
    if (answer === 'signin') await startSignIn();
    return;
  }

  const answer = await modal({
    title: t('account.signedInTitle'),
    body:
      `<p>${esc(t('account.signedIn', { appleId: status.appleId || '—' }))}</p>` +
      (status.teamId ? `<p>${esc(t('account.team'))}: <code>${esc(status.teamId)}</code></p>` : '') +
      `<div class="section-title">${esc(t('account.certificates'))}</div>` +
      `<p class="cmd">xtool ds certificates</p>`,
    buttons: [
      { label: t('account.signOut'), value: 'logout' },
      { label: t('account.resetDevice'), value: 'reset' },
      { label: t('modal.close'), value: null, primary: true },
    ],
  });

  if (answer === 'logout') {
    const result = await api.auth.logout(state.xtoolDistro, false);
    log(result.output || t('account.loggedOut'), 'ok');
  } else if (answer === 'reset') {
    const result = await api.auth.logout(state.xtoolDistro, true);
    log(result.output || t('account.deviceReset'), 'ok');
  }
}

/** Открыть окно входа в Apple ID. */
async function startSignIn() {
  logHead(t('auth.title'));
  const result = await openSignIn({ api, t, esc, log, distro: state.xtoolDistro });
  if (result.ok) {
    log(t('auth.success'), 'ok');
    setStatusKey('status.ready', 'ok');
  }
  await refreshLinux();
}

/** Запросить у Apple список сертификатов, профилей или устройств. */
async function showDeveloper(subcommand) {
  const titles = {
    certificates: 'account.certificates',
    profiles: 'account.profiles',
    teams: 'account.teams',
    devices: 'account.devices',
  };

  logHead(t(titles[subcommand] || 'account.title'));
  log(t('account.loading'), 'dim');

  try {
    const result = await api.developer.list(subcommand, state.xtoolDistro);
    if (!result.lines.length) {
      log(t('account.nothing'), 'warn');
      return;
    }
    result.lines.forEach((line) => log(line, 'info'));
  } catch (err) {
    log(t('account.failed', { error: err.message }), 'error');
  }
}


/**
 * Продолжить установку там, где автоматика бессильна.
 *
 * Вход в Apple ID и выбор Xcode требуют окна — их нельзя выполнить командой.
 * Поэтому после автоматических шагов спрашиваем у окружения, что осталось,
 * и сами открываем нужный диалог. Так одна кнопка Run доводит дело до конца.
 *
 * @returns {Promise<boolean>} true, если всё уже готово
 */
async function continueSetupInteractively(environment) {
  let env = environment;

  if (!env) {
    try {
      env = await api.xtool.check(state.xtoolDistro || undefined);
    } catch {
      return false;
    }
  }

  if (env.ready) {
    log(t('req.allReady'), 'ok');
    return true;
  }

  const missing = env.steps.filter((step) => !step.done);

  // Сначала учётная запись: без неё xtool не выпустит сертификат.
  const needsSignIn = missing.some((step) => step.id === 'apple-id');
  if (needsSignIn) {
    const answer = await modal({
      title: t('account.signedOutTitle'),
      body: `<p>${esc(t('account.signedOutBody'))}</p>`,
      buttons: [
        { label: t('account.signIn'), value: true, primary: true },
        { label: t('modal.cancel'), value: null },
      ],
    });
    if (answer) {
      const result = await openSignIn({ api, t, esc, log, distro: state.xtoolDistro });
      if (!result.ok) return false;
    }
  }

  // Затем iOS SDK: без него компилятор не видит SwiftUI и UIKit.
  const needsSdk = env.steps.some((step) => step.id === 'ios-sdk' && !step.done);
  if (needsSdk) {
    logHead(t('sdk.title'));
    await handleSdk();
  }

  return false;
}

/**
 * Перенести проект Xcode в вид, понятный xtool.
 *
 * Сначала показываем, что именно будет записано: файлы создаются только после
 * подтверждения, а существующий Package.swift не затирается молча.
 */
async function handleXcodeProject() {
  if (!state.workspace) {
    log(t('search.needProject'), 'warn');
    return;
  }

  let analysis;
  try {
    analysis = await api.xcode.analyze(state.workspace.path);
  } catch (err) {
    log(t('xcode.failed', { error: err.message }), 'error');
    return;
  }

  logHead(t('xcode.title'));
  log(
    t('xcode.summary', {
      target: analysis.displayName,
      bundle: analysis.build.bundleId || '—',
      ios: analysis.build.deploymentTarget || '—',
      sources: analysis.sources.length,
      packages: analysis.packages.length,
    }),
    'dim',
  );
  analysis.packages.forEach((item) => log(`  ${item.product || item.name} ← ${item.url}`, 'dim'));

  let preview;
  try {
    preview = await api.xcode.convert({ projectPath: state.workspace.path, write: false });
  } catch (err) {
    log(t('xcode.failed', { error: err.message }), 'error');
    return;
  }

  const answer = await modal({
    title: t('xcode.convert'),
    body:
      `<p>${esc(t('xcode.whyBody'))}</p>` +
      `<div class="section-title">${esc(t('xcode.preview'))}` +
      (preview.existing.manifest ? ` — ${esc(t('xcode.manifestExists'))}` : '') +
      `</div>` +
      `<pre class="cmd">${esc(preview.manifest)}</pre>` +
      `<div class="section-title">xtool.yml</div>` +
      `<pre class="cmd">${esc(preview.yml)}</pre>`,
    buttons: [
      { label: t('xcode.write'), value: 'write', primary: true },
      { label: t('modal.cancel'), value: null },
    ],
  });

  if (answer !== 'write') return;

  try {
    const result = await api.xcode.convert({
      projectPath: state.workspace.path,
      write: true,
      overwrite: preview.existing.manifest,
    });
    if (result.written) {
      log(t('xcode.written'), 'ok');
      await refreshTree();
    }
  } catch (err) {
    log(t('xcode.failed', { error: err.message }), 'error');
  }
}

// ------------------------------------------------------- подпись и скачивание

/**
 * Окно подписи .ipa через zsign.
 *
 * Если zsign ещё не установлен, окно предлагает его скачать: сборка с GitHub
 * для Windows уже готова, компилировать ничего не нужно.
 */
async function handleZsign() {
  let status;
  try {
    status = await api.zsign.status();
  } catch (err) {
    log(t('zsign.installFailed', { error: err.message }), 'error');
    return;
  }

  // --- ещё не установлен: предлагаем скачать ---
  if (!status.available) {
    const answer = await modal({
      title: t('zsign.title'),
      body: `<p>${esc(t('zsign.why'))}</p>
        <p class="warn-text">${esc(t('zsign.legal'))}</p>
        <div class="wizard-preview">${esc(t('zsign.notReady'))}</div>`,
      buttons: [
        { label: t('zsign.install'), value: 'install', primary: true },
        { label: t('modal.cancel'), value: null },
      ],
    });

    if (answer !== 'install') return;

    logHead(t('zsign.installing'));
    setBusy(true, 'status.busy');
    try {
      const result = await api.zsign.install();
      log(t('zsign.ready', { version: result.version }), 'ok');
    } catch (err) {
      log(t('zsign.installFailed', { error: err.message }), 'error');
      setBusy(false);
      return;
    } finally {
      setBusy(false);
    }

    status = await api.zsign.status();
  }

  // --- выбор файлов ---
  const chosen = { ipa: null, p12: null, provision: null };

  const buildBody = () => `
    <p>${esc(t('zsign.why'))}</p>
    <div class="wizard">
      <label class="wizard-row">
        <span>${esc(t('zsign.p12'))}</span>
        <span class="wizard-path">
          <input id="zsign-p12" class="field-input wide" readonly value="${esc(chosen.p12 || '')}" />
          <button id="zsign-pick-p12" class="tb-btn small">${esc(t('zsign.choose'))}</button>
        </span>
      </label>
      <label class="wizard-row">
        <span>${esc(t('zsign.provision'))}</span>
        <span class="wizard-path">
          <input id="zsign-prov" class="field-input wide" readonly value="${esc(chosen.provision || '')}" />
          <button id="zsign-pick-prov" class="tb-btn small">${esc(t('zsign.choose'))}</button>
        </span>
      </label>
      <label class="wizard-row">
        <span>${esc(t('zsign.password'))}</span>
        <input id="zsign-pass" class="field-input wide" type="password" autocomplete="off" />
      </label>
      <label class="wizard-row">
        <span>${esc(t('zsign.bundleId'))}</span>
        <input id="zsign-bundle" class="field-input wide" autocomplete="off" spellcheck="false" />
      </label>
      <div class="wizard-preview">${esc(status.path || '')}</div>
    </div>`;

  const answer = await modal({
    title: t('zsign.title'),
    body: buildBody(),
    buttons: [
      { label: t('zsign.start'), value: 'sign', primary: true },
      { label: t('modal.cancel'), value: null },
    ],
    onRender: ({ root }) => {
      const p12Input = root.querySelector('#zsign-p12');
      const provInput = root.querySelector('#zsign-prov');

      root.querySelector('#zsign-pick-p12').onclick = async () => {
        const file = await api.zsign.chooseP12();
        if (!file) return;
        chosen.p12 = file;
        p12Input.value = file;
      };

      root.querySelector('#zsign-pick-prov').onclick = async () => {
        const file = await api.zsign.chooseProvision();
        if (!file) return;
        chosen.provision = file;
        provInput.value = file;
      };
    },
  });

  if (answer !== 'sign') return;

  if (!state.archive) {
    log(t('zsign.needIpa'), 'warn');
    return;
  }
  if (!chosen.p12) {
    log(t('zsign.needP12'), 'warn');
    return;
  }
  if (!chosen.provision) {
    log(t('zsign.needProvision'), 'warn');
    return;
  }

  const password = document.getElementById('zsign-pass') ? document.getElementById('zsign-pass').value : '';
  const bundleId = document.getElementById('zsign-bundle') ? document.getElementById('zsign-bundle').value.trim() : '';

  logHead(t('zsign.working'));
  setBusy(true, 'status.busy');

  try {
    const result = await api.zsign.resign({
      ipaPath: state.ipaPath || state.archive.path,
      p12Path: chosen.p12,
      provisionPath: chosen.provision,
      password,
      bundleId: bundleId || undefined,
    });

    if (result.ok) {
      log(t('zsign.done', { path: result.outputPath }), 'ok');
      setStatusKey('status.ready', 'ok');
    } else {
      log(t('zsign.failed'), 'error');
    }
  } catch (err) {
    log(t('zsign.failed') + ': ' + err.message, 'error');
  } finally {
    setBusy(false);
  }
}

/**
 * Скачивание iOS SDK.
 *
 * Прямой ссылки на Xcode не существует: Apple отдаёт файл только после входа
 * в учётную запись. Поэтому открываем страницу загрузки, а затем ищем уже
 * скачанный файл на диске — вводить путь руками не нужно.
 */
async function handleSdkDownload() {
  const folder = await api.sdk.downloadsFolder();

  const buildBody = async () => {
    const found = await api.sdk.findDownload();

    const list = found.length
      ? found
          .map(
            (item) => `<button class="signin-choice" data-path="${esc(item.path)}">
              <span class="signin-choice-index">xip</span>
              <span>${esc(item.name)} — ${Math.round(item.size / 1024 / 1024)} ${esc(t('sdk.mb'))}</span>
            </button>`,
          )
          .join('')
      : `<div class="wizard-preview">${esc(t('sdk.notFoundXip'))}</div>`;

    return `<p>${esc(t('sdk.downloadsHint'))}</p>
      <pre class="cmd">${esc(folder)}</pre>
      <div class="section-title">${esc(t('sdk.downloading'))}</div>
      <div class="signin-choices">${list}</div>`;
  };

  const answer = await modal({
    title: t('sdk.download'),
    body: await buildBody(),
    buttons: [
      { label: t('sdk.openDownload'), value: 'open', primary: true },
      { label: t('sdk.checkAgain'), value: 'again' },
      { label: t('modal.cancel'), value: null },
    ],
  });

  if (answer === 'open') {
    // Конкретная версия, а не общая страница: мы зафиксировали Xcode 16.4.
    const sdkInfo = await api.sdk.instructions({});
    api.shell.open(sdkInfo.recommendedUrl || sdkInfo.xipUrl);
    log(t('sdk.downloadsHint'), 'dim');
    return;
  }

  if (answer === 'again') {
    // Открываем окно заново — на этот раз список файлов будет свежим.
    await handleSdkDownload();
  }
}

/**
 * Окно настроек.
 *
 * Язык и состояние инструментов переехали сюда из панели: там они занимали
 * место постоянно, хотя нужны редко. Открывается шестерёнкой.
 */
async function handleSettings() {
  let active = 'general';
  // Пока данных нет, показываем значок загрузки — тот же, что при затенении.
  let toolsHtml =
    `<div class="busy-inline"><img class="busy-image" src="loading.gif" alt="" /></div>`;

  // Состояние инструментов подтягиваем один раз при открытии.
  const loadTools = async () => {
    try {
      const result = await api.requirements.check(state.xtoolDistro);
      toolsHtml =
        `<p class="settings-hint">${esc(t('settings.toolsHint'))}</p>` +
        `<table class="tool-table"><thead><tr>` +
        `<th>${esc(t('req.component'))}</th><th>${esc(t('req.required'))}</th>` +
        `<th>${esc(t('req.found'))}</th><th>${esc(t('req.state'))}</th>` +
        `</tr></thead><tbody>` +
        result.rows
          .map(
            (row) =>
              `<tr><td><strong>${esc(row.title)}</strong></td>` +
              `<td class="mono">${esc(row.required)}</td>` +
              `<td class="mono">${esc(row.found || '—')}</td>` +
              `<td>${
                row.ok ? chip(true, t('req.ok'), '') : chip(false, '', t('req.missing'))
              }</td></tr>`,
          )
          .join('') +
        `</tbody></table>`;
    } catch (error) {
      toolsHtml = `<div class="wizard-preview">${esc(t('req.failed', { error: error.message }))}</div>`;
    }
  };

  /** Разметка окна под текущую вкладку. */
  const body = () =>
    `<div class="settings-tabs">` +
    `<button class="settings-tab ${active === 'general' ? 'active' : ''}" data-tab="general">` +
    `${esc(t('settings.tab.general'))}</button>` +
    `<button class="settings-tab ${active === 'tools' ? 'active' : ''}" data-tab="tools">` +
    `${esc(t('settings.tab.tools'))}</button></div>` +
    `<div class="settings-pane">` +
    (active === 'general'
      ? `<div class="wizard">` +
        `<label class="wizard-row"><span>${esc(t('settings.language'))}</span>` +
        `<select id="settings-lang" class="field-input">` +
        `<option value="en" ${getLanguage() === 'en' ? 'selected' : ''}>English</option>` +
        `<option value="ru" ${getLanguage() === 'ru' ? 'selected' : ''}>Русский</option>` +
        `</select></label>` +
        `<div class="wizard-preview">${esc(t('settings.languageHint'))}</div></div>` +
        `<div class="section-title">${esc(t('settings.about'))}</div>` +
        `<p class="settings-hint">${esc(
          t('settings.version', {
            version: (state.appInfo && state.appInfo.version) || '—',
            electron: (state.appInfo && state.appInfo.electron) || '—',
            node: (state.appInfo && state.appInfo.node) || '—',
          }),
        )}</p>` +
        `<div class="section-title">${esc(t('about.repository'))}</div>` +
        `<div class="guide-actions">` +
        `<code class="repo-link">${esc((state.appInfo && state.appInfo.repository) || '')}</code>` +
        `<button class="tb-btn small" id="settings-repo">${esc(t('about.openRepo'))}</button>` +
        `</div>`

      : toolsHtml) +
    `</div>`;

  /** Перерисовать окно, не закрывая его. */
  const redraw = (root) => {
    root.innerHTML = body();

    root.querySelectorAll('.settings-tab').forEach((button) => {
      button.onclick = async () => {
        active = button.dataset.tab;
        if (active === 'tools') await loadTools();
        redraw(root);
      };
    });

    const repo = root.querySelector('#settings-repo');
    if (repo) {
      repo.onclick = () => {
        const url = (state.appInfo && state.appInfo.repository) || '';
        if (url) api.shell.open(url);
      };
    }

    const lang = root.querySelector('#settings-lang');
    if (lang) {
      lang.onchange = async () => {
        await changeLanguage(lang.value);
        redraw(root);
      };
    }
  };

  // Окно открываем сразу, а сведения об инструментах подтягиваем следом:
  // иначе нажатие кнопки выглядело как «ничего не происходит» несколько секунд.
  // Пока данных нет, значок загрузки стоит на месте таблицы.
  const pending = modal({
    title: t('settings.title'),
    body: body(),
    buttons: [
      { label: t('settings.openRequirements'), value: 'requirements' },
      { label: t('modal.close'), value: null, primary: true },
    ],
    onRender: ({ root }) => redraw(root),
  });

  loadTools().then(() => {
    // Перерисовываем, только если вкладка инструментов уже открыта.
    const root = document.getElementById('modal-body');
    if (root && active === 'tools') root.innerHTML = body();
  });

  const answer = await pending;
  if (answer === 'requirements') await handleRequirements();
}

/**
 * Окно «Что нужно установить».
 *
 * Показывает шаги по порядку — это то, что нужно человеку на новом
 * компьютере. Выполненные шаги видны сразу, поэтому понятно, сколько
 * осталось, а у каждого шага есть команда и ссылка на скачивание.
 */
async function handleSetupGuide() {
  let guide;
  try {
    guide = await api.requirements.guide(state.xtoolDistro);
  } catch (error) {
    log(t('req.failed', { error: error.message }), 'error');
    return;
  }

  const stepHtml = (step, index) => {
    const badge = step.done
      ? `<span class="guide-badge done">${esc(t('guide.done'))}</span>`
      : `<span class="guide-badge">${index + 1}</span>`;

    const command = step.command
      ? `<div class="guide-command"><code>${esc(step.command)}</code>` +
        `<button class="tb-btn small" data-copy="${esc(step.command)}">${esc(t('req.copy'))}</button></div>`
      : '';

    const link = step.link
      ? `<button class="tb-btn small" data-open="${esc(step.link)}">${esc(t('guide.openSite'))}</button>`
      : '';

    // Шаги, которым нужен диалог, открывают его кнопкой.
    const action = step.action
      ? `<button class="tb-btn small primary" data-action="${esc(step.action)}">${esc(
          step.action === 'sdk'
            ? t('sdk.title')
            : step.action === 'fix-sdk-host'
              ? t('req.fixSdkHost')
              : step.action === 'sideloadly'
                ? t('sideloadly.install')
                : t('account.signIn'),
        )}</button>`
      : '';

    const actions = command || link || action ? `<div class="guide-actions">${command}${link}${action}</div>` : '';

    return (
      `<div class="guide-step ${step.done ? 'is-done' : ''}">` +
      `<div class="guide-head">${badge}<strong>${esc(step.title)}</strong></div>` +
      `<div class="guide-why">${esc(step.why)}</div>` +
      (step.note ? `<div class="guide-note">${esc(step.note)}</div>` : '') +
      actions +
      `</div>`
    );
  };

  const body =
    `<p class="settings-hint">${esc(
      guide.ready ? t('guide.allReady') : t('guide.left', { count: guide.missing.length }),
    )}</p>` + `<div class="guide-steps">${guide.steps.map(stepHtml).join('')}</div>`;

  const response = await modal({
    title: t('guide.title'),
    body,
    buttons: [
      { label: t('req.button'), value: 'requirements' },
      { label: t('modal.close'), value: null, primary: true },
    ],
    onRender: ({ root }) => {
      root.querySelectorAll('[data-copy]').forEach((button) => {
        button.onclick = async () => {
          await navigator.clipboard.writeText(button.dataset.copy);
          log(t('req.copied'), 'ok');
          const original = button.textContent;
          button.textContent = t('guide.copied');
          setTimeout(() => {
            button.textContent = original;
          }, 1500);
        };
      });

      root.querySelectorAll('[data-open]').forEach((button) => {
        button.onclick = () => api.shell.open(button.dataset.open);
      });

      root.querySelectorAll('[data-action]').forEach((button) => {
        button.onclick = async () => {
          const action = button.dataset.action;
          if (action === 'sdk') await handleSdk();
          else if (action === 'fix-sdk-host') await handleFixSdkHost();
          else if (action === 'signin') await startSignIn();
          else if (action === 'sideloadly') await handleSideloadly();
        };
      });
    },
  });

  if (response === 'requirements') await handleRequirements();
}

/**
 * Дописать triple системы в SDK, чтобы компилятор его увидел.
 *
 * `swift sdk list` показывает darwin даже когда бандл объявлен под другие
 * triple — из-за этого на новой машине сборка падала с «No Swift SDK found
 * matching query arm64-apple-ios», хотя SDK установлен.
 */
async function handleFixSdkHost() {
  setBusy(true, 'status.busy');
  logHead(t('req.fixSdkHostRunning'));

  try {
    const result = await api.requirements.fixSdkHost({ distro: state.xtoolDistro });
    const text = result && result.output ? result.output : '';

    if (!result || !result.ok) {
      // Скрипт печатает понятные маркеры — переводим их в человеческий текст.
      if (/SDK_NOT_INSTALLED/.test(text)) log(t('req.fixSdkNoSdk'), 'warn');
      else if (/HOST_TRIPLE_UNKNOWN/.test(text)) log(t('req.fixSdkNoTriple'), 'warn');
      else log(t('req.fixSdkFailed'), 'error');
      return;
    }

    log(t('req.fixSdkDone'), 'ok');
  } catch (error) {
    log(t('req.fixSdkFailed'), 'error');
    log(String(error.message || error), 'dim');
  } finally {
    setBusy(false);
    await refreshLinux();
  }
}

/**
 * Запустить Sideloadly с последним собранным .ipa.
 *
 * Если сборки нет, сначала собираем: без файла открывать программу незачем.
 * Публичного командного интерфейса у Sideloadly нет, поэтому передаём путь
 * к .ipa аргументом — он подхватывается и подставляется в окно.
 */
async function handleSideloadly() {
  const sideloadly = await api.sideloadly.find();

  // Программы нет: предлагаем скачать.
  if (!sideloadly.installed) {
    const answer = await modal({
      title: t('sideloadly.title'),
      body:
        `<p>${esc(t('sideloadly.why'))}</p>` +
        `<div class="wizard-preview">${esc(t('sideloadly.notInstalled'))}</div>`,
      buttons: [
        { label: t('sideloadly.download'), value: 'download', primary: true },
        { label: t('modal.cancel'), value: null },
      ],
    });

    if (answer === 'download') await api.sideloadly.download();
    return;
  }

  // Ищем готовый .ipa: последний собранный в папке проекта.
  const ipa = state.ipaPath || state.lastIpaPath || null;

  if (!ipa) {
    const answer = await modal({
      title: t('sideloadly.title'),
      body: `<p>${esc(t('sideloadly.noIpa'))}</p>`,
      buttons: [
        { label: t('toolbar.build'), value: 'build', primary: true },
        { label: t('sideloadly.download'), value: 'download' },
        { label: t('modal.cancel'), value: null },
      ],
    });

    if (answer === 'build') await handleBuildClick();
    else if (answer === 'download') await api.sideloadly.download();
    return;
  }

  logHead(t('sideloadly.opening'));
  const result = await api.sideloadly.launch({ ipaPath: ipa });

  if (result.launched) {
    log(t('sideloadly.opened', { path: ipa }), 'ok');
    log(t('sideloadly.hint'), 'dim');
  } else {
    log(t('sideloadly.failed', { error: result.reason || '—' }), 'error');
  }
}

/**
 * Окно «О программе».
 *
 * Автор, версия и отдельным блоком — библиотеки других авторов. Без xtool и
 * Swift собрать iOS-приложение на Windows было бы нельзя, поэтому их авторов
 * указываем явно, а не прячем в общий список зависимостей.
 */
async function handleAbout() {
  let info;
  try {
    info = await api.about.info();
  } catch (error) {
    log(t('about.failed', { error: error.message }), 'error');
    return;
  }

  const creditRow = (item) =>
    `<div class="credit">` +
    `<div class="credit-head"><strong>${esc(item.name)}</strong>` +
    `<span class="credit-license">${esc(item.license)}</span></div>` +
    `<div class="credit-author">${esc(item.author)}</div>` +
    `<div class="credit-role">${esc(item.role)}</div>` +
    `<button class="tb-btn small" data-open="${esc(item.url)}">${esc(t('about.site'))}</button>` +
    `</div>`;

  const body =
    `<div class="about-head">` +
    `<div class="about-name">${esc(info.name)}</div>` +
    `<div class="about-version">${esc(t('about.version', { version: info.version }))}</div>` +
    `</div>` +
    `<p class="settings-hint">${esc(info.description)}</p>` +
    `<div class="about-row"><span>${esc(t('about.author'))}</span><strong>${esc(info.author)}</strong></div>` +
    `<div class="about-row"><span>${esc(t('about.license'))}</span><strong>${esc(info.license)}</strong></div>` +
    `<div class="about-row"><span>${esc(t('about.built'))}</span>` +
    `<strong>Electron ${esc(info.electron)} · Node ${esc(info.node)}</strong></div>` +
    `<div class="about-row"><span>${esc(t('about.repository'))}</span>` +
    `<strong>${esc(info.repository || '')}</strong></div>` +
    `<div class="about-actions">` +
    `<button class="tb-btn small" data-open="${esc(info.repository || '')}">` +
    `${esc(t('about.openRepo'))}</button></div>` +

    `<div class="section-title">${esc(t('about.credits'))}</div>` +
    `<p class="settings-hint">${esc(t('about.creditsHint'))}</p>` +
    `<div class="credits">${info.credits.map(creditRow).join('')}</div>`;

  await modal({
    title: t('about.title'),
    body,
    buttons: [{ label: t('modal.close'), value: null, primary: true }],
    onRender: ({ root }) => {
      root.querySelectorAll('[data-open]').forEach((button) => {
        button.onclick = () => api.shell.open(button.dataset.open);
      });
    },
  });
}

/**
 * Сохранить активный файл.
 *
 * Раньше сохранение было только по сочетанию клавиш — на виду кнопки не было.
 */
async function saveActiveFile() {
  const tab = activeTab();
  if (!tab) {
    log(t('file.nothingToSave'), 'warn');
    return false;
  }

  if (!tab.dirty) {
    log(t('file.saved', { name: tab.name }), 'dim');
    return true;
  }

  try {
    await saveActive();
    log(t('file.saved', { name: tab.name }), 'ok');
    return true;
  } catch (error) {
    log(t('save.failed', { error: error.message }), 'error');
    return false;
  }
}

/** Сохранить все изменённые файлы. */
async function saveAllFiles() {
  const dirty = state.tabs.filter((tab) => tab.dirty);

  if (dirty.length === 0) {
    log(t('file.nothingToSave'), 'dim');
    return;
  }

  let saved = 0;
  for (const tab of dirty) {
    try {
      await api.file.write(tab.path, tab.content);
      tab.dirty = false;
      saved += 1;
    } catch (error) {
      log(t('save.failed', { error: error.message }), 'error');
    }
  }

  renderTabs();
  log(t('file.savedAll', { count: saved }), 'ok');
}

// ------------------------------------------------ индикатор занятости

/**
 * Показать затемнение со значком загрузки.
 *
 * Нужно для операций, которые длятся заметное время: проверка окружения
 * занимает около десяти секунд, установка SDK — минуты. Без признаков работы
 * нажатие кнопки выглядит так, будто ничего не произошло.
 *
 * У показа есть предельное время: если операция зависнет, значок уйдёт сам
 * и интерфейс не останется заблокированным навсегда.
 */
let busyTimer = null;

function showBusy() {
  const overlay = $('busy-overlay');
  if (!overlay) return;

  overlay.classList.remove('hidden');

  // Страховка: если операция не завершится, значок уйдёт сам. Клики он больше
  // не перехватывает (pointer-events: none), поэтому даже зависший значок
  // не мешает работать — но всё равно не должен висеть бесконечно.
  clearTimeout(busyTimer);
  busyTimer = setTimeout(hideBusy, 20000);
}

/** Скрыть значок. */
function hideBusy() {
  clearTimeout(busyTimer);
  const overlay = $('busy-overlay');
  if (overlay) overlay.classList.add('hidden');
}

/**
 * Выполнить длительную операцию со значком загрузки.
 *
 * Значок снимается в любом случае: и при успехе, и при ошибке, и при
 * зависании операции.
 *
 * @param {() => Promise<any>} work что выполнить
 */
async function withBusy(work) {
  showBusy();

  // Даём кадру отрисоваться, иначе затемнение появится только после работы.
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

  try {
    return await work();
  } catch (error) {
    log(t('busy.failed', { error: error.message }), 'error');
    return null;
  } finally {
    hideBusy();
  }
}

// ------------------------------------------------ требования и iOS SDK

/** Показать таблицу: что нужно, какая версия, что есть. */
async function handleRequirements() {
  setStatusKey('status.busy', 'busy');
  try {
    const result = await api.requirements.check(state.xtoolDistro);

    const rows = result.rows
      .map(
        (row) => `<tr>
          <td><strong>${esc(row.title)}</strong>${row.hint ? `<div class="req-hint">${esc(row.hint)}</div>` : ''}</td>
          <td class="mono">${esc(row.required)}</td>
          <td class="mono">${esc(row.found || '—')}</td>
          <td>${row.ok ? chip(true, t('req.ok'), '') : chip(false, '', t('req.missing'))}</td>
        </tr>`,
      )
      .join('');

    const runnable = result.missing.filter((row) => row.command);
    const commands = runnable.map((row) => `<pre class="cmd">${esc(row.command)}</pre>`).join('');

    const buttons = [];
    // Строка «SDK для этой системы» умеет чинить себя сама: показываем кнопку,
    // иначе о проблеме можно узнать, но сделать ничего нельзя.
    const needsSdkFix = result.missing.some((row) => row.action === 'fix-sdk-host');
    if (needsSdkFix) buttons.push({ label: t('req.fixSdkHost'), value: 'fix-sdk', primary: true });

    if (!result.ready) buttons.push({ label: t('req.installAll'), value: 'run', primary: !needsSdkFix });
    if (result.missing.some((row) => row.id === 'ios-sdk')) {
      buttons.push({ label: t('sdk.title'), value: 'sdk' });
    }
    if (runnable.length) buttons.push({ label: t('req.copy'), value: 'copy' });
    buttons.push({ label: t('modal.close'), value: null });

    const answer = await modal({
      title: t('req.title'),
      body:
        `<table class="tool-table">
          <thead><tr>
            <th>${esc(t('req.component'))}</th>
            <th>${esc(t('req.required'))}</th>
            <th>${esc(t('req.found'))}</th>
            <th>${esc(t('req.state'))}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>` +
        (result.ready
          ? `<p class="chip ok" style="margin-top:12px">${esc(t('req.allReady'))}</p>`
          : '') +
        (commands
          ? `<div class="section-title">${esc(t('req.runAll'))}</div>${commands}`
          : ''),
      buttons,
    });

    if (answer === 'run' && result.ready) {
      log(t('req.allReady'), 'ok');
      return;
    }

    if (answer === 'copy') {
      const text = runnable.map((row) => row.command).join('\n');
      await navigator.clipboard.writeText(text);
      log(t('req.copied'), 'ok');
      runnable.forEach((row) => log(`  ${row.command}`, 'dim'));
    } else if (answer === 'fix-sdk') {
      // Чиним и сразу показываем обновлённую таблицу: иначе непонятно, помогло ли.
      await handleFixSdkHost();
      await handleRequirements();
    } else if (answer === 'run') {
      // Если автоматических шагов не осталось, сразу переходим к диалогам.
      if (!runnable.length) await continueSetupInteractively(result);
      else await runAutoSetup();
    } else if (answer === 'sdk') {
      await handleSdk();
    }
  } catch (err) {
    log(t('req.failed', { error: err.message }), 'error');
  } finally {
    setStatusKey('status.ready');
  }
}

/**
 * Установка iOS SDK из скачанного Xcode.
 *
 * Один путь без вариантов: пользователь скачивает Xcode.xip с сайта Apple и
 * указывает к нему путь. Раньше здесь был второй вариант «скопировать с Mac»,
 * который только путал: у кого нет Mac, тому он бесполезен, а поле для пути
 * к .xip при этом отсутствовало вовсе.
 */
async function handleSdk() {
  // Ищем уже скачанный архив, чтобы окно открывалось с готовым путём.
  const found = await api.sdk.findDownload().catch(() => null);
  const initial = found && found.found ? found.path : state.xipPath || '';

  const buildBody = (chosenPath) => `
    <p>${esc(t('sdk.intro'))}</p>
    <div class="wizard">
      <label class="wizard-row">
        <span>${esc(t('sdk.pickXip'))}</span>
        <span class="wizard-path">
          <input id="sdk-path" class="field-input wide" readonly
                 placeholder="${esc(t('sdk.pickXipPlaceholder'))}"
                 value="${esc(chosenPath || '')}" />
          <button id="sdk-pick" class="tb-btn small">${esc(t('sdk.choose'))}</button>
        </span>
      </label>
      <div class="wizard-preview">${esc(t('sdk.pickXipHint'))}</div>
    </div>`;

  let chosenPath = initial;

  const answer = await modal({
    title: t('sdk.title'),
    body: buildBody(initial),
    buttons: [
      { label: t('sdk.openDownload'), value: 'download' },
      { label: t('sdk.install'), value: 'install', primary: true },
      { label: t('modal.cancel'), value: null },
    ],
    onRender: ({ root }) => {
      const input = root.querySelector('#sdk-path');
      const pick = root.querySelector('#sdk-pick');
      if (!pick) return;

      pick.onclick = async () => {
        const selected = await api.sdk.chooseFile();
        if (!selected) return;
        chosenPath = selected;
        if (input) input.value = selected;
      };

      // Путь можно и вписать руками: поле readonly, но вставка из буфера
      // работает — так проще, когда файл лежит на другом диске.
      if (input) {
        input.addEventListener('paste', (event) => {
          const text = (event.clipboardData || window.clipboardData).getData('text');
          if (!text) return;
          event.preventDefault();
          chosenPath = text.trim();
          input.value = chosenPath;
        });
      }
    },
  });

  if (answer === 'download') {
    // Конкретная версия, а не общая страница: мы зафиксировали Xcode 16.4.
    const sdkInfo = await api.sdk.instructions({});
    api.shell.open(sdkInfo.recommendedUrl || sdkInfo.xipUrl);
    return;
  }

  if (answer === 'install') {
    if (!chosenPath) {
      log(t('sdk.needXip'), 'warn');
      return;
    }

    // Определяем, что именно указали: .xip, Xcode.app или папку с ними.
    const source = await api.sdk.resolveSource(chosenPath);
    if (!source || !source.path) {
      log(t('sdk.badPath', { path: chosenPath }), 'error');
      return;
    }

    state.xipPath = chosenPath;
    log(t('sdk.usingSource', { path: source.path, kind: source.kind }), 'dim');

    setBusy(true, 'status.busy');
    logHead(t('sdk.installing'));
    log(t('sdk.takesLong'), 'dim');

    try {
      const result = await api.sdk.install({ path: source.path, distro: state.xtoolDistro, slim: true });
      log(result.ok ? t('sdk.installed') : t('sdk.installFailed', { code: result.code }), result.ok ? 'ok' : 'error');
    } catch (err) {
      log(t('sdk.installFailed', { code: err.message }), 'error');
    } finally {
      setBusy(false);
      await refreshLinux();
    }
  }
}

// ---------------------------------------------- языковой сервер Swift

/** Тип элемента автодополнения LSP -> тип CodeMirror. */
function cmTypeFor(kind) {
  switch (kind) {
    case 2:
    case 3:
      return 'function';
    case 4:
    case 7:
    case 8:
    case 22:
      return 'class';
    case 5:
    case 10:
      return 'property';
    case 6:
      return 'variable';
    case 9:
    case 21:
      return 'namespace';
    case 13:
      return 'enum';
    case 14:
      return 'keyword';
    case 20:
      return 'constant';
    default:
      return 'text';
  }
}

/** Определить язык по расширению — для файлов, открытых вне дерева проекта. */
function languageFromPath(filePath) {
  const ext = String(filePath).split('.').pop().toLowerCase();
  const map = {
    swift: 'swift',
    m: 'objectivec',
    mm: 'objectivecpp',
    h: 'objectivec',
    c: 'c',
    cpp: 'cpp',
    plist: 'xml',
    json: 'json',
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    sh: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    rb: 'ruby',
    css: 'css',
    html: 'html',
    md: 'markdown',
    strings: 'strings',
  };
  return map[ext] || 'text';
}

/** Преобразовать проблему из формата LSP в диапазон CodeMirror. */
function diagnosticToRange(doc, item) {
  try {
    const startLine = doc.line(Math.min((item.line || 0) + 1, doc.lines));
    const from = Math.min(startLine.from + (item.character || 0), startLine.to);
    const endLineNumber = item.endLine === undefined ? item.line || 0 : item.endLine;
    const endLine = doc.line(Math.min(endLineNumber + 1, doc.lines));
    const to = Math.max(from + 1, Math.min(endLine.from + (item.endCharacter || 0), endLine.to));
    return {
      from,
      to,
      severity: item.severity || 'info',
      message: item.message,
      source: item.source,
    };
  } catch {
    return null;
  }
}

/** Проблемы активного файла — их запрашивает линтер редактора. */
function activeDiagnostics() {
  const tab = activeTab();
  if (!tab || !editor) return [];
  const list = [
    ...(state.diagnostics.get(tab.path) || []),
    ...(state.buildDiagnostics.get(tab.path) || []),
  ];
  const doc = editor.view.state.doc;
  return list.map((item) => diagnosticToRange(doc, item)).filter(Boolean);
}

/** Автодополнение через языковой сервер. */
async function lspComplete(context) {
  const tab = activeTab();
  if (!tab || !state.lspRunning) return null;

  const word = context.matchBefore(/[\w.$]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;

  try {
    const position = editor.positionAt(context.pos);
    const items = await api.lsp.completion(tab.path, position.line, position.character);
    if (!items.length) return null;

    return {
      from: word.from,
      validFor: /^[\w.$]*$/,
      options: items.map((item) => ({
        label: item.label,
        type: cmTypeFor(item.kind),
        detail: item.detail || undefined,
        info: item.documentation || undefined,
        apply: item.insertText,
      })),
    };
  } catch {
    return null;
  }
}

/** Подсказка при наведении через языковой сервер. */
async function lspHover(view, pos) {
  const tab = activeTab();
  if (!tab || !state.lspRunning) return null;

  try {
    const position = editor.positionAt(pos);
    const text = await api.lsp.hover(tab.path, position.line, position.character);
    if (!text) return null;
    const line = view.state.doc.lineAt(pos);
    return { from: line.from, to: line.to, text };
  } catch {
    return null;
  }
}

/** Перейти к определению символа под курсором (F12). */
async function goToDefinition() {
  const tab = activeTab();
  if (!tab || !state.lspRunning) return;

  const { line, character } = editor.cursorPosition();
  try {
    const target = await api.lsp.definition(tab.path, line, character);
    if (!target) {
      log(t('lsp.definitionNotFound'), 'warn');
      return;
    }
    if (target.path === tab.path) {
      editor.scrollToLine(target.line, target.character);
      return;
    }
    await openPath(target.path);
    editor.scrollToLine(target.line, target.character);
  } catch (err) {
    log(t('lsp.definitionFailed', { error: err.message }), 'error');
  }
}

/** Открыть файл по пути: сначала ищем в дереве проекта, потом открываем напрямую. */
async function openPath(filePath) {
  const node = findFile(state.workspace ? state.workspace.tree : null, (item) => item.path === filePath);
  if (node) {
    await openFile(node);
    return;
  }
  const name = String(filePath).split(/[\\/]/).pop();
  await openFile({ path: filePath, name, language: languageFromPath(filePath), relative: filePath });
}

let lspStartTimer = null;

/** Запустить сервер с небольшой задержкой — чтобы не дёргать его дважды подряд. */
function scheduleLanguageServer() {
  clearTimeout(lspStartTimer);
  lspStartTimer = setTimeout(() => {
    startLanguageServer();
  }, 400);
}

async function startLanguageServer() {
  if (!state.workspace || state.lspRunning) return;

  logHead(t('lsp.starting'));
  log(t('lsp.indexing'), 'dim');
  setStatusKey('status.lspStarting', 'busy');

  try {
    const result = await api.lsp.start({ distro: state.xtoolDistro });
    state.lspRunning = Boolean(result && result.running);

    // Сервер не знает об уже открытых файлах — сообщаем ему.
    for (const tab of state.tabs) {
      const text = tab.path === state.activeTabPath ? editor.getText() : tab.editorState.doc.toString();
      await api.lsp.didOpen(tab.path, text);
    }

    if (state.lspRunning) setStatusKey('status.lspReady', 'ok');
  } catch (err) {
    state.lspRunning = false;
    log(t('lsp.initFailed', { error: err.message }), 'error');
    setStatusKey('status.error', 'err');
  }
}

async function restartLanguageServer() {
  try {
    await api.lsp.stop();
  } catch {
    /* сервер уже остановлен */
  }
  state.lspRunning = false;
  state.diagnostics.clear();
  renderProblems();
  if (state.workspace) await startLanguageServer();
}

/** Список проблем по всем файлам проекта: и от сервера, и от компилятора. */
function renderProblems() {
  const host = $('problems');
  const all = [];
  for (const list of state.diagnostics.values()) all.push(...list);
  for (const list of state.buildDiagnostics.values()) all.push(...list);

  const errors =
    all.filter((item) => item.severity === 'error').length +
    state.projectIssues.filter((item) => item.severity === 'error').length;

  const badge = $('problems-badge');
  badge.classList.toggle('hidden', all.length === 0);
  badge.classList.toggle('only-warnings', all.length > 0 && errors === 0);
  badge.textContent = String(all.length + state.projectIssues.length);

  if (!state.problemsVisible) return;

  if (all.length === 0 && state.projectIssues.length === 0) {
    host.innerHTML = `<div class="problems-empty">${esc(t('lsp.noProblems'))}</div>`;
    return;
  }

  // Объединяем оба источника по файлам, чтобы не дублировать заголовки.
  const merged = new Map();
  for (const [filePath, list] of [...state.diagnostics, ...state.buildDiagnostics]) {
    const existing = merged.get(filePath) || [];
    merged.set(filePath, [...existing, ...list]);
  }

  const html = [];
  for (const [filePath, list] of merged) {
    const label = String(filePath).split(/[\\/]/).pop();
    html.push(`<div class="problem-file">${esc(label)}</div>`);
    for (const item of list) {
      const symbol = item.severity === 'error' ? '●' : item.severity === 'warning' ? '●' : '●';
      html.push(
        `<div class="problem-row ${esc(item.severity)}" data-path="${esc(item.path)}" data-line="${item.line}" data-char="${item.character}">` +
          `<span class="problem-icon">${symbol}</span>` +
          `<span class="problem-message">${esc(item.message)}</span>` +
          `<span class="problem-where">${item.line + 1}</span></div>`,
      );
    }
  }
  host.innerHTML = html.join('');

  if (state.projectIssues.length) {
    html.push(`<div class="problem-file">${esc(t('build.projectIssues'))}</div>`);
    for (const item of state.projectIssues) {
      html.push(
        `<div class="problem-row ${esc(item.severity)}"><span class="problem-icon">●</span>` +
          `<span class="problem-message">${esc(item.message)}</span></div>`,
      );
    }
  }

  host.innerHTML = html.join('');

  host.querySelectorAll('.problem-row').forEach((row) => {
    row.onclick = async () => {
      await openPath(row.dataset.path);
      editor.scrollToLine(Number(row.dataset.line), Number(row.dataset.char));
    };
  });
}

// -------------------------------------------------------------------- события

function wireEvents() {
  $('btn-open').onclick = handleOpenWorkspace;

  // Перетаскивание: zip, .xcarchive или .app прямо в окно.
  if (api.drop) {
    api.drop.enable();
    api.drop.onDrop((paths) => handleDroppedFiles(paths));
  }
  $('btn-new-project').onclick = handleNewProject;
  // На стартовом экране два главных действия: создать проект или открыть.
  $('welcome-new').onclick = handleNewProject;
  $('welcome-open').onclick = () => withBusy(() => handleOpenWorkspace());
  $('btn-pick-archive').onclick = handlePickArchive;
  $('btn-build').onclick = handleBuildClick;
  $('btn-save').onclick = saveActiveFile;
  $('btn-save-all').onclick = saveAllFiles;
  $('btn-verify').onclick = handleVerify;
  $('btn-convert').onclick = () => withBusy(() => handleConvertProject());
  $('btn-app-icon').onclick = () => withBusy(() => handlePickAppIcon());
  // Кнопки btn-diag больше нет: состояние инструментов переехало в настройки.
  $('btn-lsp').onclick = restartLanguageServer;
  $('tab-search').onclick = () => showSidebarTab('search');
  $('search-input').addEventListener('input', () => scheduleSearch());
  $('search-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') runSearch();
    if (event.key === 'Escape') showSidebarTab('files');
  });
  $('search-replacement').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') replaceAll();
  });
  $('search-case').onclick = () => toggleSearchOption('caseSensitive');
  $('search-word').onclick = () => toggleSearchOption('wholeWord');
  $('search-regex').onclick = () => toggleSearchOption('regex');
  $('search-replace-toggle').onclick = () => toggleSearchOption('replaceMode');
  $('search-replace-all').onclick = replaceAll;
  $('tab-files').onclick = () => showSidebarTab('files');
  $('tab-problems').onclick = () => showSidebarTab('problems');
  $('welcome-limits').onclick = showLimitations;

  // Кнопка панели Linux: панель открывается сразу, а проверка окружения идёт
  // следом и показывает свой ход строкой состояния. Общий значок загрузки здесь
  // не нужен: он закрывал бы экран на всё время проверки WSL.
  $('btn-xtool').onclick = () => openLinuxPanel();

  $('btn-linux-close').onclick = () => linuxPanel().classList.add('hidden');
  $('btn-linux-run').onclick = () => runAutoSetup();
  $('btn-linux-refresh').onclick = () => withBusy(() => refreshLinux());
  $('btn-linux-help').onclick = showXtoolInfo;
  $('btn-linux-new').onclick = () => runXtoolAction('new');
  $('btn-linux-build').onclick = () => runXtoolAction('build');
  $('btn-linux-install').onclick = () => runXtoolAction('install');
  $('btn-linux-devices').onclick = () => runXtoolAction('devices');
  $('btn-account').onclick = handleAccount;
  $('btn-linux-requirements').onclick = () => withBusy(() => handleRequirements());
  $('btn-xcode-project').onclick = handleXcodeProject;
  $('btn-zsign').onclick = handleZsign;
  $('btn-settings').onclick = handleSettings;
  $('btn-setup-guide').onclick = () => withBusy(() => handleSetupGuide());
  $('btn-about').onclick = handleAbout;
  $('btn-sideloadly').onclick = handleSideloadly;

  // Отдельная кнопка для уже распакованного .xcarchive.
  $('btn-pick-archive-folder').onclick = async () => {
    try {
      const picked = await api.archive.chooseFolder();
      if (picked) applyArchive(picked);
    } catch (err) {
      log(t('log.archiveFailed', { error: err.message }), 'error');
    }
  };
  $('btn-ios-sdk').onclick = handleSdk;
  $('btn-ds-certificates').onclick = () => showDeveloper('certificates');
  $('btn-ds-profiles').onclick = () => showDeveloper('profiles');
  $('btn-ds-devices').onclick = () => showDeveloper('devices');

  $('btn-clear-console').onclick = () => {
    consoleEl.innerHTML = '';
  };

  $('btn-refresh').onclick = async () => {
    try {
      const payload = await api.workspace.refresh();
      if (payload) {
        applyWorkspace(payload);
        log(t('tree.refreshed'), 'dim');
      }
    } catch (err) {
      log(t('tree.refreshFailed', { error: err.message }), 'error');
    }
  };

  $('btn-inspector-close').onclick = () => $('inspector').classList.add('hidden');
  $('modal-close').onclick = () => $('modal').classList.add('hidden');

  // Переключателя языка в панели больше нет: он в настройках.

  window.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    if (event.key === 's') {
      event.preventDefault();
      saveActive();
    } else if (event.key === 'b') {
      event.preventDefault();
      handleBuild();
    } else if (event.key === 'n') {
      event.preventDefault();
      handleNewProject();
    } else if (event.key === 'o') {
      event.preventDefault();
      handleOpenWorkspace();
    } else if (event.key === 'F12') {
      event.preventDefault();
      goToDefinition();
    } else if (event.key.toLowerCase() === 'f' && event.shiftKey) {
      event.preventDefault();
      showSidebarTab('search');
      $('search-input').focus();
    } else if (event.key.toLowerCase() === 'f' && event.altKey) {
      event.preventDefault();
      formatActiveDocument();
    } else if (event.key.toLowerCase() === 'b' && event.shiftKey) {
      event.preventDefault();
      buildSwiftProject();
    }
  });

  api.on('menu:save', saveActive);
  api.on('menu:find', () => editor && editor.openFind());
  api.on('menu:buildIpa', handleBuildClick);
  api.on('menu:verifyIpa', handleVerify);
  api.on('menu:limitations', showLimitations);

  api.on('workspace:changed', (payload) => {
    applyWorkspace(payload);
    logHead(t('log.workspaceOpened', { path: payload.path }));
  });

  api.on('archive:ready', ({ path }) => {
    state.archivePath = path;
  });

  api.on('swift:diagnostics', ({ diagnostics, loose }) => {
    state.buildDiagnostics.clear();
    for (const item of diagnostics) {
      const list = state.buildDiagnostics.get(item.path) || [];
      list.push(item);
      state.buildDiagnostics.set(item.path, list);
    }

    // Сообщения без привязки к файлу — например, невозможность доступа
    // к чему-либо. Показываем их в той же панели, но отдельной группой.
    state.projectIssues = loose || [];

    renderProblems();
    editor.refreshDiagnostics();
  });

  // --- языковой сервер ---
  api.on('lsp:status', (status) => {
    state.lspRunning = status.state === 'ready';
    if (status.state === 'starting') setStatusKey('status.lspStarting', 'busy');
    else if (status.state === 'ready') setStatusKey('status.lspReady', 'ok');
    else if (status.state === 'error') setStatusKey('status.error', 'err');
  });

  api.on('lsp:log', (text) => {
    const cleaned = String(text || '').replace(/\r/g, '').trim();
    if (!cleaned) return;
    // Сервер пишет много служебного — показываем только важное.
    if (/error|warning|failed/i.test(cleaned)) log(cleaned, 'warn');
  });

  api.on('lsp:diagnostics', ({ path: filePath, diagnostics }) => {
    if (!filePath) return;
    if (diagnostics.length) state.diagnostics.set(filePath, diagnostics);
    else state.diagnostics.delete(filePath);

    renderProblems();
    const tab = activeTab();
    if (tab && tab.path === filePath) editor.refreshDiagnostics();
  });

  // Build output from the Linux subsystem goes line by line into the console.
  api.on('xtool:output', (payload) => {
    const text = String(payload.text || '').replace(/\r/g, '');
    if (!text.trim()) return;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let kind = 'info';
      if (payload.stream === 'meta') kind = 'head';
      else if (/error|fatal|failed|cannot/i.test(line)) kind = 'error';
      else if (/warning/i.test(line)) kind = 'warn';
      log(line, kind);
    }
  });
}

// ---------------------------------------------------------------------- язык

async function changeLanguage(language) {
  setLanguage(language);
  storeLanguage(language);
  applyStaticTranslations();
  refreshStatusText();

  // The main process builds its own messages, so it needs the same language.
  try {
    await api.app.setLanguage(language);
  } catch {
    /* не критично: интерфейс уже переведён */
  }

  renderTabs();
  updatePathBar(activeTab());
  if (state.workspace) applyWorkspace(state.workspace, { silent: true });
  if (state.archive) renderArchiveInspector(state.archive);

  // Панель Linux обновляем в фоне: её проверка занимает около десяти секунд,
  // и ожидание здесь выглядело как «язык не переключился».
  if (!linuxPanel().classList.contains('hidden')) {
    refreshLinux().catch(() => {
      /* панель обновится при следующей проверке */
    });
  }
}

// ---------------------------------------------------------------------- старт

async function boot() {
  editor = createEditor($('editor-host'), {
    onSave: saveActive,
    onChange: (text) => {
      const tab = activeTab();
      if (!tab) return;
      if (!tab.dirty) {
        tab.dirty = true;
        renderTabs();
      }
      // Сообщаем языковому серверу об изменении — иначе он отстанет.
      if (state.lspRunning) {
        api.lsp.didChange(tab.path, text).catch(() => {});
      }
    },
      diagnostics: () => activeDiagnostics(),
    complete: (context) => lspComplete(context),
    hover: (view, pos) => lspHover(view, pos),
  });

  const language = loadStoredLanguage();
  setLanguage(language);
  applyStaticTranslations();
  // Переключатель языка живёт в настройках, здесь только применяем сохранённый.

  // Сведения о программе нужны окну настроек: версия, Electron, Node.
  // Без этого там показывались прочерки.
  api.about
    .info()
    .then((info) => {
      state.appInfo = info;
    })
    .catch(() => {
      /* окно настроек покажет прочерки, это не критично */
    });

  try {
    await api.app.setLanguage(language);
  } catch {
    /* главный процесс может быть ещё не готов */
  }

  // Состояние доступно для отладки из инструментов разработчика.
  // Состояние и отрисовка доступны для отладки из инструментов разработчика.
  window.__fcode = {
    state,
    editor: () => editor,
    signIn: () => startSignIn(),
    renderProjects,
    switchProject,
    openProjectTab,
  };

  wireEvents();
  // Подставляем PNG-иконки; если файлов ещё нет, останутся текстовые символы.
  mountIcons();
  showWelcome(true);
  setStatusKey('status.ready');



  logHead(t('log.started'));
  log(t('log.packerLocal'), 'dim');
  log(t('log.hintOpen'), 'dim');

  try {
    const info = await api.app.info();
    const tools = await api.tools.check();
    log(t('log.versions', { version: info.version, electron: info.electron, node: info.node }), 'dim');
    tools.tools
      .filter((tool) => !tool.available && !tool.required)
      .forEach((tool) =>
        log(
          t('log.toolMissing', { label: t(`tool.${tool.id}.label`), why: t(`tool.${tool.id}.why`) }),
          'dim',
        ),
      );
  } catch (err) {
    log(t('log.systemInfoFailed', { error: err.message }), 'warn');
  }
}

boot();
