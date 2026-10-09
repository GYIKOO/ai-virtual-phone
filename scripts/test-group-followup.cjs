const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: key => { if (!(key in dependencies)) throw Error(`Missing mock: ${key}`); return dependencies[key]; }, ...globals });
  return exports;
}
const policy = load('lib/proactive-policy.ts');
const follow = load('lib/proactive-followup.ts');
const rules = { maxConsecutive: 5, anxietyThreshold: 50, anxietyMinDelay: 15, anxietyMaxDelay: 180 };
assert.equal(policy.normalizeProactiveConfig({}).groupFollowUpEnabled, false);
assert.equal(policy.normalizeProactiveConfig({ groupFollowUpInstruction: '自定义' }).groupFollowUpInstruction, '自定义');
assert.equal(follow.groupFollowUpDelay(undefined, 0, rules), null);
assert.equal(follow.groupFollowUpDelay(49, 0, rules), null);
assert.notEqual(follow.groupFollowUpDelay(80, 4, rules), null, 'group uses global cap, not a private personality cap');
assert.equal(follow.groupFollowUpDelay(80, 5, rules), null);
const message = (id, value, patch = {}) => ({ role: 'assistant', senderCharacterId: id,
  freshStateValues: [{ name: '跟进意愿', value }], ...patch });
assert.equal(follow.groupFollowUpValue([message('a', 90), message('b', 20)], '跟进意愿', ['a', 'b']), 90);
assert.equal(follow.groupFollowUpValue([message('a', 90), message('b', 20)], '跟进意愿', ['b']), 20, 'muted/deleted/removed speakers excluded');
assert.equal(follow.groupFollowUpValue([message('a', 90), message('a', 0)], '跟进意愿', ['a']), 0, 'later explicit value wins');
assert.equal(follow.groupFollowUpValue([message('a', 90), message('a', 0, { freshStateValues: undefined })], '跟进意愿', ['a']), 90, 'extra bubble is not a new state');
assert.equal(follow.groupFollowUpValue([message('a', 90, { isRetracted: true })], '跟进意愿', ['a']), undefined);
assert.equal(follow.groupFollowUpValue([message('a', 90, { freshStateValues: [], stateValues: [{ name: '跟进意愿', value: 100 }] })], '跟进意愿', ['a']), undefined);
const kv = new Map();
let now = 1000000;
const scene = load('lib/chat-automation-state.ts', { './kv-db': { kvGet: key => kv.get(key) } }, { Date: { now: () => now } });
assert.equal(scene.isChatSceneBlockingAutomation('g'), false);
kv.set('chat-offline-mode:g', '1');
assert.equal(scene.isChatSceneBlockingAutomation('g'), true);
kv.clear(); scene.startManualChatRun('g', 'run'); now += 600000;
assert.equal(scene.isChatSceneBlockingAutomation('g'), true, 'active in-tab request outlives crash lease');
scene.finishManualChatRun('g', 'wrong');
assert.equal(scene.isChatSceneBlockingAutomation('g'), true);
scene.finishManualChatRun('g', 'run');
assert.equal(scene.isChatSceneBlockingAutomation('g'), false);
kv.set('chat-theater-mode:g', '1');
assert.equal(scene.isChatSceneBlockingAutomation('g'), true);
const context = load('lib/proactive-context.ts', {
  './character-storage': { loadCharacters: () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] },
  './memory-storage': { loadMemoryConfig: () => ({}) },
  './character-time': { buildCharacterTimeContext: () => ({ timeContext: 'UTC' }) },
  './short-term-assembler': { filterTimelineByAllowedSources: rows => rows,
    loadNativeTimeline: id => id === 'a' ? [{ id: 'secret', timestamp: '2026-10-09T01:00:00Z', content: 'A的私下经历', sourceApp: 'story' }] : [] },
}, { Date });
const situation = context.prepareProactiveSituation({ isGroup: true, id: 'g', participantIds: ['a', 'b'] }, [], undefined, Date.parse('2026-10-09T02:00:00Z'));
assert.ok(situation.context.includes('"memoryOwners":[{"id":"a","name":"A"}]'), 'cross-app memories retain their owners');
for (const file of ['lib/chat-plugin-types.ts', 'lib/chat-plugin-runtime.ts', 'lib/chat-plugin-docs.ts']) {
  assert.ok(!fs.readFileSync(file, 'utf8').includes('generateGroup'), 'no unpublished one-off plugin endpoint');
}
assert.ok(fs.readFileSync('components/chat/chat-room.tsx', 'utf8').includes('if (!offlineMode && !theaterMode) schedulePersonalityFollowUp(session.id, 0);'));
assert.ok(fs.readFileSync('components/chat/proactive-settings.tsx', 'utf8').includes('群聊追发提示词'));
console.log('PASS: native group intent, shared cap, default-off/editable settings, scene guards, memory ownership and plugin API isolation.');
