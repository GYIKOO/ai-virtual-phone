// Offline policy/assembly regression. No API calls or user database access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load(file, deps = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(compile(fs.readFileSync(file, 'utf8')), { exports, require: name => deps[name] || {}, console, ...globals });
  return exports;
}
function extract(file, name, globals) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(fn, name);
  return vm.runInNewContext(`${compile(fn.getText(source))}\n${name}`, { exports: {}, console, ...globals });
}
const kv = new Map();
const kvMock = { kvGet: key => kv.get(key), kvSet: (key, value) => kv.set(key, value), registerKvMigration() {} };
const storage = load('lib/moments-storage.ts', { './kv-db': kvMock }, { window: {} });
const config = () => storage.loadMomentsConfig();

async function gates() {
  let sessions = [{ id: 's', contactId: 'c', proactiveDisabled: true }];
  let saved = 0, notified = 0, mutate;
  const controller = new AbortController();
  const parser = load('lib/action-parser.ts', {
    './chat-storage': { loadChatContacts: () => [{ characterId: 'c' }], loadChatSessions: () => sessions,
      loadChatMessages: () => [], createOrGetSession: () => sessions[0] },
    './character-storage': { loadCharacters: () => [{ id: 'c', name: 'C' }] },
    './abort-utils': { throwIfAborted() {}, isAbortError: () => false },
    './follow-up-service': { parseAndSaveResponse: async (_a, _b, _c, _d, _e, options) => {
      mutate?.(); const visible = options.canPersist(); if (visible) saved++; return { hasVisible: visible };
    } },
  }, { window: { dispatchEvent: () => notified++ }, CustomEvent: class {} });
  const context = { characterId: 'c', sourceEngine: 'moments', signal: controller.signal };
  for (const type of ['消息', '私信']) await parser.dispatchActions([{ type, content: 'test only' }], context);
  assert.equal(saved, 2, 'Moments DM is independent from scheduled proactive permission, as requested');
  sessions = [{ id: 'group', isGroup: true, groupName: 'TestGroup', participantIds: ['c'], proactiveDisabled: true }];
  await parser.dispatchActions([{ type: '群消息', target: 'TestGroup', content: 'test only' }], context);
  assert.equal(saved, 3);
  const priorNotifications = notified;
  mutate = () => controller.abort();
  await parser.dispatchActions([{ type: '群消息', target: 'TestGroup', content: 'test only' }], context);
  assert.equal(saved, 3); assert.equal(notified, priorNotifications, 'cancelled actions do not report new messages');
}
async function scheduling() {
  storage.saveMomentsConfig({ ...config(), autoPostProbabilityByCharacter: { c: 0, rare: 0.2 } });
  assert.equal(storage.getMomentPostProbability('other'), 1, 'old configurations retain behavior');
  assert.equal(storage.getMomentPostProbability('rare'), 0.2);
  let requests = 0;
  storage.getOrCreateSchedule('c');
  storage.saveAIMomentSchedule([{ characterId: 'c', lastPostTime: 123, nextPostAfter: Date.now() - 1 }]);
  const poll = extract('lib/moments-engine.ts', 'pollScheduledPosts', {
    isGenerating: false, Date, Math, loadChatContacts: () => [{ characterId: 'c' }],
    loadMomentsConfig: config, getMomentPostProbability: storage.getMomentPostProbability,
    getOrCreateSchedule: storage.getOrCreateSchedule, updateScheduleAfterPost: storage.updateScheduleAfterPost,
    triggerAIPost: async id => { requests++; storage.updateScheduleAfterPost(id); },
  });
  poll(); poll(); poll();
  assert.equal(requests, 0);
  assert.ok(storage.getOrCreateSchedule('c').nextPostAfter > Date.now(), 'miss schedules next opportunity');
  assert.equal(storage.getOrCreateSchedule('c').lastPostTime, 123, 'miss is not a fictional posted event');
  storage.saveMomentsConfig({ ...config(), autoPostProbabilityByCharacter: { c: 1 } });
  storage.saveAIMomentSchedule([{ characterId: 'c', lastPostTime: 123, nextPostAfter: Date.now() - 1 }]);
  poll(); await Promise.resolve(); await Promise.resolve(); assert.equal(requests, 1);
  storage.saveMomentsConfig({ ...config(), autoPostProbabilityByCharacter: { c: -1, rare: 3, invalid: '0.2' }, lifePrompt: '' });
  assert.equal(storage.getMomentPostProbability('c'), 0); assert.equal(storage.getMomentPostProbability('rare'), 1);
  assert.equal(storage.getMomentPostProbability('invalid'), 1); assert.equal(config().lifePrompt, '', 'blank prompt is an opt-out');
}

function timeAndPlans() {
  const time = load('lib/character-time.ts');
  const recent = load('lib/recent-time-context.ts', { './character-time': time });
  const at = Date.parse('2026-10-12T12:00:00Z');
  const result = recent.buildRecentTimeContext([
    { source: 'chat', timestamp: '2026-10-09T12:00:00Z' },
    { source: 'future', timestamp: '2026-10-13T12:00:00Z' },
    { source: 'invalid', timestamp: 'oops' },
  ], at, 'Asia/Shanghai');
  assert.match(result, /3天0小时0分钟/); assert.match(result, /2026-10-09 20:00 Asia\/Shanghai/);
  assert.ok(!result.includes('future')); assert.ok(!result.includes('invalid'));
  assert.equal(time.buildCharacterTimeContext('Asia/Shanghai', new Date(at)).referenceTime, at);
  assert.equal(time.buildGroupTimeContext([], new Date(at)).referenceTime, at, 'historical reference retained');
  const promptTime = load('lib/prompt-time.ts', { './character-time': time, './chat-storage': { loadChatAppSettings: () => ({ timeAware: true }) } });
  const assembler = load('lib/llm-prompt-assembler.ts', {
    './character-time': time, './recent-time-context': recent, './prompt-time': promptTime,
    './macro-engine': { MacroEngine: class { expand(text) { return text; } }, postProcessTrim: text => text },
  });
  const input = { character: { id: 'c', name: 'C' }, history: [], worldBooks: [], regexes: [], appId: 'moments',
    timeContext: time.buildCharacterTimeContext('Asia/Shanghai', new Date(at)),
    preset: { prompts: [{ identifier: 'shortTermMemory', role: 'system', marker: true, enabled: true }] },
    unifiedRecentItems: [{ kind: 'event', sourceTag: 'recent_chat', sourceApp: 'chat', timestamp: '2026-10-09T12:00:00Z', text: 'past conversation' }],
  };
  const assembled = overrides => assembler.assemblePromptPayload({ ...input, ...overrides }).map(m => m.content).join('\n');
  assert.match(assembled({}), /3天0小时0分钟/);
  assert.ok(!assembled({ timeAware: false }).includes('近期记录的时间跨度'));
  assert.ok(!assembled({ preset: { prompts: [] } }).includes('近期记录的时间跨度'), 'disabled or absent memory markers are respected');
  assert.match(assembled({ timeContext: time.buildCharacterTimeContext('Asia/Shanghai', new Date(at - 86400000)) }), /2天0小时0分钟/, 'replay elapsed time is calculated against replay, not wall clock');
  const utils = load('lib/calendar-utils.ts');
  const calendar = load('lib/calendar-storage.ts', { './kv-db': kvMock, './calendar-utils': utils, './character-time': time }, { window: {} });
  const item = (id, date, startTime, endTime) => ({ id, date, startTime, endTime, title: id, location: 'library', colorKey: 'blue', source: 'manual' });
  const plans = [
    { ownerType: 'character', ownerId: 'c', weekStart: '2026-10-05', items: [item('recent', '2026-10-11', '23:00', '23:30'), item('old', '2026-10-10', '09:00', '10:00')] },
    { ownerType: 'character', ownerId: 'c', weekStart: '2026-10-12', items: [item('current', '2026-10-12', '00:00', '02:00'), item('future', '2026-10-12', '07:00', '08:00'), item('distant', '2026-10-13', '07:00', '08:00')] },
    { ownerType: 'character', ownerId: 'other', weekStart: '2026-10-12', items: [item('private-other', '2026-10-12', '00:00', '02:00')] },
  ];
  kv.set('ai_phone_calendar_plans_v1', JSON.stringify({ plans }));
  const window = calendar.buildNearbyCalendarScheduleForPrompt('character', 'c', new Date('2026-10-12T01:00:00'));
  for (const id of ['current', 'recent', 'future']) assert.ok(window.includes(id));
  for (const id of ['old', 'distant', 'private-other']) assert.ok(!window.includes(id));
  assert.ok(window.indexOf('current') < window.indexOf('recent'));
  assert.match(window, /按计划已结束/); assert.match(window, /实际进展以经历记录为准/);
  const policy = load('lib/proactive-policy.ts');
  assert.match(policy.defaultProactiveConfig().instruction, /未聊天期间/);
  assert.equal(policy.normalizeProactiveConfig({ instruction: 'custom' }).instruction, 'custom');
  assert.equal(policy.normalizeProactiveConfig({ instruction: '' }).instruction, '');
}
(async () => { await gates(); await scheduling(); timeAndPlans(); console.log('PASS: independent Moments DMs and cancellation, per-character once-per-opportunity probability, silence without API, elapsed time/replay, adjacent-week calendar windows and editable prompt preservation'); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
