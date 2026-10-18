// Что приложение видит в swiftSdk: triple, цели и имя бандла.
const xtool = require('../src/main/modules/xtool');

(async () => {
  const env = await xtool.checkEnvironment();
  const sdk = env.inside && env.inside.swiftSdk;

  console.log('swiftSdk:');
  console.log(JSON.stringify(sdk, null, 2));

  console.log('');
  console.log('список  :', JSON.stringify((sdk && sdk.list) || '').slice(0, 120));
  console.log('triples :', (sdk && sdk.triples) || []);
  console.log('host    :', sdk && sdk.hostTriple);
  console.log('targets :', (sdk && sdk.targetTriples) || []);
})().catch((error) => {
  console.error('ошибка:', error.message);
  process.exit(1);
});
