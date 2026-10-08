const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, deps = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, Date, require: key => { if (!(key in deps)) throw Error(key); return deps[key]; } });
  return exports;
}
const t = load('lib/memory-time.ts');
const now = Date.parse('2026-10-07T12:00:00Z');
const entry = { id: 'e', type: 'long_term', content: '昨天去了公园。', createdAt: '2026-10-07T10:00:00Z', updatedAt: '2026-10-07T10:00:00Z', metadata: { timeSpan: '2026-10-02T12:00:00Z ~ 2026-10-03T12:00:00Z' } };
assert.ok(t.formatMemoryEntry(entry, now).includes('5天0小时前'));
assert.ok(t.formatMemoryEntry(entry, now).includes('4天0小时前'));
assert.ok(t.formatMemoryEntry(entry, now).endsWith(entry.content), 'never rewrite user memory content');
assert.ok(t.formatMemoryEntry(entry, Date.parse('2026-10-04T12:00:00Z')).includes('1天0小时前'), 'replay age is relative to scheduled scene time');
assert.equal(t.memoryEventRange({ ...entry, type: 'core' }), undefined, 'legacy core span is NOT an event span');
assert.ok(t.formatMemoryEntry({ ...entry, type: 'core' }, now).includes('非事件时间'));
assert.equal(t.memoryEventRange({ ...entry, metadata: { timeSpan: 'invalid ~ invalid' } }), undefined);
const dated = { ...entry, metadata: { eventStartAt: '2026-10-02T05:00:00-07:00', eventEndAt: '2026-10-03T12:00:00Z' } };
assert.equal(t.memoryEventRange(dated).start, Date.parse('2026-10-02T12:00:00Z'));
assert.equal(t.memoryEventRange({ ...dated, type: 'core' }).end, Date.parse('2026-10-03T12:00:00Z'));
let enabled = true;
const injector = load('lib/memory-injector.ts', { './memory-time': t, './prompt-time': { resolvePromptTimeAware: () => enabled } });
assert.ok(injector.formatLongTermMemories([entry], now).includes('来源事件时间范围'));
enabled = false;
assert.equal(injector.formatLongTermMemories([entry], now), `- ${entry.content}`, 'time-awareness opt-out preserved');
(async () => {
  const recent = { ...entry, id: 'recent', createdAt: '2026-10-06T12:00:00Z', metadata: { timeSpan: '2026-10-05T12:00:00Z ~ 2026-10-06T12:00:00Z' } };
  const service = load('lib/memory-service.ts', {
    './memory-time': t, './proactive-replay': load('lib/proactive-replay.ts'),
    './memory-storage': { loadMemoryEntriesByType: async () => [entry, recent] },
    './settings-storage': { resolveAuxiliaryApiConfig: () => null }, './memory-embedding': {},
    './token-counter': { estimateTokens: text => text.length },
  });
  const config = { longTermTokenBudget: t.formatMemoryEntry(recent).length + 8, vectorRecallEnabled: false };
  const result = await service.retrieveMemoriesForPrompt('c', 'context', config);
  assert.equal(result.length, 1, 'metadata cost included in token budget');
  assert.equal(result[0].id, 'recent', 'event recency wins over late summary creation');
  let stored, watermark, prompt;
  const builder = load('lib/core-memory-builder.ts', {
    './memory-time': t, './memory-injector': { formatLongTermMemories: entries => entries.map(e => t.formatMemoryEntry(e, now)).join('\n') },
    './memory-types': { DEFAULT_CORE_MEMORY_PROMPT: '{{earliest}} / {{latest}} / {{events}}' },
    './memory-storage': {
      loadMemoryConfig: () => ({}), loadMemoryEntriesByType: async () => [entry, recent],
      getLastCoreSummarizedTimestamp: () => undefined, resetCoreMemoryCounter() {},
      saveMemoryEntry: async e => { stored = e; }, setLastCoreSummarizedTimestamp: (_id, at) => { watermark = at; },
    },
    './settings-storage': { resolveAuxiliaryApiConfig: () => ({}) },
    './api-helpers': { simpleLLMCall: async (_config, messages) => { prompt = messages[0].content; return { content: '保留事件事实' }; } },
  });
  assert.equal((await builder.runCoreMemoryPipeline('c', 'C')).success, true);
  assert.equal(stored.metadata.eventStartAt, '2026-10-02T12:00:00.000Z');
  assert.equal(stored.metadata.eventEndAt, '2026-10-06T12:00:00.000Z');
  assert.equal(watermark, entry.createdAt, 'summary creation watermark remains independent from event time');
  assert.ok(prompt.startsWith('2026-10-02T12:00:00.000Z / 2026-10-06T12:00:00.000Z'), 'core prompt uses underlying event dates');
  console.log('PASS: original event spans, elapsed ages, legacy unknown dates, replay time, timezone offsets, opt-out and retrieval budget.');
})().catch(e => { console.error(e); process.exitCode = 1; });
