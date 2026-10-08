const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  vm.runInNewContext(compiled.outputText, { exports, require: key => {
    if (!(key in dependencies)) throw new Error(`Missing mock: ${key}`);
    return dependencies[key];
  }, console, AbortController, ...globals });
  return exports;
}
const p = load('lib/proactive-policy.ts');
const clock = load('lib/proactive-clock.ts', { './proactive-policy': p });
const followup = load('lib/proactive-followup.ts');
const replay = load('lib/proactive-replay.ts');
assert.equal(replay.replayTime({ fixedAt: 1000 }, 'fixed', 100000, { leftAt: 0, returnedAt: 99000 }), 1000);
assert.equal(replay.replayTime({ fixedAt: 1000 }, 'fixed', 100000), undefined);
assert.equal(replay.replayTime({ fixedAt: 1000, deferred: { fixed: true } }, 'fixed', 100000), undefined);
assert.equal(replay.knownAt('2026-10-05T08:00:00Z', Date.parse('2026-10-05T09:00:00Z'), '2026-10-05T10:00:00Z'), false);
const rules = { followUpFieldName: '跟进意愿', maxConsecutive: 3, anxietyThreshold: 50, anxietyMinDelay: 15, anxietyMaxDelay: 180 };
assert.equal(followup.followUpDelay(4, undefined, 0, rules), null);
assert.equal(followup.followUpDelay(0, 100, 0, rules), null);
assert.equal(followup.followUpDelay(1, 60, 0, rules), null);
assert.notEqual(followup.followUpDelay(4, 60, 0, rules), null);
assert.equal(followup.followUpDelay(4, 100, 3, rules), null);
assert.equal(followup.followUpDelay(4, 100, 0, { ...rules, maxConsecutive: 0 }), null);
for (let tier = 1; tier <= 4; tier++) for (let value = 0; value <= 100; value++) {
  const delay = followup.followUpDelay(tier, value, 0, rules);
  assert.ok(delay === null || (delay >= 15 && delay <= 180));
}
const config = { ...p.defaultProactiveConfig(), enabled: true, personalityEnabled: true };
const oldDefault = "这是一次自主交流机会，不是用户发来的新消息。根据角色设定、已有关系、当前生活和对话情境，决定是否有想说的内容。关系不默认是恋爱或亲密关系；未收到回复本身不代表冷落或需要催促。可以分享、讨论、告知或延续有意义的话题，也可以保持沉默。群聊成员可以彼此交流，不必围绕用户或等待用户回复；本次只进行一小轮交流。";
assert.equal(p.normalizeProactiveConfig({ instruction: oldDefault }).instruction, p.DEFAULT_PROACTIVE_INSTRUCTION);
assert.equal(p.normalizeProactiveConfig({ instruction: '我的自定义提示词' }).instruction, '我的自定义提示词');
assert.equal(p.normalizeProactiveConfig({ instruction: '' }).instruction, '');
assert.ok(p.proactiveInstruction(config, 'fixed').includes('<proactive-skip/>'), 'silent output protocol preserved');
assert.equal(p.intervalMs(config, 'fixed'), 8 * 3600000);
assert.equal(p.nextProactiveAt(config, 'fixed', 100, () => 0), 100 + 8 * 3600000 * .8);
assert.equal(p.nextProactiveAt(config, 'fixed', 100, () => 1), 100 + 8 * 3600000 * 1.2);
assert.equal(p.intervalMs({ ...config, adjustment: 40 }, 'personality'), (9 / 1.4) * 3600000);
assert.equal(p.intervalMs({ ...config, adjustment: -40 }, 'personality'), (9 / (1 / 1.4)) * 3600000);
assert.equal(p.maxFollowUps(config), 0);
assert.deepEqual(Array.from({ length: 5 }, (_, followUpTier) => p.maxFollowUps({ ...config, followUpTier })), [0, 1, 1, 2, 3]);
assert.equal(p.planProactive(config, 1, 1, true).personalityAt, undefined);
assert.equal(p.planProactive({ ...config, enabled: false }, 1, 1).fixedAt, undefined);
const planned = p.planProactive(config, 100, 1, false, () => .5);
assert.equal(p.dueProactive(planned, 101), null);
assert.ok(p.dueProactive(planned, planned.fixedAt));
const consumed = p.consumeProactive(config, planned, 10 ** 12, false);
assert.ok(consumed.fixedAt > 10 ** 12 && consumed.personalityAt > 10 ** 12, 'missed cycles are not replayed');
assert.equal(p.normalizeProactiveConfig({ intervalMinutes: NaN, initiativeTier: 100, followUpTier: -1 }).initiativeTier, 4);
assert.equal(p.normalizeProactiveConfig({ intervalMinutes: NaN }).intervalMinutes, 480);

const cache = new Map();
const storage = load('lib/proactive-storage.ts', {
  './kv-db': { kvGet: k => cache.get(k), kvSet: (k, v) => cache.set(k, v), registerKvMigration: () => {} },
  './proactive-policy': p,
}, { window: { dispatchEvent() {} }, CustomEvent: class {} });
const a = storage.saveProactiveConfig('a', config, false);
assert.ok(a.state.configuredAt > 0, 'settings persist a new cycle floor');
storage.saveProactiveConfig('a', { ...config, enabled: false }, false);
assert.equal(storage.saveProactiveState('a', a.state), false, 'stale response cannot restore old settings');
storage.saveProactiveConfig('b', config, true);
assert.equal(storage.loadProactive('b').config.personalityEnabled, false);
storage.removeProactive('a');
assert.ok(storage.loadProactive('b'), 'deleting one session preserves others');
const receipt = storage.saveProactiveConfig('del', config, false);
storage.saveProactiveState('del', { ...receipt.state, anchor: 'bubble2:time', handledMessageIds: ['bubble1', 'bubble2'], followupAt: 1 });
assert.equal(storage.dismissDeletedProactive('del', ['unrelated'], false, 100000000), false);
assert.equal(storage.dismissDeletedProactive('del', ['bubble1'], false, 100000000), true, 'deleting any bubble dismisses its entire opportunity');
const dismissed = storage.loadProactive('del');
assert.equal(dismissed.state.revision, receipt.state.revision + 1);
assert.equal(dismissed.state.followupAt, undefined);
assert.equal(dismissed.state.cycleFloorAt, 100000000);
assert.ok(dismissed.state.fixedAt > 100000000);
assert.equal(storage.saveProactiveState('del', receipt.state), false, 'delete invalidates an in-flight generation');
assert.ok(storage.loadProactive('b'), 'dismissal leaves other conversations intact');
const temporalContext = load('lib/proactive-context.ts', {
  './character-storage': { loadCharacters: () => [{ id: 'c', name: 'A', timeZone: 'Asia/Shanghai' }] },
  './memory-storage': { loadMemoryConfig: () => ({}) },
  './short-term-assembler': { loadNativeTimeline: () => [], filterTimelineByAllowedSources: x => x },
  './character-time': load('lib/character-time.ts'),
});
const lateNight = temporalContext.prepareProactiveSituation({ id: 's', contactId: 'c' }, [
  { id: 'goodnight', role: 'assistant', createdAt: '2026-10-09T17:00:00.000Z', content: '晚安' },
], undefined, Date.parse('2026-10-10T16:00:00.000Z'));
assert.ok(lateNight.context.includes('距本轮 23小时') && lateNight.context.includes('发言者：角色'));
assert.ok(lateNight.context.includes('2026-10-10T16:00:00.000Z'));
for (const file of ['lib/chat-engine.ts', 'lib/group-chat-engine.ts']) {
  assert.ok(fs.readFileSync(file, 'utf8').includes('if (!options?.appTags?.includes("proactive")) appendEmptyGenerateGuardMessage'), 'manual continuation guard is excluded from proactive generation');
}
assert.ok(fs.readFileSync('lib/chat-storage.ts', 'utf8').includes('if (session) dismissDeletedProactive(sessionId,'), 'all message deletion paths reach scoped dismissal');

async function scenario({ group = false, output = 'hello', mutate, failure = false, quiet = false, foreground = false, fresh = true, source = 'fixed', used = 0, overdue = 1, deferred = false, absence = { leftAt: 99000000, returnedAt: 100000000 }, changedConfig = false, unversioned = false, changedAnchor = false, enabled = true, crossEvents = [] } = {}) {
  let now = 100000000;
  const session = { id: 's', contactId: 'c', isGroup: group };
  const createdAt = new Date(now - 3600000).toISOString();
  const history = [{ id: 'u', role: 'user', createdAt }];
  let record = { config: { ...config, enabled, followUpTier: 2 }, state: { revision: 1, [`${source}At`]: now - overdue, deferred: { [source]: deferred }, quietReleased: { [source]: true }, followupCount: used, followupRules: JSON.stringify(rules),
    anchor: `u:${createdAt}`, anchorAt: now - 3600000, clockVersion: 2, quietSetting: '' } };
  if (changedConfig || unversioned) record.state = { ...p.planProactive(record.config, now, 2, group), ...(changedConfig ? { configuredAt: now } : {}) };
  if (changedAnchor) { record.state.configuredAt = now - 1800000; history.push({ id: 'new', role: 'user', createdAt: new Date(now).toISOString() }); }
  const calls = [], saved = [], events = [], builds = [];
  const store = {
    loadProactive: () => structuredClone(record),
    saveProactiveState: (_s, state) => { if (state.revision !== record.state.revision) return false; record.state = structuredClone(state); return true; },
    refreshProactive: async () => {}, flushProactive: async () => {},
  };
  const prompt = { llmMessages: [], config: {}, preset: null, regexes: [], character: { name: 'C' }, ...(group ? { nameToId: new Map([['C', 'c']]) } : {}) };
  const context = load('lib/proactive-context.ts', {
    './character-storage': { loadCharacters: () => [{ id: 'c', name: 'C', timeZone: 'UTC' }] },
    './memory-storage': { loadMemoryConfig: () => ({}) },
    './short-term-assembler': { loadNativeTimeline: () => crossEvents, filterTimelineByAllowedSources: x => x },
    './character-time': load('lib/character-time.ts'),
  });
  const service = load('lib/proactive-service.ts', {
    './chat-storage': { loadChatSessions: () => [session], loadChatMessages: () => history, clearFollowUpSchedule() {} },
    './chat-engine': {
      buildChatPromptMessages: async (...args) => { builds.push(args); return prompt; }, stripPresetTexts: x => x,
      sendLLMRequest: async (...args) => { calls.push(args); if (mutate) mutate({ session, record, history, service }); if (failure) throw new Error('mock failure'); return output; },
    },
    './group-chat-engine': { buildGroupChatPromptMessages: async (...args) => { builds.push(args); return prompt; }, parseGroupChatResponse: text => [{ characterId: 'c', characterName: 'C', responseText: text }] },
    './push-bailout-client': { cancelFollowUpBailout() {}, cancelBailoutPrefix() {} },
    './idle-reconnect-storage': { loadIdleReconnectRules: () => [] },
    './push-client': { isWithinPushQuietHours: () => quiet, loadPushQuietHours: () => '' },
    './kv-db': { kvGet: () => foreground ? JSON.stringify({ startedAt: now }) : null },
    './proactive-storage': store, './proactive-policy': p, './proactive-clock': clock,
    './settings-storage': { loadFollowUpConfig: () => rules }, './proactive-followup': followup,
    './proactive-replay': replay,
    './proactive-context': context,
    './proactive-presence': { getProactiveAbsence: () => absence },
    './follow-up-service': { parseAndSaveResponse: async (...args) => { saved.push(args); history.push({ id: 'a', role: 'assistant', createdAt: args[5]?.createdAt ?? new Date(now).toISOString(), proactiveTiming: args[5]?.proactiveTiming, stateValues: [{ name: '跟进意愿', value: 90 }], freshStateValues: fresh ? [{ name: '跟进意愿', value: 90 }] : [] }); return { hasVisible: true }; } },
    './memory-storage': { incrementEventCounter() {} }, './memory-summarizer': { maybeRunSummarization: async () => {} },
    './character-storage': { loadCharacters: () => [{ id: 'c', name: 'C' }] },
  }, {
    Date: class extends Date { static now() { return now; } },
    window: { dispatchEvent: e => events.push(e) }, CustomEvent: class { constructor(name, data) { this.name = name; this.detail = data.detail; } },
  });
  service.pollNewProactive(now, () => false);
  await new Promise(resolve => setImmediate(resolve));
  service.pollNewProactive(now, () => false);
  await new Promise(resolve => setImmediate(resolve));
  return { calls, saved, events, record, service, builds, history, async advance(ms) { now += ms; service.pollNewProactive(now, () => false); await new Promise(resolve => setImmediate(resolve)); } };
}
(async () => {
  const normal = await scenario();
  for (const flags of [{ changedConfig: true }, { unversioned: true }, { changedAnchor: true }]) {
    const reset = await scenario(flags);
    assert.equal(reset.calls.length, 0, 'settings/migration/new interaction do not replay old chat');
    assert.equal(reset.record.state.anchorAt, 100000000);
    assert.ok(reset.record.state.fixedAt > 100000000);
  }
  assert.equal((await scenario({ enabled: false })).calls.length, 0, 'disabled new scheduler never calls API');
  assert.equal((await scenario({ overdue: 120000, absence: null })).builds[0][2].historicalAt, undefined);
  assert.equal((await scenario({ overdue: 4 * 86400000 })).builds[0][2].historicalAt, undefined, 'four-day-old task cannot be replayed into latest absence');
  const oldWindow = { leftAt: 99000000, returnedAt: 100000000 };
  assert.equal((await scenario({ overdue: 120000, absence: oldWindow, mutate: () => { oldWindow.leftAt = 99999999; } })).saved.length, 0, 'a new absence invalidates an in-flight historical result');
  for (const group of [false, true]) {
    const backfill = await scenario({ overdue: 120000, group });
    assert.equal(backfill.builds[0][2].historicalAt, 100000000 - 120000);
    assert.equal(backfill.saved[0][5].createdAt, new Date(100000000 - 120000).toISOString());
    assert.equal(backfill.saved[0][5].historicalReplay, true);
    assert.ok(backfill.calls[0][2].some(m => m.content.includes(new Date(100000000 - 120000).toISOString())));
    assert.ok(backfill.record.state.fixedAt > 100000000, 'next cycle is not another overdue replay');
  }
  const quietRecovery = await scenario({ overdue: 120000, deferred: true });
  assert.equal(quietRecovery.builds[0][2].historicalAt, undefined);
  assert.equal(quietRecovery.saved[0][5].createdAt, undefined);
  assert.equal(normal.calls.length, 1);
  assert.equal(normal.saved.length, 1);
  assert.ok(normal.record.state.followupAt, 'human reply schedule independent of anxiety status');
  assert.equal((await scenario({ fresh: false })).record.state.followupAt, undefined, 'inherited status is not fresh intent');
  const followed = await scenario({ source: 'followup' });
  assert.equal(followed.record.state.followupCount, 1);
  assert.equal(followed.record.state.followupAt, undefined, 'tier cap stops next follow-up');
  assert.equal((await scenario({ used: 1 })).record.state.followupAt, undefined, 'ambient contact does not reset unanswered follow-up count');
  const silentFollow = await scenario({ source: 'followup', output: '<proactive-skip/>' });
  assert.equal(silentFollow.record.state.followupAt, undefined);
  assert.ok(normal.calls[0][2].at(-1).content.includes('自主交流机会'));
  assert.equal(normal.calls[0][2].at(-1).role, 'system');
  const silent = await scenario({ output: '<proactive-skip/>' });
  assert.equal(silent.saved.length, 0);
  assert.ok(silent.record.state.fixedAt > 100000000 && silent.record.state.personalityAt > 100000000, 'silence consumes both clocks and plans a future opportunity');
  await silent.advance(60001);
  assert.equal(silent.calls.length, 1, 'silence is not immediately retried by the other clock');
  assert.ok(normal.record.state.handledMessageIds.includes('a'), 'receipt remembers delivered message IDs');
  normal.history.pop();
  await normal.advance(60001);
  assert.equal(normal.calls.length, 1, 'deleting visible reply cannot rewind to the old overdue anchor');
  assert.equal(normal.record.state.followupAt, undefined, 'old reply cannot spawn follow-up after deletion');
  normal.service.schedulePersonalityFollowUp('s');
  assert.equal(normal.record.state.followupAt, undefined);
  const breakfast = { id: 'breakfast', sourceApp: 'story', sourceDetail: 'chat_offline', timestamp: new Date(99500000).toISOString(), content: 'B和用户在群聊线下一起吃完早餐。' };
  const informed = await scenario({ overdue: 120000, crossEvents: [breakfast] });
  assert.equal(informed.builds[0][2].historicalAt, undefined, 'cross-app experience falls back to present, not a replay that drops it');
  assert.ok(informed.calls[0][2].some(m => m.content.includes('一起吃完早餐')));
  const changedEvents = [];
  assert.equal((await scenario({ crossEvents: changedEvents, mutate: () => changedEvents.push(breakfast) })).saved.length, 0, 'new shared experience during generation invalidates stale output');
  const empty = await scenario({ output: '' });
  assert.equal(empty.saved.length, 0);
  assert.equal(empty.record.state.handledAt, undefined, 'empty result is a failure, not a completed opportunity');
  assert.equal((await scenario({ quiet: true })).calls.length, 0);
  assert.equal((await scenario({ foreground: true })).calls.length, 0);
  assert.equal((await scenario({ mutate: ({ session }) => { session.proactiveDisabled = true; } })).saved.length, 0);
  assert.equal((await scenario({ mutate: ({ record }) => { record.state.revision++; } })).saved.length, 0);
  assert.equal((await scenario({ mutate: ({ history }) => history.push({ id: 'new', role: 'user' }) })).saved.length, 0);
  assert.equal((await scenario({ mutate: ({ service }) => service.cancelNewProactive('s') })).saved.length, 0);
  const failed = await scenario({ failure: true });
  assert.equal(failed.calls.length, 1, 'failed calls are not retried every poll');
  assert.ok(failed.record.state.lastError);
  assert.equal(failed.record.state.fixedAt, 100000000 - 1, 'failure preserves original due time');
  assert.equal(failed.record.state.anchorAt, 100000000 - 3600000, 'failure never invents interaction');
  const group = await scenario({ group: true });
  assert.equal(group.calls[0][5].appId, 'group_chat');
  assert.equal(group.saved[0][5].senderCharacterId, 'c');
  assert.equal(group.record.state.followupAt, undefined, 'groups do not follow up based on absent user');
  console.log('Proactive policy, storage and runtime regression tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
