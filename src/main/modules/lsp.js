'use strict';
/*
 * Клиент sourcekit-lsp — языкового сервера Swift.
 *
 * Это тот же сервер, которым пользуется Xcode, поэтому он даёт ровно то, чего
 * не хватает редактору: автодополнение, подчёркивание ошибок и предупреждений,
 * подсказки при наведении, переход к определению.
 *
 * Сервер живёт внутри WSL (в Windows его нет), поэтому общение идёт через
 * стандартные потоки процесса wsl.exe. Формат — LSP: заголовок Content-Length,
 * затем JSON.
 *
 * Пути: сервер работает в Linux и о Windows не знает, поэтому наружу интерфейс
 * отдаёт обычные windows-пути, а здесь они переводятся в /mnt/... и в file://.
 */

const { spawn } = require('child_process');
const path = require('path');
const { t } = require('../../shared/i18n');

const DEFAULT_DISTRO = 'Ubuntu';
const INIT_TIMEOUT = 120000;
const REQUEST_TIMEOUT = 60000;

/** Windows-путь -> путь внутри WSL. */
function toWslPath(windowsPath) {
  const resolved = path.resolve(windowsPath);
  const match = /^([A-Za-z]):\\(.*)$/.exec(resolved);
  if (!match) return resolved.replace(/\\/g, '/');
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

/** Путь WSL -> URI, который понимает языковой сервер. */
function toFileUri(wslPath) {
  const encoded = wslPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `file://${encoded}`;
}

/** URI -> Windows-путь (для сообщений обратно в интерфейс). */
function uriToWindowsPath(uri) {
  const withoutScheme = decodeURIComponent(String(uri).replace(/^file:\/\//, ''));
  const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(withoutScheme);
  if (!match) return withoutScheme;
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`;
}

/** Языковой идентификатор по расширению — его ждёт сервер. */
function languageIdFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.swift') return 'swift';
  if (['.m', '.mm', '.h', '.hpp'].includes(ext)) return 'objective-c';
  if (ext === '.c') return 'c';
  if (['.cpp', '.cc', '.cxx'].includes(ext)) return 'cpp';
  if (ext === '.json') return 'json';
  if (ext === '.md') return 'markdown';
  return 'plaintext';
}

class LspClient {
  /**
   * @param {{distro?: string, projectPath: string, onDiagnostics?: Function, onLog?: Function, onStatus?: Function}} options
   */
  constructor(options) {
    this.distro = options.distro || DEFAULT_DISTRO;
    this.projectPath = options.projectPath;
    this.onDiagnostics = options.onDiagnostics || (() => {});
    this.onLog = options.onLog || (() => {});
    this.onStatus = options.onStatus || (() => {});

    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    /** @type {Map<string, {version: number, text: string}>} */
    this.documents = new Map();
    this.open = false;
  }

  get wslProjectPath() {
    return toWslPath(this.projectPath);
  }

  /** Запустить сервер. Повторный вызов безопасен. */
  async start() {
    if (this.child) return true;

    this.onStatus({ state: 'starting' });
    this.onLog(`${t('lsp.starting')}\n`);

    const args = ['-d', this.distro, '--cd', this.wslProjectPath, '--', 'sourcekit-lsp'];

    this.child = spawn('wsl.exe', args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', (chunk) => this.consume(chunk));
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.onLog(`${text}\n`);
    });

    // Поток ввода тоже может оборваться: языковой сервер умирает, например,
    // когда перезапускают подсистему Linux. Без обработчика событие «error»
    // на потоке остаётся необработанным и роняет всё приложение с EPIPE.
    this.child.stdin.on('error', (error) => {
      if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') return;
      this.onLog(`${t('lsp.crashed', { error: error.message })}\n`);
    });

    this.child.on('error', (error) => {
      this.onLog(`${t('lsp.crashed', { error: error.message })}\n`);
      this.onStatus({ state: 'error', error: error.message });
      this.child = null;
    });

    this.child.on('close', (code) => {
      this.onStatus({ state: 'stopped', code });
      this.onLog(`${t('lsp.stopped', { code })}\n`);
      this.child = null;
      this.open = false;
      for (const [, request] of this.pending) request.reject(new Error(t('lsp.stopped', { code })));
      this.pending.clear();
    });

    try {
      const result = await this.request(
        'initialize',
        {
          processId: process.pid,
          clientInfo: { name: 'FCode', version: '0.1.0' },
          rootUri: toFileUri(this.wslProjectPath),
          workspaceFolders: [{ uri: toFileUri(this.wslProjectPath), name: path.basename(this.projectPath) }],
          capabilities: {
            textDocument: {
              synchronization: { dynamicRegistration: false, didSave: true },
              completion: {
                completionItem: { snippetSupport: false, documentationFormat: ['markdown', 'plaintext'] },
              },
              hover: { contentFormat: ['markdown', 'plaintext'] },
              definition: {},
              publishDiagnostics: { relatedInformation: true },
            },
            workspace: { configuration: true, workspaceFolders: true },
          },
          initializationOptions: {},
        },
        INIT_TIMEOUT,
      );

      this.notify('initialized', {});
      this.open = true;
      this.onStatus({ state: 'ready' });
      this.onLog(`${t('lsp.ready')}\n`);
      return result;
    } catch (error) {
      this.onLog(`${t('lsp.initFailed', { error: error.message })}\n`);
      this.onStatus({ state: 'error', error: error.message });
      this.stop();
      return null;
    }
  }

  stop() {
    if (!this.child) return;
    try {
      this.notify('exit', {});
    } catch {
      /* уже недоступен */
    }
    try {
      this.child.kill();
    } catch {
      /* уже завершился */
    }
    this.child = null;
    this.open = false;
  }

  // ------------------------------------------------------------ транспорт

  /** Разобрать входящий поток на сообщения по заголовку Content-Length. */
  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      const separator = this.buffer.indexOf('\r\n\r\n');
      if (separator === -1) return;

      const header = this.buffer.subarray(0, separator).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Непонятный заголовок — сбрасываем буфер, чтобы не застрять.
        this.buffer = this.buffer.subarray(separator + 4);
        continue;
      }

      const length = Number(match[1]);
      const start = separator + 4;
      if (this.buffer.length < start + length) return;

      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);

      try {
        this.handleMessage(JSON.parse(body));
      } catch (error) {
        this.onLog(`не удалось разобрать сообщение сервера: ${error.message}\n`);
      }
    }
  }

  handleMessage(message) {
    // Ответ на наш запрос.
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || 'ошибка сервера'));
      else request.resolve(message.result);
      return;
    }

    // Запрос от сервера — на него обязательно нужно ответить.
    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    // Уведомление.
    if (message.method === 'textDocument/publishDiagnostics') {
      const diagnostics = (message.params.diagnostics || []).map((item) => ({
        path: uriToWindowsPath(message.params.uri),
        message: item.message,
        severity: ['error', 'warning', 'info', 'hint'][item.severity - 1] || 'info',
        line: item.range.start.line,
        character: item.range.start.character,
        endLine: item.range.end.line,
        endCharacter: item.range.end.character,
        source: item.source || 'sourcekit-lsp',
      }));
      this.onDiagnostics({
        uri: message.params.uri,
        path: uriToWindowsPath(message.params.uri),
        diagnostics,
      });
      return;
    }

    if (message.method === 'window/logMessage') {
      this.onLog(`${message.params.message}\n`);
      return;
    }

    if (message.method === 'window/showMessage') {
      this.onLog(`${message.params.message}\n`);
    }
  }

  /** Ответы на запросы сервера: без них он может зависнуть на ожидании. */
  handleServerRequest(message) {
    const reply = (result) => this.write({ jsonrpc: '2.0', id: message.id, result });

    switch (message.method) {
      case 'workspace/configuration': {
        // Отдаём пустые настройки для каждого запрошенного раздела.
        const items = (message.params.items || []).map(() => ({}));
        reply(items);
        break;
      }
      case 'client/registerCapability':
      case 'client/unregisterCapability':
        reply(null);
        break;
      case 'window/workDoneProgress/create':
        reply(null);
        break;
      default:
        reply(null);
    }
  }

  write(message) {
    const stdin = this.child && this.child.stdin;
    if (!stdin || !stdin.writable) return;

    const body = Buffer.from(JSON.stringify(message), 'utf8');

    // Языковой сервер может умереть в любой момент — например, когда
    // перезапускают WSL. Запись в закрытый поток даёт EPIPE, и без обработки
    // это роняет всё приложение: проверка writable не спасает, потому что
    // процесс успевает завершиться между проверкой и записью.
    try {
      stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      stdin.write(body);
    } catch (error) {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') throw error;
      this.onClosed && this.onClosed();
    }
  }

  request(method, params, timeout = REQUEST_TIMEOUT) {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`таймаут запроса ${method}`));
      }, timeout);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  // --------------------------------------------------------- документы

  openDocument(windowsPath, text) {
    const uri = toFileUri(toWslPath(windowsPath));
    this.documents.set(uri, { version: 1, text });
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: languageIdFor(windowsPath), version: 1, text },
    });
  }

  changeDocument(windowsPath, text) {
    const uri = toFileUri(toWslPath(windowsPath));
    const existing = this.documents.get(uri);
    const version = existing ? existing.version + 1 : 1;
    this.documents.set(uri, { version, text });

    if (!existing) {
      // Файл ещё не открывали — серверу нужно именно didOpen.
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: languageIdFor(windowsPath), version, text },
      });
      return;
    }

    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  closeDocument(windowsPath) {
    const uri = toFileUri(toWslPath(windowsPath));
    if (!this.documents.has(uri)) return;
    this.documents.delete(uri);
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  position(windowsPath, line, character) {
    return {
      textDocument: { uri: toFileUri(toWslPath(windowsPath)) },
      position: { line, character },
    };
  }

  /** Автодополнение в позиции курсора. */
  async completion(windowsPath, line, character) {
    if (!this.open) return [];
    const result = await this.request('textDocument/completion', {
      ...this.position(windowsPath, line, character),
      context: { triggerKind: 1 },
    });
    const items = Array.isArray(result) ? result : (result && result.items) || [];
    return items.slice(0, 200).map((item) => ({
      label: item.label,
      detail: item.detail || '',
      kind: item.kind || 1,
      documentation:
        typeof item.documentation === 'string' ? item.documentation : item.documentation?.value || '',
      insertText: item.insertText || item.label,
      sortText: item.sortText || item.label,
    }));
  }

  /** Подсказка при наведении. */
  async hover(windowsPath, line, character) {
    if (!this.open) return null;
    const result = await this.request('textDocument/hover', this.position(windowsPath, line, character));
    if (!result || !result.contents) return null;
    const contents = result.contents;
    if (typeof contents === 'string') return contents;
    if (Array.isArray(contents)) {
      return contents.map((part) => (typeof part === 'string' ? part : part.value)).join('\n');
    }
    return contents.value || null;
  }

  /** Переход к определению — возвращает windows-путь и позицию. */
  async definition(windowsPath, line, character) {
    if (!this.open) return null;
    const result = await this.request(
      'textDocument/definition',
      this.position(windowsPath, line, character),
    );
    const item = Array.isArray(result) ? result[0] : result;
    if (!item || !item.uri) return null;
    return {
      path: uriToWindowsPath(item.uri),
      line: item.range ? item.range.start.line : 0,
      character: item.range ? item.range.start.character : 0,
    };
  }
}

module.exports = { LspClient, toWslPath, toFileUri, uriToWindowsPath, languageIdFor };
