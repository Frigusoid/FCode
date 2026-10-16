/*
 * Сборка renderer'а через esbuild.
 *
 * Renderer подключает CodeMirror 6, который распространяется как ESM и требует
 * сборки. esbuild выбран за скорость и отсутствие конфигурации.
 * Главный процесс (main) не собирается — он обычный CommonJS.
 */

import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const options = {
  entryPoints: [path.join(root, 'src/renderer/src/index.js')],
  outfile: path.join(root, 'src/renderer/dist/bundle.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: true,
  logLevel: 'info',
  minify: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
  },
};

const watch = process.argv.includes('--watch');

fs.mkdirSync(path.join(root, 'src/renderer/dist'), { recursive: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('esbuild: слежу за изменениями renderer…');
} else {
  await build(options);
  console.log('esbuild: renderer собран');
}
