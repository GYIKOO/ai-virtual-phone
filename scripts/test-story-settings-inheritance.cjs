// Uses in-memory IndexedDB only; never opens the browser's real story database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { indexedDB, IDBKeyRange } = require(require.resolve('fake-indexeddb', { paths: [process.env.FLOAT_TEST_DEPS || process.cwd()] }));
const Dexie = require('dexie');
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
const kv = new Map(), modules = new Map();
const mocks = {
  dexie: Dexie,
  './kv-db': { hydrateKvDb: async () => {}, registerKvMigration() {}, kvGet: key => kv.get(key), kvSet: (key, value) => kv.set(key, value) },
  './llm-prompt-assembler': { formatChatTimestamp: value => value, applyAllOutputRegex: value => value, applyAllReasoningRegex: value => value },
};
function load(name) {
  if (mocks[name]) return mocks[name];
  if (modules.has(name)) return modules.get(name);
  const exports = {};
  modules.set(name, exports);
  const filename = `lib/${name.replace('./', '')}.ts`;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: load, window: {}, indexedDB, IDBKeyRange, console, Date, setTimeout, clearTimeout }, { filename });
  return exports;
}
(async () => {
  const tags = load('./story-tag-settings');
  const db = new Dexie('AiPhoneStoryDB');
  db.version(1).stores({ sessions: 'id, characterId, updatedAt', messages: 'id, sessionId, createdAt' });
  const legacy = { id: 'legacy-main', characterId: 'a', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', foldTags: tags.LEGACY_STORY_FOLD_TAGS, contextExcludedTags: 'private_note' };
  await db.table('sessions').bulkPut([legacy, { ...legacy, id: 'custom-main', characterId: 'custom', foldTags: 'custom_tag' }, { ...legacy, id: 'empty-main', characterId: 'empty', foldTags: '', contextExcludedTags: '' }]);
  let store = load('./story-storage');
  await store.hydrateStoryStorage();
  const main = store.createOrGetStorySession('a');
  assert.equal(main.foldTags, tags.DEFAULT_STORY_FOLD_TAGS, 'legacy default gains summary once');
  assert.equal(main.contextExcludedTags, 'private_note', 'fold migration never changes context exclusions');
  assert.equal(main.updatedAt, legacy.updatedAt, 'migration preserves activity time');
  assert.equal(store.createOrGetStorySession('custom').foldTags, 'custom_tag');
  assert.equal(store.createOrGetStorySession('empty').foldTags, '');
  const first = store.createOrGetStorySession('a', { branchId: 'first', baseSession: main });
  const edited = store.updateStorySession(first.id, { foldTags: 'think,summary,my_status', contextExcludedTags: 'secret', settings: { userControlMode: 'strong' }, uiPrefs: { theme: 'night' } });
  store.saveStoryLaunchTarget(edited);
  const next = store.createOrGetStorySession('a', { branchId: 'quick', baseSession: main, independentStory: true });
  assert.equal(next.foldTags, edited.foldTags, 'quick new story inherits active branch, not stale main');
  assert.equal(next.contextExcludedTags, edited.contextExcludedTags);
  assert.equal(next.settings.userControlMode, 'strong');
  assert.equal(next.uiPrefs.theme, 'night');
  assert.equal(next.independentStory, true, 'memory policy comes from new branch options, not template');
  assert.equal(main.foldTags, tags.DEFAULT_STORY_FOLD_TAGS, 'existing pages are not overwritten');
  assert.equal(store.createOrGetStorySession('b').foldTags, tags.DEFAULT_STORY_FOLD_TAGS, 'other characters stay independent');
  const groupMain = store.createOrGetStorySession('a', { ownerType: 'group', ownerId: 'g', participantIds: ['a', 'b'] });
  assert.equal(groupMain.foldTags, tags.DEFAULT_STORY_FOLD_TAGS, 'single-character settings do not leak through remembered page');
  const groupEdited = store.updateStorySession(groupMain.id, { foldTags: 'group_only', contextExcludedTags: '' });
  store.saveStoryLaunchTarget(groupEdited);
  const groupNext = store.createOrGetStorySession('a', { ownerType: 'group', ownerId: 'g', participantIds: ['a', 'b'], branchId: 'group-next', baseSession: groupMain });
  assert.equal(groupNext.foldTags, 'group_only');
  assert.equal(groupNext.contextExcludedTags, '');
  store.updateStorySession(first.id, { foldTags: '', contextExcludedTags: '' });
  const emptyNext = store.createOrGetStorySession('a', { branchId: 'invite', baseSession: main });
  assert.equal(emptyNext.foldTags, '', 'chat invitation inherits explicit clearing from same owner active page');
  assert.equal(emptyNext.contextExcludedTags, '');
  store.updateStorySession(first.id, { foldTags: tags.LEGACY_STORY_FOLD_TAGS });
  assert.equal(store.loadStorySessions().find(s => s.id === first.id).foldTags, tags.LEGACY_STORY_FOLD_TAGS, 'user can remove summary after migration');
  const beforeReload = await db.table('sessions').toArray();
  assert.ok(beforeReload.some(s => s.id === first.id && s.foldTagsVersion === tags.STORY_FOLD_TAGS_VERSION));
  modules.delete('./story-storage');
  store = load('./story-storage');
  await store.hydrateStoryStorage();
  const reloaded = store.createOrGetStorySession('a', { branchId: 'after-reload', baseSession: main });
  assert.equal(reloaded.foldTags, tags.LEGACY_STORY_FOLD_TAGS, 'remembered settings survive hydration without reapplying default');
  kv.set('story-active-page-map-v1', JSON.stringify({ 'single:a': groupMain.id }));
  assert.equal(store.createOrGetStorySession('a', { branchId: 'bad-owner', baseSession: main }).foldTags, main.foldTags, 'invalid cross-owner remembered ID falls back safely');
  kv.set('story-active-page-map-v1', '{broken');
  assert.equal(store.createOrGetStorySession('a', { branchId: 'bad-json', baseSession: main }).foldTags, main.foldTags);
  const parser = load('./story-parser');
  const parsed = parser.parseStoryResponse('<content>正文</content><summary>事件摘要</summary>', [], { foldTags: tags.DEFAULT_STORY_FOLD_TAGS });
  assert.equal(parsed.summaryText, '事件摘要', 'folding preserves memory summary extraction');
  assert.match(parsed.renderedText, /RHR-FOLD:summary/);
  assert.equal(parser.parseStoryResponse('<content>正文</content><summary>兼容摘要</summary>', [], { summaryTag: 'custom_summary', foldTags: tags.DEFAULT_STORY_FOLD_TAGS }).summaryText, '兼容摘要', 'default folding preserves summary fallback when a custom summary tag is configured');
  console.log('PASS: summary default migration, custom/empty preservation, owner-scoped inheritance, persisted active page, render folding and summary extraction');
})().catch(error => { console.error(error); process.exitCode = 1; });
