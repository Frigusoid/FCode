/*
 * Проверка упаковщика на настоящем .xcarchive.
 *
 * До этого тесты работали на синтетических фикстурах. Здесь — архив, собранный
 * самим Xcode, поэтому проверяются реальные особенности: бинарный Info.plist,
 * Mach-O с настоящими правами, Swift-библиотеки, профиль подписи.
 *
 * Разовый скрипт, после проверки удаляется.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const packager = require('../src/main/modules/packager');
const { readZipDirectory } = require('../src/main/modules/zip');

const ARCHIVE_ZIP = process.argv[2];

if (!ARCHIVE_ZIP || !fs.existsSync(ARCHIVE_ZIP)) {
  console.error('Не найден архив:', ARCHIVE_ZIP);
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fcode-real-'));
console.log(`Рабочая папка: ${work}\n`);

// Распаковываем через PowerShell — он умеет zip «из коробки».
console.log('Распаковываю…');
execFileSync('powershell.exe', [
  '-NoProfile',
  '-Command',
  `Expand-Archive -LiteralPath '${ARCHIVE_ZIP.replace(/'/g, "''")}' -DestinationPath '${work.replace(/'/g, "''")}' -Force`,
]);

// Ищем .xcarchive в распакованном виде.
const findArchive = (dir, depth = 0) => {
  if (depth > 3) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.toLowerCase().endsWith('.xcarchive')) return full;
      const found = findArchive(full, depth + 1);
      if (found) return found;
    }
  }
  return null;
};

const archivePath = findArchive(work);
if (!archivePath) {
  console.error('В архиве нет .xcarchive');
  process.exit(1);
}

console.log(`Найден архив: ${path.basename(archivePath)}\n`);

// ---------------------------------------------------------------- разбор
const info = packager.inspectArchive(archivePath);
const b = info.bundle;

console.log('=== Что внутри ===');
console.log(`  Bundle ID      : ${b.bundleId}`);
console.log(`  Имя            : ${b.displayName}`);
console.log(`  Версия         : ${b.shortVersion} (${b.buildVersion})`);
console.log(`  Мин. iOS       : ${b.minimumOSVersion}`);
console.log(`  Формат plist   : ${b.plistFormat}`);
console.log(`  Исполняемый    : ${b.executable}`);
console.log(`  Подпись        : ${b.isSigned ? 'есть' : 'нет'}`);
console.log(`  Профиль        : ${b.hasProvisioningProfile ? 'есть' : 'нет'}`);
if (b.profile) {
  console.log(`    команда      : ${b.profile.teamName} (${b.profile.teamId})`);
  console.log(`    истекает     : ${b.profile.expirationDate?.toISOString().slice(0, 10)} (${b.profile.daysLeft} дн.)`);
  console.log(`    устройств    : ${b.profile.provisionedDevices}`);
}
console.log(`  Swift в архиве : ${info.swiftDylibs.length}`);
info.swiftDylibs.slice(0, 4).forEach((name) => console.log(`    ${name}`));
console.log(`  dSYM           : ${info.dsyms.length}`);

// Проверяем, что исполняемый файл действительно Mach-O.
const execPath = b.executablePath;
console.log(`  Mach-O         : ${execPath && fs.existsSync(execPath) ? (packager.isMachO(execPath) ? 'да' : 'НЕТ') : 'файл не найден'}`);
if (execPath && fs.existsSync(execPath)) {
  console.log(`  Размер бинарника: ${(fs.statSync(execPath).size / 1024 / 1024).toFixed(1)} МиБ`);
}

if (b.issues.length) {
  console.log('\n  Замечания:');
  b.issues.forEach((issue) => console.log(`    • ${issue}`));
}

// ---------------------------------------------------------------- упаковка
console.log('\n=== Упаковка в .ipa ===');
const outputPath = path.join(work, `${path.basename(archivePath, '.xcarchive')}.ipa`);

packager
  .buildIpa({
    appPath: archivePath,
    outputPath,
    mode: 'development',
    onProgress: ({ current, total }) => {
      const percent = Math.round((current / total) * 100);
      if (percent % 25 === 0) process.stdout.write(`  ${percent}%\r`);
    },
  })
  .then((result) => {
    console.log(`\n  Файлов        : ${result.totalFiles}`);
    console.log(`  Содержимое    : ${(result.uncompressedBytes / 1024 / 1024).toFixed(1)} МиБ`);
    console.log(`  Размер .ipa   : ${(result.ipaBytes / 1024 / 1024).toFixed(1)} МиБ`);

    // ------------------------------------------------------------ проверка
    console.log('\n=== Проверка .ipa ===');
    const report = packager.verifyIpa(outputPath);
    console.log(`  Итог          : ${report.ok ? 'КОРРЕКТНЫЙ' : 'ЕСТЬ ПРОБЛЕМЫ'}`);
    console.log(`  Приложение    : ${report.appRoot}`);
    console.log(`  Записей       : ${report.totalEntries}`);
    if (report.issues.length) report.issues.forEach((i) => console.log(`    ✗ ${i}`));
    if (report.notes.length) report.notes.forEach((n) => console.log(`    · ${n}`));

    // Ключевая проверка: права на исполняемом файле.
    const entries = readZipDirectory(outputPath);
    const execEntry = entries.find((e) => e.name === `${report.appRoot}/${b.executable}`);
    console.log(`\n  Права на ${b.executable}: ${execEntry ? '0' + (execEntry.mode & 0o777).toString(8) : 'запись не найдена'}`);

    const executableCount = entries.filter((e) => !e.isDirectory && !e.isSymlink && (e.mode & 0o111)).length;
    console.log(`  Исполняемых файлов: ${executableCount}`);
    const symlinks = entries.filter((e) => e.isSymlink);
    console.log(`  Симлинков         : ${symlinks.length}`);
    symlinks.slice(0, 3).forEach((s) => console.log(`    ${s.name}`));

    // Независимая проверка целостности через Python.
    try {
      const script = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    count = len(z.infolist())
print('CRC OK' if bad is None else 'CRC BAD: ' + str(bad), '| записей:', count)
`;
      const check = execFileSync('python', ['-c', script, outputPath], { encoding: 'utf8' });
      console.log(`\n  Python zipfile: ${check.trim()}`);
    } catch (error) {
      console.log(`\n  Python недоступен: ${error.message}`);
    }

    console.log(`\n  .ipa лежит здесь: ${outputPath}`);
  })
  .catch((error) => {
    console.error('\nОШИБКА упаковки:', error.message);
    process.exit(1);
  });
