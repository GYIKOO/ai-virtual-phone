// Runs the production SDK, bridge dispatch and host helpers against isolated stores.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const transpile = source => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
} }).outputText;
function declaration(file, name, callback = false) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let result;
  function visit(node) {
    if (node.name?.getText(source) === name) {
      if (callback && ts.isVariableDeclaration(node)) result = node.initializer.arguments[0].getText(source);
      if (!callback && ts.isFunctionDeclaration(node)) result = node.getText(source).replace(/^export\s+/, '');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(result, `Missing production declaration ${name}`);
  return result;
}
const runnerFile = 'components/app-market/custom-app-runner.tsx';
const runner = read(runnerFile);
let serial = 0, kvReady = false, settingsReady = false, state;
const events = [];
const app = { id: 'fixture-app', name: 'Fixture', manifest: {}, permissions: [] };
function reset() {
  state = {
    characters: [{ id: 'a', name: 'A', persona: 'Keep persona', avatar: null, tags: ['keep'], custom: 'keep' }, { id: 'b', name: 'B' }],
    regexes: [{ id: 'r1', name: 'Existing', description: 'Keep', rules: [{ id: 'old', findRegex: 'x', replaceString: 'y' }] }],
    books: [{ id: 'w1' }, { id: 'w2' }],
    identities: [{ id: 'u1', name: 'User 1' }, { id: 'u2', name: 'User 2', bio: 'Second identity' }],
    worlds: [{ id: 'world1', name: 'One', memberIds: ['a', 'b'], relations: [{ fromCharacterId: 'a', toCharacterId: 'b' }] },
      { id: 'world2', name: 'Two', memberIds: [], relations: [] }],
    bindings: { globalDefaults: { apiConfigId: 'api-keep', presetId: 'preset-keep', worldBookIds: ['w1'], regexIds: ['r1'], userIdentityId: 'u1' },
      appDefaults: {}, characterBindings: [
        { characterId: 'a', defaults: { presetId: 'character-preset' }, appOverrides: { chat: { presetId: 'chat-keep' }, story: { presetId: 'story-keep', regexIds: ['r1'] } } },
        { characterId: 'b', defaults: {}, appOverrides: {} },
      ] },
  };
  kvReady = settingsReady = false;
  events.length = 0;
}
reset();
const requireKv = () => assert.ok(kvReady, 'KV must be hydrated before reading');
const requireSettings = () => { requireKv(); assert.ok(settingsReady, 'Settings must be hydrated before reading'); };
const stores = {
  loadCharacters: () => { requireKv(); return state.characters; },
  saveCharacters: value => { state.characters = copy(value); },
  createCharacter: value => ({ ...value, id: `created-${++serial}` }),
  loadCharacterWorldGroups: () => { requireKv(); return state.worlds; },
  saveCharacterWorldGroups: value => { state.worlds = copy(value); },
  getCharacterWorldGroupId: id => state.worlds.find(w => w.memberIds.includes(id))?.id ?? null,
  getCharacterWorldUserNodeId: id => `user:${id}`,
  loadUserIdentities: () => { requireKv(); return state.identities; },
  loadRegexes: () => { requireSettings(); return state.regexes; },
  saveRegexes: value => { state.regexes = copy(value); },
  createRegexGroup: name => ({ id: `regex-${++serial}`, name, rules: [] }),
  loadWorldBooks: () => { requireSettings(); return state.books; },
  loadBindingConfig: () => { requireSettings(); return state.bindings; },
  saveBindingConfig: value => { state.bindings = copy(value); },
  hydrateKvDb: async () => { kvReady = true; },
  ensureSettingsStorageHydrated: async () => { settingsReady = true; },
  hydrateChatStorage: async () => { throw new Error('Unrelated chat hydration'); },
  registerKvMigration: () => {},
};
const ctx = vm.createContext({ ...stores, app, launchContext: {}, exports: {}, console,
  onEvent() {}, offEvent() {}, window: { dispatchEvent: event => events.push(event) },
  CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
});
for (const [file, name] of [
  ['lib/settings-storage.ts', 'resolveBinding'],
  ['lib/character-world-storage.ts', 'moveCharacterToWorld'],
]) vm.runInContext(transpile(declaration(file, name)), ctx);
stores.resolveBinding = ctx.resolveBinding;
stores.moveCharacterToWorld = ctx.moveCharacterToWorld;
// Host module itself is loaded, not a rewritten implementation. Only external stores/services are substituted.
ctx.require = () => stores;
vm.runInContext(transpile(read('lib/custom-app-host-api.ts')), ctx);
Object.assign(ctx, ctx.exports);
for (const name of ['hasPermission', 'bridgeActionNeedsKvStorage', 'bridgeActionNeedsSettingsStorage', 'bridgeActionNeedsChatStorage']) {
  vm.runInContext(transpile(declaration(runnerFile, name)), ctx);
}
for (const name of ['requirePermission', 'requireAnyPermission', 'handleBridgeRequest']) {
  vm.runInContext(transpile(`var ${name} = ${declaration(runnerFile, name, true)};`), ctx);
}
ctx.request = async (action, payload) => {
  kvReady = settingsReady = false;
  return ctx.handleBridgeRequest(action, payload);
};
const sdkStart = runner.indexOf('  var api = {');
const sdkEnd = runner.indexOf('  window.AiPhone = Object.assign', sdkStart);
assert.ok(sdkStart > 0 && sdkEnd > sdkStart);
vm.runInContext(runner.slice(sdkStart, sdkEnd), ctx);
const sdk = ctx.api;
let checks = 0;
function equal(actual, expected) { assert.deepEqual(copy(actual), copy(expected)); checks++; }
async function rejected(call, pattern) {
  const before = copy(state);
  await assert.rejects(call, pattern);
  equal(state, before);
}
async function main() {
  // Permission failures run through the real dispatch, including all new read/write routes.
  for (const [method, payload, permission] of [
    [sdk.characters.open, {}, 'characters.read'], [sdk.characters.create, {}, 'characters.write'],
    [sdk.characters.update, { id: 'a' }, 'characters.write'],
    [sdk.characters.listWorlds, {}, 'characters.read'], [sdk.characters.assignWorld, { characterId: 'a', worldId: 'world2' }, 'characters.write'],
    [sdk.user.listIdentities, {}, 'user.persona.read'], [sdk.regex.list, {}, 'regex.read'],
    [sdk.regex.create, {}, 'regex.write'], [sdk.regex.update, { id: 'r1' }, 'regex.write'],
    [sdk.regex.delete, 'r1', 'regex.write'], [sdk.story.getBindings, { characterId: 'a' }, 'story.read'],
    [sdk.story.updateBindings, { characterId: 'a' }, 'story.write'],
  ]) await rejected(() => method(payload), new RegExp(permission.replaceAll('.', '\\.')));
  app.permissions = ['characters.read', 'characters.write', 'user.persona.read', 'regex.read', 'regex.write', 'story.read', 'story.write'];
  await rejected(() => sdk.characters.create({ id: 'a', name: 'Overwrite' }), /ID/);
  await rejected(() => sdk.characters.update({ id: 'missing' }), /未找到/);
  await sdk.characters.update({ id: 'a', name: 'Renamed' });
  equal(state.characters[0], { id: 'a', name: 'Renamed', persona: 'Keep persona', avatar: null, tags: ['keep'], custom: 'keep', updatedAt: state.characters[0].updatedAt });
  const created = await sdk.characters.create({ name: 'New', persona: 'New persona' });
  equal(created.created, true);
  equal(state.characters.length, 3);
  await sdk.characters.open({ characterId: 'a' });
  equal(events[0].detail.appId, 'characters');
  await rejected(() => sdk.characters.open({ characterId: 'missing' }), /有效/);
  equal((await sdk.user.listIdentities()).identities.length, 2);
  equal((await sdk.characters.listWorlds({ characterId: 'a' })).currentWorldId, 'world1');
  await rejected(() => sdk.characters.assignWorld({ characterId: 'a', worldId: 'missing' }), /worldId/);
  await sdk.characters.assignWorld({ characterId: 'a', worldId: 'world2' });
  equal(state.worlds.map(w => w.memberIds), [['b'], ['a']]);
  equal(state.worlds[0].relations, []); // Native world transfer semantics, not a new relation policy.

  await rejected(() => sdk.regex.create({ id: 'r1' }), /ID/);
  await rejected(() => sdk.regex.update({ id: 'Existing', name: 'Do not match by name' }), /准确 ID/);
  await rejected(() => sdk.regex.update({ id: 'missing' }), /准确 ID/);
  const rule = { id: 'exact', findRegex: ' ^a\n b$ ', replaceString: ' \n$1\n ', trimStrings: [' ', '\n', '\t'], minDepth: null, maxDepth: 0 };
  await sdk.regex.update({ id: 'r1', description: '', rules: [rule] });
  const stored = state.regexes[0].rules[0];
  equal([stored.findRegex, stored.replaceString, stored.trimStrings, stored.maxDepth], [rule.findRegex, rule.replaceString, rule.trimStrings, 0]);
  equal(Object.hasOwn(stored, 'minDepth'), false);
  equal(state.regexes[0].description, '');
  await sdk.regex.update({ id: 'r1', rule: { id: 'second', findRegex: 'x', replaceString: '' } });
  equal(state.regexes[0].rules.length, 2);
  for (const payload of [
    { rules: [rule, rule] }, { rules: Array(301).fill(rule) }, { rules: 'not array' },
    { rule: { findRegex: 'x'.repeat(100001) } }, { rule: { findRegex: 'x', minDepth: -2 } },
    { rule: { findRegex: 'x', trimStrings: [12] } }, { rule: null },
  ]) await rejected(() => sdk.regex.update({ id: 'r1', name: 'Must not leak partial edit', ...payload }), /.+/);
  const added = await sdk.regex.create({ name: 'Existing', rules: [{ findRegex: 'x' }] });
  equal(state.regexes.length, 2);
  await sdk.regex.delete(added.regex.id);
  equal(state.regexes.map(r => r.id), ['r1']);
  equal((await sdk.regex.get('r1')).regex.id, 'r1');

  const original = copy(state.bindings);
  for (const payload of [
    { worldBookIds: ['w2'], regexIds: ['missing'] }, { worldBookIds: ['w2'], userIdentityId: 'missing' },
    { worldBookIds: 'w2' }, { regexIds: [null] }, { userIdentityId: 123 },
  ]) await rejected(() => sdk.story.updateBindings({ characterId: 'a', ...payload }), /.+/);
  await sdk.story.updateBindings({ characterId: 'a', worldBookIds: ['w2', 'w2'], userIdentityId: 'u2', presetId: 'not-writable', apiConfigId: 'not-writable' });
  equal(state.bindings.characterBindings[0].appOverrides.story, { presetId: 'story-keep', regexIds: ['r1'], worldBookIds: ['w2'], userIdentityId: 'u2' });
  equal(state.bindings.characterBindings[0].appOverrides.chat, original.characterBindings[0].appOverrides.chat);
  equal(state.bindings.globalDefaults, original.globalDefaults);
  equal(state.bindings.characterBindings[1], original.characterBindings[1]);
  equal((await sdk.story.getBindings({ characterId: 'a' })).resolved.userIdentityId, 'u2');
  await sdk.story.updateBindings({ characterId: 'a', worldBookIds: [], regexIds: [], userIdentityId: '' });
  const inherited = (await sdk.story.getBindings({ characterId: 'a' })).resolved;
  equal([inherited.worldBookIds, inherited.regexIds, inherited.userIdentityId, inherited.presetId], [['w1'], ['r1'], 'u1', 'story-keep']);
  await rejected(() => sdk.story.updateBindings({ characterId: 'missing' }), /有效/);
  app.permissions = ['characters.read', 'regex.read', 'story.read'];
  await rejected(() => sdk.characters.update({ id: 'a' }), /characters.write/);
  await rejected(() => sdk.regex.delete('r1'), /regex.write/);
  await rejected(() => sdk.story.updateBindings({ characterId: 'a' }), /story.write/);
  equal(Object.keys(sdk.story).sort(), ['getBindings', 'updateBindings']);
  await rejected(() => ctx.request('story.openings.create', {}), /未知/);
  await rejected(() => ctx.request('story.archives.create', {}), /未知/);
  console.log(`PASS: ${checks} assertions; production SDK → permission/hydration dispatch → host helpers; isolated stores, no model/network calls.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
