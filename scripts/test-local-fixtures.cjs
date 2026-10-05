const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const data = { apis: [{ id: 'real-api' }], chars: [{ id: 'real-char' }], presets: [{ id: 'builtin', builtIn: true }],
  bindings: { globalDefaults: { apiConfigId: 'real-api' }, characterBindings: [{ characterId: 'real-char' }] }, sessions: [] };
const kv = new Map();
const cleared = [];
const mocks = {
  './kv-db': { kvGet: key => kv.get(key), kvSet: (key, value) => kv.set(key, value) },
  './character-storage': { loadCharacters: () => data.chars, saveCharacters: value => { data.chars = value; } },
  './chat-storage': { hydrateChatStorage: async () => {}, addChatContact() {},
    createOrGetSession: id => { const old = data.sessions.find(s => s.contactId === id); if (old) return old; const session = { id: 'test-session', contactId: id }; data.sessions.push(session); return session; },
    clearChatSessionMessages: id => cleared.push(id), loadChatSessions: () => data.sessions, saveChatSessions: value => { data.sessions = value; } },
  './settings-storage': { ensureSettingsStorageHydrated: async () => {}, loadApiConfigs: () => data.apis, saveApiConfigs: value => { data.apis = value; },
    loadPresets: () => data.presets, savePresetsAsync: async value => { data.presets = value; }, loadBindingConfig: () => data.bindings, saveBindingConfig: value => { data.bindings = value; } },
};
function load(overrides = {}, host = 'localhost') {
  const exports = {};
  const env = { NODE_ENV: 'development', NEXT_PUBLIC_LOCAL_TEST_FIXTURES: 'true', NEXT_PUBLIC_SELF_HOSTED_MODE: 'true', NEXT_PUBLIC_LOCAL_TEST_RUN: 'run-1', ...overrides };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/local-test-fixtures.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: name => mocks[name], process: { env }, window: { location: { hostname: host } } });
  return exports;
}
(async () => {
  await load({ NODE_ENV: 'production' }).prepareLocalTestFixtures();
  await load({}, 'example.com').prepareLocalTestFixtures();
  await load({ NEXT_PUBLIC_LOCAL_TEST_FIXTURES: 'false' }).prepareLocalTestFixtures();
  assert.equal(cleared.length, 0, 'never seed non-test or production hosts');
  const fixture = load();
  await Promise.all([fixture.prepareLocalTestFixtures(), fixture.prepareLocalTestFixtures()]);
  assert.equal(cleared.length, 1);
  await load().prepareLocalTestFixtures();
  assert.equal(cleared.length, 1, 'refresh keeps the current debugging conversation');
  await load({ NEXT_PUBLIC_LOCAL_TEST_RUN: 'run-2' }).prepareLocalTestFixtures();
  assert.equal(cleared.length, 2, 'new server run resets only the fixture session');
  assert.ok(cleared.every(id => id === 'test-session'));
  assert.equal(data.apis.length, 2);
  assert.equal(data.chars.length, 2);
  assert.equal(data.presets.length, 2);
  assert.equal(data.bindings.globalDefaults.apiConfigId, 'real-api');
  assert.ok(data.bindings.characterBindings.some(b => b.characterId === 'real-char'));
  assert.equal(data.apis.find(a => a.id !== 'real-api').defaultModel, 'qwen2.5:1.5b');
  console.log('PASS: local fixture guards, idempotence, scoped reset and existing-data preservation');
})().catch(error => { console.error(error); process.exitCode = 1; });
