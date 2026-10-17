'use strict';
/*
 * Диагностика окружения: что установлено, чего не хватает.
 *
 * Нужна, потому что FCode зависит от внешних утилит (git для облачной сборки,
 * ssh для связи с Mac, zsign для переподписи). Пользователь должен видеть это
 * сразу, а не узнавать из невнятной ошибки в середине работы.
 */

const { execFile } = require('child_process');
const { t } = require('../../shared/i18n');
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
  {
    id: 'node',
    label: t('tool.node.label'),
    command: 'node',
    args: ['-v'],
    required: true,
    why: t('tool.node.why'),
  },
  {
    id: 'python',
    label: t('tool.python.label'),
    command: 'python',
    args: ['--version'],
    required: false,
    why: t('tool.python.why'),
  },
  {
    id: 'git',
    label: t('tool.git.label'),
    command: 'git',
    args: ['--version'],
    required: false,
    why: t('tool.git.why'),
  },
  {
    id: 'ssh',
    label: t('tool.ssh.label'),
    command: 'ssh',
    args: ['-V'],
    required: false,
    why: t('tool.ssh.why'),
  },
  {
    id: 'zsign',
    label: t('tool.zsign.label'),
    command: 'zsign',
    args: ['-v'],
    required: false,
    why: t('tool.zsign.why'),
  },
  {
    id: 'curl',
    label: t('tool.curl.label'),
    command: 'curl',
    args: ['--version'],
    required: false,
    why: t('tool.curl.why'),
  },
];

function run(command, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      // Многие утилиты печатают версию в stderr (ssh -V) — это не ошибка.
      const output = `${stdout || ''}${stderr || ''}`.trim();
      resolve({
        available: !error || output.length > 0,
        error: error ? error.message : null,
        output: output.split('\n')[0].slice(0, 200),
      });
    });
  });
}

/** Путь к исполняемому файлу через `where` (Windows) — чтобы показать, что нашлось. */
function locate(command) {
  return new Promise((resolve) => {
    execFile('where', [command], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      const first = String(stdout).split(/\r?\n/).find((line) => line.trim());
      resolve(first ? first.trim() : null);
    });
  });
}

async function checkTool(tool) {
  const [result, location] = await Promise.all([run(tool.command, tool.args), locate(tool.command)]);
  return {
    id: tool.id,
    label: tool.label,
    required: tool.required,
    why: tool.why,
    available: result.available,
    version: result.output || null,
    location,
  };
}

async function detectAll() {
  const results = await Promise.all(CANDIDATES.map(checkTool));

  const missingRequired = results.filter((t) => t.required && !t.available);
  const missingOptional = results.filter((t) => !t.required && !t.available);

  // Куда FCode складывает свои данные (конфиг, ключи, журналы).
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
  const dataDir = path.join(home, '.fcode');

  let dataDirWritable = false;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, '.probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    dataDirWritable = true;
  } catch {
    dataDirWritable = false;
  }

  return {
    platform: process.platform,
    arch: process.arch,
    versions: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    },
    dataDir,
    dataDirWritable,
    tools: results,
    missingRequired,
    missingOptional,
    // Возможности, которые включаются при наличии инструментов.
    capabilities: {
      localIpaPackaging: true, // работает всегда, это наш собственный код
      localSigning: results.some((t) => t.id === 'zsign' && t.available),
      cloudBuild: results.some((t) => t.id === 'git' && t.available),
      remoteBuild: results.some((t) => t.id === 'ssh' && t.available),
    },
  };
}

module.exports = { detectAll, checkTool, CANDIDATES };
