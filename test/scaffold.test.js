'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const scaffold = require('../src/main/modules/scaffold');
const h = require('./helpers');

test('мастер создания: шаблон SwiftUI даёт проект, пригодный для xtool', () => {
  const dir = h.makeTempDir();
  try {
    const result = scaffold.createProject({
      parentDir: dir,
      name: 'Hello',
      bundleId: 'com.acme.hello',
      templateId: 'swiftui',
    });

    assert.strictEqual(result.path, path.join(dir, 'Hello'));
    assert.strictEqual(result.moduleName, 'Hello');
    assert.strictEqual(result.bundleId, 'com.acme.hello');

    // xtool ждёт именно такой набор файлов.
    for (const required of [
      'Package.swift',
      'xtool.yml',
      'Sources/Hello/HelloApp.swift',
      'Sources/Hello/ContentView.swift',
      '.gitignore',
      'README.md',
    ]) {
      assert.ok(fs.existsSync(path.join(dir, 'Hello', required)), `нет файла ${required}`);
    }

    const manifest = fs.readFileSync(path.join(dir, 'Hello', 'Package.swift'), 'utf8');
    assert.match(manifest, /swift-tools-version: 6\.0/);
    assert.match(manifest, /\.library\(\s*\n\s*name: "Hello"/);
    assert.match(manifest, /\.iOS\(\.v17\)/);
    // Ровно одна цель и без зависимостей — так выглядит шаблон самого xtool.
    assert.strictEqual((manifest.match(/\.target\(/g) || []).length, 1);
    // Продукт должен быть библиотекой: xtool сам превращает её в приложение.
    assert.doesNotMatch(manifest, /\.executable\(/);

    const yml = fs.readFileSync(path.join(dir, 'Hello', 'xtool.yml'), 'utf8');
    assert.match(yml, /^version: 1$/m);
    assert.match(yml, /^bundleID: com\.acme\.hello$/m);

    const app = fs.readFileSync(path.join(dir, 'Hello', 'Sources', 'Hello', 'HelloApp.swift'), 'utf8');
    assert.match(app, /@main/);
    assert.match(app, /struct HelloApp: App/);
  } finally {
    h.rmrf(dir);
  }
});

test('мастер создания: шаблон с Objective-C подключает C-цель', () => {
  const dir = h.makeTempDir();
  try {
    const result = scaffold.createProject({
      parentDir: dir,
      name: 'MixedApp',
      templateId: 'swiftui-objc',
    });

    const base = path.join(dir, 'MixedApp');
    for (const required of [
      'Sources/MixedApp/MixedAppApp.swift',
      'Sources/MixedApp/ContentView.swift',
      'Sources/MixedAppObjC/include/MixedAppObjC.h',
      'Sources/MixedAppObjC/FCodeGreeter.m',
    ]) {
      assert.ok(fs.existsSync(path.join(base, required)), `нет файла ${required}`);
    }

    const manifest = fs.readFileSync(path.join(base, 'Package.swift'), 'utf8');
    assert.match(manifest, /\.target\(\s*\n\s*name: "MixedApp",\s*\n\s*dependencies: \["MixedAppObjC"\]/);
    assert.match(manifest, /name: "MixedAppObjC"/);

    const header = fs.readFileSync(
      path.join(base, 'Sources', 'MixedAppObjC', 'include', 'MixedAppObjC.h'),
      'utf8',
    );
    // Имя заголовка должно совпадать с именем цели — иначе модуль не соберётся.
    assert.match(header, /@interface FCodeGreeter/);
    assert.match(header, /NS_ASSUME_NONNULL_BEGIN/);

    const impl = fs.readFileSync(
      path.join(base, 'Sources', 'MixedAppObjC', 'FCodeGreeter.m'),
      'utf8',
    );
    assert.match(impl, /#import "MixedAppObjC\.h"/, 'реализация обязана импортировать свой заголовок');
    assert.match(impl, /@implementation FCodeGreeter/);

    const contentView = fs.readFileSync(path.join(base, 'Sources', 'MixedApp', 'ContentView.swift'), 'utf8');
    assert.match(contentView, /import MixedAppObjC/, 'Swift обязан импортировать модуль Objective-C');
    assert.match(contentView, /FCodeGreeter\(name:/);
  } finally {
    h.rmrf(dir);
  }
});

test('мастер создания: библиотека получает тестовую цель и без xtool.yml', () => {
  const dir = h.makeTempDir();
  try {
    scaffold.createProject({ parentDir: dir, name: 'Kit', templateId: 'library' });
    const base = path.join(dir, 'Kit');

    assert.ok(fs.existsSync(path.join(base, 'Sources', 'Kit', 'Kit.swift')));
    assert.ok(fs.existsSync(path.join(base, 'Tests', 'KitTests', 'KitTests.swift')));
    assert.strictEqual(
      fs.existsSync(path.join(base, 'xtool.yml')),
      false,
      'библиотеке не нужен bundleID — это не приложение',
    );

    const manifest = fs.readFileSync(path.join(base, 'Package.swift'), 'utf8');
    assert.match(manifest, /\.testTarget\(/);
  } finally {
    h.rmrf(dir);
  }
});

test('имя проекта: допустимые и недопустимые варианты', () => {
  assert.strictEqual(scaffold.validateName('Hello'), null);
  assert.strictEqual(scaffold.validateName('My-App_2'), null);
  assert.strictEqual(scaffold.validateName('_private'), null);

  assert.match(scaffold.validateName(''), /empty/i);
  assert.match(scaffold.validateName('1App'), /start with/i);
  assert.match(scaffold.validateName('My App'), /Latin/i);
  assert.match(scaffold.validateName('Привет'), /Latin/i);
  assert.match(scaffold.validateName('App-'), /hyphen/i);
});

test('имя модуля: дефисы заменяются подчёркиваниями, как в xtool', () => {
  assert.strictEqual(scaffold.moduleNameFor('My-App'), 'My_App');
  assert.strictEqual(scaffold.moduleNameFor('Hello'), 'Hello');
});

test('Bundle ID: значение по умолчанию и проверка формата', () => {
  const fallback = scaffold.validateBundleId('', 'My_App');
  assert.strictEqual(fallback.value, 'com.example.myapp');

  assert.strictEqual(scaffold.validateBundleId('com.acme.tool', 'X').value, 'com.acme.tool');
  assert.ok(scaffold.validateBundleId('плохой', 'X').error);
  assert.ok(scaffold.validateBundleId('com', 'X').error, 'нужны минимум две части');
});

test('существующий каталог не перезаписывается', () => {
  const dir = h.makeTempDir();
  try {
    scaffold.createProject({ parentDir: dir, name: 'Twice' });
    assert.throws(
      () => scaffold.createProject({ parentDir: dir, name: 'Twice' }),
      /already exists/i,
    );
  } finally {
    h.rmrf(dir);
  }
});

test('previewProject подсказывает путь и ловит занятое имя', () => {
  const dir = h.makeTempDir();
  try {
    const preview = scaffold.previewProject({
      parentDir: dir,
      name: 'Preview',
      bundleId: '',
      templateId: 'swiftui-objc',
    });
    assert.strictEqual(preview.nameError, null);
    assert.strictEqual(preview.moduleName, 'Preview');
    assert.strictEqual(preview.bundleId, 'com.example.preview');
    assert.strictEqual(preview.alreadyExists, false);
    assert.strictEqual(preview.writable, true);
    assert.match(preview.template, /Objective-C/);

    scaffold.createProject({ parentDir: dir, name: 'Preview' });
    const again = scaffold.previewProject({ parentDir: dir, name: 'Preview' });
    assert.strictEqual(again.alreadyExists, true);
  } finally {
    h.rmrf(dir);
  }
});
