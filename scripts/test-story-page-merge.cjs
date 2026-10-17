// Real story storage + real short-term assembler, backed only by in-memory IDB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { indexedDB, IDBKeyRange } = require(require.resolve('fake-indexeddb', { paths: [process.env.FLOAT_TEST_DEPS || process.cwd()] }));
const Dexie = require('dexie');
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
const modules = new Map(), kv = new Map();
const at = n => `2026-10-10T${String(n).padStart(2, '0')}:00:00.000Z`;
const chatRows = [2, 4].map(n => ({ id: `chat${n}`, sessionId: 'chat', role: 'user', content: `线上${n}`, createdAt: at(n) }));
const mocks = {
  dexie: Dexie,
  './kv-db': { hydrateKvDb: async () => {}, registerKvMigration() {}, registerDynamicPrefix() {}, kvGet: key => kv.get(key), kvSet: (key, value) => kv.set(key, value) },
  './llm-prompt-assembler': { formatChatTimestamp: value => value },
  './chat-storage': { loadChatSessions: () => [{ id: 'chat', contactId: 'a' }], loadChatMessages: () => chatRows,
    isReadingDiscussMessage: () => false, isSystemInstructionMessage: () => false },
  './character-storage': { loadCharacters: () => [{ id: 'a', name: 'A' }] },
  './settings-storage': { resolveUserIdentity: () => ({ name: '用户' }) },
  './memory-storage': { loadMemoryConfig: () => ({ shortTermTokenBudget: 10000 }) },
  './token-counter': { estimateTokens: () => 1 },
  './prompt-sanitizer': { stripStateAndInnerForPrompt: text => text },
  './user-macro': { renderUserNameMacro: text => text },
  './prompt-time': { resolvePromptTimeAware: () => true, formatPromptTimestamp: text => text,
    formatStoredPromptEventContent: text => text, formatPromptEventLabel: (label, time) => `${label} ${time}` },
};
function load(name) {
  if (mocks[name]) return mocks[name];
  if (modules.has(name)) return modules.get(name);
  if (!['./prompt-memory-budget', './narrative-context', './memory-context-policy', './story-storage', './story-tag-settings', './short-term-assembler', './story-engine', './story-instructions', './story-constraints', './story-context-budget', './story-ensemble-context', './character-relation-context', './story-preparation', './story-preset-selection'].includes(name)) {
    return new Proxy({}, { get: () => () => [] }); // All unrelated app stores are empty.
  }
  const exports = {};
  modules.set(name, exports);
  const filename = `lib/${name.slice(2)}.ts`;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: load, window: {}, indexedDB, IDBKeyRange, console, Date, structuredClone, setTimeout, clearTimeout }, { filename });
  return exports;
}
const json = value => JSON.parse(JSON.stringify(value));
(async () => {
  const db = new Dexie('AiPhoneStoryDB');
  db.version(1).stores({ sessions: 'id, characterId, updatedAt', messages: 'id, sessionId, createdAt' });
  const page = (id, branchId, extra = {}) => ({ id, characterId: 'a', ownerType: 'single', ownerId: 'a', participantIds: ['a'], branchId, createdAt: at(0), updatedAt: at(0), ...extra });
  const row = (id, sessionId, n) => ({ id, sessionId, role: 'assistant', rawContent: `正文${n}`, storySummary: `摘要${n}`, createdAt: at(n) });
  const original = [row('main1', 'main', 1), row('main5', 'main', 5), row('branch3', 'branch', 3), row('if6', 'if', 6), row('foreign7', 'foreign', 7)];
  await db.sessions.bulkPut([page('main', 'main'), page('branch', 'branch'), page('if', 'if', { independentStory: true }),
    page('foreign', 'main', { characterId: 'b', ownerId: 'b', participantIds: ['b'] }), page('empty', 'empty')]);
  await db.messages.bulkPut(original);
  let store = load('./story-storage');
  await store.hydrateStoryStorage();
  const assembler = load('./short-term-assembler');
  const history = () => store.loadStoryMessages('main').map(m => ({ ...m, content: m.rawContent }));
  const context = () => assembler.prepareShortTermContext('a', 'story', { history: history(), excludeStoryMessageIds: history().map(m => m.id) });
  let ctx = context();
  assert.ok(ctx.wbActivationContext.includes('正文5'), 'current prose still activates world books and long-term retrieval');
  assert.deepEqual(json(ctx.unifiedRecentItems.map(i => i.timestamp)), [1, 2, 3, 4, 5].map(at), 'main, online, branch, online, main are chronological');
  assert.equal(ctx.unifiedRecentItems.filter(i => i.kind === 'event' && i.sourceApp === 'story').length, 1, 'only other page summary, not current page duplicates');
  assert.ok(!JSON.stringify(ctx).includes('摘要6') && !JSON.stringify(ctx).includes('摘要7'), 'IF and unrelated characters stay isolated');
  const reverse = assembler.prepareShortTermContext('a', 'story', { history: store.loadStoryMessages('branch').map(m => ({ ...m, content: m.rawContent })) });
  assert.equal(reverse.unifiedRecentItems.filter(i => i.kind === 'event' && i.sourceApp === 'story').length, 2, 'other pages can read main too');
  const retry = assembler.prepareShortTermContext('a', 'story', { history: history().slice(0, 1), excludeStoryMessageIds: ['main1', 'main5'] });
  assert.ok(!JSON.stringify(retry).includes('摘要5'), 'discarded retry suffix is not reintroduced as memory');
  const fresh = assembler.prepareShortTermContext('a', 'story', { history: [], afterTimestamp: at(3) });
  assert.ok(!JSON.stringify(fresh).includes('摘要3'), 'creation-time memory boundary remains respected');
  const projectionsBefore = json(store.loadStoryProjectionEntries('a'));
  await assert.rejects(store.mergeStoryPageIntoMain('main'), /普通分线/);
  await assert.rejects(store.mergeStoryPageIntoMain('if'), /普通分线/);
  await assert.rejects(store.mergeStoryPageIntoMain('empty'), /没有可合并/);
  // Force an error after the transaction's writes to verify rollback, including caches.
  const originalTransaction = Dexie.prototype.transaction;
  Dexie.prototype.transaction = function (...args) {
    const scope = args.pop();
    return originalTransaction.call(this, ...args, async (...inner) => { await scope(...inner); throw new Error('simulated disk failure'); });
  };
  try { await assert.rejects(store.mergeStoryPageIntoMain('branch'), /simulated disk failure/); }
  finally { Dexie.prototype.transaction = originalTransaction; }
  assert.equal((await db.messages.get('branch3')).sessionId, 'branch');
  assert.equal(store.loadStoryMessages('main').length, 2);
  assert.ok(!store.loadStorySessions().find(s => s.id === 'branch').mergedIntoSessionId);
  const merging = store.mergeStoryPageIntoMain('branch');
  assert.throws(() => store.pushStoryMessage({ sessionId: 'branch', role: 'user', rawContent: 'race' }), /正在合并/);
  assert.throws(() => store.deleteStoryMessage('main1'), /正在合并/);
  assert.throws(() => store.updateStorySession('empty', { settings: { minChars: 900 } }), /正在合并/, 'shared settings cannot race merging peers');
  await merging;
  const mainRows = store.loadStoryMessages('main');
  assert.deepEqual(json(mainRows.map(m => m.id)), ['main1', 'branch3', 'main5']);
  assert.deepEqual(json(mainRows.find(m => m.id === 'branch3')), { ...original[2], sessionId: 'main' }, 'full original message preserved, only owner changes');
  assert.deepEqual(json(store.loadStoryProjectionEntries('a')), projectionsBefore, 'archive cannot duplicate or change memory sources');
  assert.equal(store.loadStoryMessages('branch').length, 1, 'archive views the canonical migrated record');
  assert.throws(() => store.pushStoryMessage({ sessionId: 'branch', role: 'user', rawContent: 'new' }), /只读/);
  assert.throws(() => store.replaceStoryMessages('branch', []), /只读/);
  assert.throws(() => store.deleteStoryMessagesFrom('branch', 'branch3'), /只读/);
  assert.throws(() => store.updateStorySession('branch', { autoStartPrompt: 'new' }), /只读/);
  await assert.rejects(store.mergeStoryPageIntoMain('branch'), /只读/);
  assert.deepEqual(json(context().unifiedRecentItems.map(i => i.timestamp)), [1, 2, 3, 4, 5].map(at));
  assert.equal(context().unifiedRecentItems.filter(i => i.kind === 'event' && i.sourceApp === 'story').length, 0, 'merged prose replaces summary in current page');
  modules.delete('./story-storage');
  store = load('./story-storage');
  await store.hydrateStoryStorage();
  assert.equal(store.loadStoryMessages('branch').length, 1, 'archive survives rehydration');
  assert.equal(store.loadStorySessions().find(s => s.id === 'branch').mergedIntoSessionId, 'main');
  store.deleteStorySessions(['branch']);
  assert.equal(store.loadStoryMessages('main').length, 3, 'deleting archive never deletes canonical main messages');
  assert.equal((await db.messages.get('branch3')).sessionId, 'main');
  assert.equal((await db.messages.get('foreign7')).sessionId, 'foreign');
  const groupOptions = { ownerType: 'group', ownerId: 'group-a-b', participantIds: ['a', 'b'] };
  const groupMain = store.createOrGetStorySession('a', groupOptions);
  const groupBranch = store.createOrGetStorySession('a', { ...groupOptions, branchId: 'meeting' });
  const groupMessage = store.pushStoryMessage({ sessionId: groupBranch.id, role: 'assistant', rawContent: '多人正文', storySummary: '多人见面摘要' });
  await store.mergeStoryPageIntoMain(groupBranch.id);
  assert.equal(store.loadStoryMessages(groupMain.id)[0].id, groupMessage.id);
  assert.equal(store.loadStoryMessages('main').length, 3, 'group merging does not move records into single-character main');
  assert.equal(store.loadStoryProjectionEntries('b').filter(e => e.id === `story_projection_${groupMessage.id}`).length, 1, 'group participants receive one shared event');
  const mismatched = store.createOrGetStorySession('a', { ...groupOptions, participantIds: ['a', 'c'], branchId: 'mismatch' });
  await assert.rejects(store.mergeStoryPageIntoMain(mismatched.id), /参与角色不同/);
  // Reproduce ABC -> DABC with the newly joined character selected first.
  // Real storage projections + real recent selection + real Story request builder.
  const abc = store.createOrGetStorySession('a', { ownerType: 'group', ownerId: 'abc', participantIds: ['a', 'b', 'c'] });
  store.pushStoryMessage({ sessionId: abc.id, role: 'assistant', rawContent: '三人曾在车站见面。', storySummary: 'ABC三人车站见面事件', createdAt: at(8) });
  const dabc = store.createOrGetStorySession('d', { ownerType: 'group', ownerId: 'dabc', participantIds: ['d', 'a', 'b', 'c'] });
  mocks['./character-storage'].loadCharacters = () => ['a','b','c','d'].map(id => ({ id, name: id.toUpperCase() }));
  Object.assign(mocks['./settings-storage'], { loadBindingConfig: () => ({characterBindings:[]}), resolveBinding: () => ({ apiConfigId:'local' }),
    loadApiConfigs: () => [{ id:'local', defaultModel:'offline' }], loadPresets: () => [], loadRegexes: () => [], loadWorldBooks: () => [] });
  Object.assign(mocks['./llm-prompt-assembler'], { isContextMarkerEnabled: () => true,
    assemblePromptPayload: ({history, unifiedRecentItems}) => unifiedRecentItems?.length ? unifiedRecentItems.map(item => item.kind === 'event' ? {role:'system', content:item.text} : {role:history[item.historyIndex].role, content:history[item.historyIndex].content}) : history.map(m => ({role:m.role,content:m.content})) });
  mocks['./chat-engine'] = { ChatEngineError:Error, previewMessagesForApi: (_a,_p,messages) => messages };
  mocks['./memory-service'] = { retrieveMemoriesForPrompt: async()=>null, retrieveCoreMemoriesForPrompt:async()=>null, createStoryMemoryRanker: () => async () => [] };
  mocks['./calendar-storage'] = { buildCalendarScheduleMarker:()=>'', getCurrentCalendarScheduleForPrompt:()=>'' };
  mocks['./character-world-storage'] = { formatCharacterRelationsForPrompt:()=>'', formatCharactersRelationsForPrompt:()=>'' };
  modules.delete('./short-term-assembler');
  const engine = load('./story-engine');
  const preview = await engine.previewStoryPromptPayload('d', [], { sessionId:dabc.id, participantIds:['d','a','b','c'] });
  const assembled = preview.messages.map(m=>m.content).join('\n');
  assert.equal(assembled.split('三人曾在车站见面。').length - 1, 1, 'ABC scene full prose is available once when D leads the new ensemble');
  assert.ok(!assembled.includes('ABC三人车站见面事件'), 'full prose replaces its summary');
  assert.match(assembled, /记录归属：A、B、C/);
  assert.ok(!assembled.includes('记录归属：A、B、C、D'), 'D does not acquire the event as its personal memory');
  const isolated = await engine.previewStoryPromptPayload('d', [], { sessionId:dabc.id, participantIds:['d','a','b','c'], storyMemory:{independent:true} });
  assert.ok(!isolated.messages.some(m=>m.content.includes('三人曾在车站见面。')));
  console.log('PASS: ABC -> DABC real stored event reaches ensemble request through shared participants, not D; isolated story excludes it');
  console.log('PASS: group pages merge only within the same owner and participant set');
  console.log('PASS: cross-page chronological memory, current-page deduplication, retry exclusion, IF/character isolation and creation-time boundary');
  console.log('PASS: atomic page merge/rollback, stable IDs/times/summaries, read-only archive, no memory duplication, reload and safe archive deletion');
})().catch(error => { console.error(error); process.exitCode = 1; });
