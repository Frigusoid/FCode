'use strict';
/*
 * Создание проектов.
 *
 * Шаблоны совместимы с xtool: он собирает iOS-приложение из SwiftPM-пакета,
 * поэтому структура повторяет то, что генерирует `xtool new` — Package.swift
 * ровно с одним библиотечным продуктом, xtool.yml с bundleID и точка входа
 * SwiftUI. Такой проект открывается и в FCode, и собирается через `xtool dev`.
 *
 * Дополнительно есть шаблон с целью на Objective-C: в SwiftPM языки семейства C
 * подключаются как отдельная цель с каталогом include/, и она видна из Swift
 * как обычный модуль.
 */

const fs = require('fs');
const path = require('path');
const { t } = require('../../shared/i18n');

/** Имя пакета: xtool разрешает [a-zA-Z_] в начале и [a-zA-Z0-9_-] далее. */
function validateName(name) {
  if (!name || !name.trim()) return t('scaffold.nameEmpty');
  const trimmed = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(trimmed)) {
    return t('scaffold.nameStart');
  }
  if (/[A-Za-z0-9_]$/.test(trimmed) === false) {
    // Имя не может заканчиваться дефисом — иначе модуль получится странным.
    return t('scaffold.nameEnd');
  }
  return null;
}

/** Имя Swift-модуля: дефисы заменяются на подчёркивания, как делает xtool. */
function moduleNameFor(name) {
  return name.trim().replace(/-/g, '_');
}

function validateBundleId(bundleId, fallbackName) {
  const value = (bundleId || '').trim() || `com.example.${fallbackName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  if (!/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/.test(value)) {
    return { error: t('scaffold.bundleIdInvalid') };
  }
  return { value };
}

const GITIGNORE = `.DS_Store
/.build
/Packages
xcuserdata/
DerivedData/
.swiftpm/configuration/registries.json
.swiftpm/xcode/package.xcworkspace/contents.xcworkspacedata
.netrc

/xtool
`;

/** Шаблоны, доступные в мастере создания проекта. */
const TEMPLATES = [
  {
    id: 'swiftui',
    label: t('template.swiftui.label'),
    description: t('template.swiftui.description'),
    build: (ctx) => ({
      'Package.swift': `// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "${ctx.name}",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        // Проект xtool должен содержать ровно один библиотечный продукт —
        // именно он превращается в приложение.
        .library(
            name: "${ctx.module}",
            targets: ["${ctx.module}"]
        ),
    ],
    targets: [
        .target(
            name: "${ctx.module}"
        ),
    ]
)
`,
      [`Sources/${ctx.module}/${ctx.module}App.swift`]: `import SwiftUI

@main
struct ${ctx.module}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
`,
      [`Sources/${ctx.module}/ContentView.swift`]: `import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "swift")
                .imageScale(.large)
                .foregroundStyle(.tint)

            Text("Привет из FCode!")
                .font(.title2)

            Text("Проект создан на Windows и собирается через xtool")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
}
`,
    }),
  },
  {
    id: 'swiftui-objc',
    label: t('template.swiftui-objc.label'),
    description: t('template.swiftui-objc.description'),
    build: (ctx) => ({
      'Package.swift': `// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "${ctx.name}",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "${ctx.module}",
            targets: ["${ctx.module}"]
        ),
    ],
    targets: [
        .target(
            name: "${ctx.module}",
            dependencies: ["${ctx.module}ObjC"]
        ),
        // Цели семейства C SwiftPM собирает сам: .m, .mm, .c, .cpp.
        // Каталог include/ становится заголовками модуля.
        .target(
            name: "${ctx.module}ObjC"
        ),
    ]
)
`,
      [`Sources/${ctx.module}/${ctx.module}App.swift`]: `import SwiftUI

@main
struct ${ctx.module}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
`,
      [`Sources/${ctx.module}/ContentView.swift`]: `import SwiftUI
import ${ctx.module}ObjC

struct ContentView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "swift")
                .imageScale(.large)
                .foregroundStyle(.tint)

            Text("Привет из FCode!")
                .font(.title2)

            // Класс объявлен в Objective-C и виден здесь как Swift-тип.
            Text(FCodeGreeter(name: "FCode").greeting())
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
}
`,
      [`Sources/${ctx.module}ObjC/include/${ctx.module}ObjC.h`]: `#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Пример класса на Objective-C, доступного из Swift без обёрток.
@interface FCodeGreeter : NSObject

- (instancetype)initWithName:(NSString *)name;
- (NSString *)greeting;

@end

NS_ASSUME_NONNULL_END
`,
      [`Sources/${ctx.module}ObjC/FCodeGreeter.m`]: `#import "${ctx.module}ObjC.h"

@implementation FCodeGreeter {
    NSString *_name;
}

- (instancetype)initWithName:(NSString *)name {
    self = [super init];
    if (self) {
        _name = [name copy];
    }
    return self;
}

- (NSString *)greeting {
    return [NSString stringWithFormat:@"Этот текст собран компилятором Objective-C: привет, %@!", _name];
}

@end
`,
    }),
  },
  {
    id: 'library',
    label: t('template.library.label'),
    description: t('template.library.description'),
    build: (ctx) => ({
      'Package.swift': `// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "${ctx.name}",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "${ctx.module}",
            targets: ["${ctx.module}"]
        ),
    ],
    targets: [
        .target(
            name: "${ctx.module}"
        ),
        .testTarget(
            name: "${ctx.module}Tests",
            dependencies: ["${ctx.module}"]
        ),
    ]
)
`,
      [`Sources/${ctx.module}/${ctx.module}.swift`]: `/// Точка входа библиотеки.
public enum ${ctx.module} {
    /// Возвращает приветствие — замените на свою логику.
    public static func greeting(for name: String) -> String {
        "Привет, \\(name)!"
    }
}
`,
      [`Tests/${ctx.module}Tests/${ctx.module}Tests.swift`]: `import Testing
@testable import ${ctx.module}

@Test func greetingContainsName() async throws {
    #expect(${ctx.module}.greeting(for: "FCode").contains("FCode"))
}
`,
    }),
  },
];

function templateById(id) {
  return TEMPLATES.find((item) => item.id === id) || TEMPLATES[0];
}

/**
 * Создать проект на диске.
 * @param {{parentDir: string, name: string, bundleId?: string, templateId?: string}} options
 */
function createProject(options) {
  const nameError = validateName(options.name);
  if (nameError) throw new Error(nameError);

  const name = options.name.trim();
  const module = moduleNameFor(name);
  const template = templateById(options.templateId);

  const bundle = validateBundleId(options.bundleId, module);
  if (bundle.error) throw new Error(bundle.error);

  const parentDir = path.resolve(options.parentDir);
  if (!fs.existsSync(parentDir)) throw new Error(t('scaffold.parentMissing', { path: parentDir }));

  const projectDir = path.join(parentDir, name);
  if (fs.existsSync(projectDir)) {
    throw new Error(t('scaffold.alreadyExists', { path: projectDir }));
  }

  const ctx = { name, module, bundleId: bundle.value, template: template.id };
  const files = template.build(ctx);

  // Файлы, общие для всех шаблонов.
  if (template.id !== 'library') {
    files['xtool.yml'] = `version: 1
bundleID: ${bundle.value}
`;
  }
  files['.gitignore'] = GITIGNORE;
  files['README.md'] = `# ${name}

${t('scaffold.readmeCreated')}

\`\`\`
${t('scaffold.readmeBundle')}: ${bundle.value}
${t('scaffold.readmeTemplate')}: ${template.label}
\`\`\`

## ${t('scaffold.readmeBuildHeading')}

${template.id === 'library' ? t('scaffold.readmeLibrary') : t('scaffold.readmeApp')}
`;

  fs.mkdirSync(projectDir, { recursive: true });

  const written = [];
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(projectDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, 'utf8');
    written.push(relative);
  }

  return {
    path: projectDir,
    name,
    moduleName: module,
    bundleId: bundle.value,
    template: template.id,
    templateLabel: template.label,
    files: written.sort(),
  };
}

/** Список шаблонов для интерфейса. */
function listTemplates() {
  return TEMPLATES.map(({ id, label, description }) => ({ id, label, description }));
}

/** Проверить имя, не создавая проект — для живой подсказки в мастере. */
function previewProject({ parentDir, name, bundleId, templateId }) {
  const nameError = validateName(name);
  const module = name ? moduleNameFor(name) : '';
  const bundle = name ? validateBundleId(bundleId, module) : { value: '' };
  const projectPath = name ? path.join(path.resolve(parentDir || '.'), name.trim()) : '';

  return {
    nameError,
    moduleName: module,
    bundleId: bundle.value || '',
    bundleIdError: bundle.error || null,
    path: projectPath,
    alreadyExists: Boolean(projectPath) && fs.existsSync(projectPath),
    writable: Boolean(parentDir) && fs.existsSync(path.resolve(parentDir || '.')),
    template: templateById(templateId).label,
  };
}

module.exports = {
  createProject,
  listTemplates,
  previewProject,
  validateName,
  validateBundleId,
  moduleNameFor,
  TEMPLATES,
};
