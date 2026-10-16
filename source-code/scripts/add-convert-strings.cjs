// Добавить строки конвертера в оба словаря сразу после toolbar.verifyTitle —
// так они гарантированно попадают в свою языковую секцию.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'src', 'shared', 'messages.js');
let text = fs.readFileSync(file, 'utf8');

const additions = {
  en: [
    "'toolbar.convert': 'Convert',",
    "'toolbar.convertTitle': 'Convert an Xcode project so xtool can build it',",
    "'common.cancel': 'Cancel',",
    "'common.yes': 'Continue',",
    "'convert.title': 'Convert project',",
    "'convert.run': 'Convert',",
    "'convert.open': 'Open result',",
    "'convert.start': 'Converting the Xcode project for xtool…',",
    "'convert.running': 'converting…',",
    "'convert.noProject': 'Open a project first',",
    "'convert.offerBody':",
    "      'This is an Xcode project. xtool builds Swift packages, so the project has to be converted first: sources and resources are copied into Sources/, nested packages are wired up, and the manifest is generated. The original project is left untouched.',",
    "'convert.done': 'Converted. Result: {path}',",
    "'convert.openBody': 'Converted to {path}. Open this folder now? You build from it from here on.',",
    "'convert.failed': 'Conversion failed: {error}',",
  ],
  ru: [
    "'toolbar.convert': 'Конвертировать',",
    "'toolbar.convertTitle': 'Перевести проект Xcode в вид, понятный xtool',",
    "'common.cancel': 'Отмена',",
    "'common.yes': 'Продолжить',",
    "'convert.title': 'Конвертация проекта',",
    "'convert.run': 'Конвертировать',",
    "'convert.open': 'Открыть результат',",
    "'convert.start': 'Перевожу проект Xcode на xtool…',",
    "'convert.running': 'конвертация…',",
    "'convert.noProject': 'Сначала откройте проект',",
    "'convert.offerBody':",
    "      'Это проект Xcode. xtool собирает пакеты Swift, поэтому проект нужно сначала сконвертировать: исходники и ресурсы перекладываются в Sources/, вложенные пакеты подключаются, манифест создаётся заново. Исходный проект не изменяется.',",
    "'convert.done': 'Готово. Результат: {path}',",
    "'convert.openBody': 'Сконвертировано в {path}. Открыть эту папку? Собирать дальше нужно из неё.',",
    "'convert.failed': 'Конвертация не удалась: {error}',",
  ],
};

const anchors = {
  en: "    'toolbar.verifyTitle': 'Verify an existing .ipa',",
  ru: "    'toolbar.verifyTitle': 'Проверить готовый .ipa',",
};

if (text.includes("'convert.title'")) {
  console.log('строки уже добавлены');
  process.exit(0);
}

for (const lang of ['en', 'ru']) {
  const anchor = anchors[lang];
  if (!text.includes(anchor)) {
    console.error(`не найден якорь для ${lang}`);
    process.exit(1);
  }
  text = text.replace(anchor, `${anchor}\n${additions[lang].join('\n')}`);
}

fs.writeFileSync(file, text, 'utf8');
console.log('строки добавлены');
