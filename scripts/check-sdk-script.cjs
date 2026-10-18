// Синтаксическая проверка скрипта починки SDK: перехватываем его текст
// и прогоняем через `bash -n`, не выполняя.
const { execFileSync } = require('child_process');
const requirements = require('../src/main/modules/requirements');

const wslExec = require('../src/main/modules/wsl-exec');
const original = wslExec.run;
let captured = null;

wslExec.run = async (options) => {
  captured = options.script;
  return { ok: true, code: 0, output: 'changes=none' };
};

(async () => {
  await requirements.repairSdkHostTriple({});
  wslExec.run = original;

  if (!captured) {
    console.log('скрипт не сформирован');
    process.exit(1);
  }

  console.log(`длина скрипта: ${captured.length} символов`);
  console.log(`цикл по бандлам: ${/for BUNDLE in/.test(captured) ? 'есть' : 'НЕТ'}`);
  console.log(`жёсткое имя darwin: ${/darwin\.artifactbundle/.test(captured) ? 'ОСТАЛОСЬ' : 'убрано'}`);

  // bash -n — проверка синтаксиса без выполнения.
  try {
    execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'frigus', '--', 'bash', '-n', '-c', captured], {
      encoding: 'utf8',
      env: { ...process.env, WSL_UTF8: '1' },
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log('синтаксис bash: OK');
  } catch (error) {
    console.log('синтаксис bash: ОШИБКА');
    console.log(String(error.stderr || error.message).slice(0, 500));
    process.exit(1);
  }

  process.exit(0);
})().catch((error) => {
  console.error('ошибка:', error.message);
  process.exit(1);
});
