'use strict';
/*
 * Проверки поиска проекта уровнем выше.
 *
 * Люди открывают папку с исходниками («Pocket Poster»), тогда как сам проект
 * («Pocket Poster.xcodeproj») лежит рядом с ней. Раньше такая папка считалась
 * обычной, и сборка молча ничего не делала.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workspace = require('../src/main/modules/workspace');

/** Макет: корень с .xcodeproj и вложенной папкой исходников. */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-elev-'));

  const proj = path.join(root, 'Demo.xcodeproj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'project.pbxproj'), '// pbxproj', 'utf8');

  const sources = path.join(root, 'Demo');
  fs.mkdirSync(path.join(sources, 'Views'), { recursive: true });
  fs.writeFileSync(path.join(sources, 'App.swift'), 'import SwiftUI\n', 'utf8');
  fs.writeFileSync(path.join(sources, 'Views', 'Home.swift'), 'import SwiftUI\n', 'utf8');

  return root;
}

test('находит проект в выбранной папке', () => {
  const root = makeProject();
  const found = workspace.detectProjects(root);

  assert.strictEqual(found.projects.length, 1);
  assert.ok(found.projects[0].endsWith('Demo.xcodeproj'));
  assert.strictEqual(found.elevatedFrom, undefined);
});

test('поднимается на уровень выше из папки с исходниками', () => {
  const root = makeProject();
  const found = workspace.detectProjects(path.join(root, 'Demo'));

  assert.strictEqual(found.projects.length, 1, 'проект должен найтись наверху');
  assert.strictEqual(found.elevatedFrom, path.join(root, 'Demo'));
  assert.strictEqual(found.resolvedRoot, root);
});

test('поднимается только на один уровень', () => {
  const root = makeProject();
  // Здесь проект на два уровня выше — подъём туда не выполняется намеренно:
  // иначе поиск уходил бы вверх до корня диска.
  const found = workspace.detectProjects(path.join(root, 'Demo', 'Views'));

  assert.strictEqual(found.projects.length, 0);
  assert.strictEqual(found.elevatedFrom, undefined);
});

test('не поднимается, если проект есть на месте', () => {
  const root = makeProject();
  const found = workspace.detectProjects(root);

  assert.strictEqual(found.resolvedRoot, undefined);
});

test('не поднимается выше, если наверху тоже ничего нет', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-empty-'));
  const inner = path.join(dir, 'inner');
  fs.mkdirSync(inner);

  // Временная папка не содержит проекта ни в inner, ни в dir.
  const found = workspace.detectProjects(inner);
  assert.strictEqual(found.projects.length, 0);
  assert.strictEqual(found.elevatedFrom, undefined);
});
