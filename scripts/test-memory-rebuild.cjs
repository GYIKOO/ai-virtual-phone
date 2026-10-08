// Run with fake-indexeddb installed in this repo or FLOAT_TEST_DEPS pointing at an isolated dependency directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const { webcrypto } = require('node:crypto');
const { indexedDB, IDBKeyRange } = require(require.resolve('fake-indexeddb', { paths: [process.env.FLOAT_TEST_DEPS || process.cwd()] }));
const kv = new Map(), heldLocks = new Set(), cache = new Map();
let timeline = [], apiCalls = 0, failApi = false, truncated = false, failEmbedding = false, embeddingCalls = 0, onCall, failWatermark = false;
const api = { id: 'test', provider: 'Custom', baseUrl: 'http://fixture.invalid', apiKey: 'fixture-only', defaultModel: 'fixture' };
const characters = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
const mocks = {
  './kv-db': { kvGet: k => kv.get(k), kvSet: (k, v) => kv.set(k, v), kvSetAsync: async (k, v) => { if (failWatermark) throw Error('simulated watermark failure'); kv.set(k, v); }, registerKvMigration() {}, registerDynamicPrefix() {} },
  './character-storage': { loadCharacters: () => characters },
  './settings-storage': { loadApiConfigs: () => [api], resolveAuxiliaryApiConfig: () => api },
  './short-term-assembler': {
    loadNativeTimeline: () => timeline.map(e => ({ ...e })), filterTimelineByAllowedSources: rows => rows,
  },
  './api-helpers': { simpleLLMCall: async () => { apiCalls++; onCall?.(); return failApi ? { content: null, error: 'fixture failure' } : { content: `summary ${apiCalls}`, wasTruncated: truncated }; } },
  './memory-embedding': { resolveEmbeddingModel: () => 'fixture', generateEmbedding: async () => { embeddingCalls++; return failEmbedding ? null : [1, 2, 3]; } },
};
const navigator = { locks: { request: async (name, _options, work) => {
  if (heldLocks.has(name)) return work(null);
  heldLocks.add(name); try { return await work({ name }); } finally { heldLocks.delete(name); }
} } };
function load(name) {
  if (name in mocks) return mocks[name];
  const filename = `lib/${name.replace('./', '')}.ts`;
  if (cache.has(filename)) return cache.get(filename);
  const exports = {}; cache.set(filename, exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: load, indexedDB, IDBKeyRange, DOMException, crypto: webcrypto, TextEncoder, Date, console, navigator,
      window: { dispatchEvent() {} }, Event: class {}, setTimeout, clearTimeout, AbortController }, { filename });
  return exports;
}
const storage = load('./memory-storage'), store = load('./memory-rebuild-store'), policy = load('./memory-rebuild-policy');
let service = load('./memory-rebuild');
const tokens = load('./token-counter');
const options = { batchSize: 3, inputTokens: 1024, includeCore: false };
const auto = { id: 'auto', characterId: 'a', type: 'long_term', sourceApp: 'chat', content: 'old automatic', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const manual = { ...auto, id: 'manual', content: 'user authored', metadata: { origin: 'user_manual' } };
const core = { ...auto, id: 'core', type: 'core', content: 'old core' };
const other = { ...auto, id: 'other', characterId: 'b', content: 'other character' };
const makeTimeline = () => Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, timestamp: `2026-01-0${i + 1}T12:00:00.000Z`, content: `event ${i}`, sourceApp: 'chat', sessionId: 'a-chat' }));
async function start(opts = options) {
  const preview = await service.previewMemoryRebuild('a', opts);
  await service.createMemoryRebuild('a', opts, preview.hash);
  return store.readRebuildJob('a');
}
async function discard() { const job = await store.readRebuildJob('a'); if (job) await service.discardMemoryRebuild('a', job.id); }
(async () => {
  // Pure planner: no dropping tails, identical timestamps, Unicode and oversized input.
  const sources = makeTimeline().map(e => ({ key: e.id, ...e }));
  assert.equal(policy.planRebuildBatches(sources, 3, 1024, '{{events}}', 'A').map(b => b.length).join(), '3,3,1');
  const huge = { ...sources[0], content: '长剧情🙂\n'.repeat(4000) };
  const split = policy.planRebuildBatches([huge], 3, 1024, '{{events}}', 'A');
  assert.ok(split.length > 1);
  assert.equal(split.flat().map(s => s.content).join(''), huge.content, 'long records split without truncation');
  for (const chunk of split) assert.ok(tokens.estimateTokens(policy.rebuildPrompt('{{events}}', 'A', chunk)) + 8 <= 1024);
  assert.throws(() => policy.planRebuildBatches(sources, 0, 1024, '{{events}}', 'A'));
  assert.equal(policy.planRebuildBatches(sources.map(e => ({ ...e, timestamp: sources[0].timestamp })), 3, 1024, '{{events}}', 'A').flat().length, 7);
  assert.ok(policy.rebuildPrompt('{{char}} {{events}}', '$&', sources).startsWith('$&'));
  assert.equal(policy.protectedMemory({ ...auto, id: 'mem_lt_manual_legacy' }), true, 'legacy manual IDs remain protected without metadata');
  storage.saveMemoryConfig({ ...load('./memory-types').DEFAULT_MEMORY_CONFIG, vectorRecallEnabled: false, summarizationEventInterval: 80, coreSummarizationInterval: 2 });
  for (const row of [auto, manual, core, other]) await storage.saveMemoryEntry(row);
  storage.setLastSummarizedTimestamp('a', '2026-01-02T00:00:00Z');
  storage.setLastCoreSummarizedTimestamp('a', '2026-01-01T00:00:00Z');
  timeline = makeTimeline();
  storage.saveMemoryConfig({ ...storage.loadMemoryConfig(), maxLongTermEntries: 4 });
  await assert.rejects(() => service.previewMemoryRebuild('a', options), /超过现有数量上限/, 'preflight includes unchanged core and manual entries');
  storage.saveMemoryConfig({ ...storage.loadMemoryConfig(), maxLongTermEntries: 500 });
  const original = policy.memorySnapshot(await storage.loadMemoryEntries('a'));
  let job = await start();
  assert.equal(apiCalls, 0, 'creation and preview never call paid API');
  assert.equal(storage.loadMemoryConfig().summarizationEventInterval, 80, 'batch size never alters daily interval');
  assert.equal(policy.memorySnapshot(await storage.loadMemoryEntries('a')), original);
  await assert.rejects(() => load('./memory-writer-lock').assertNoMemoryRebuild('a'), /重建/);
  await load('./memory-writer-lock').assertNoMemoryRebuild('b');
  onCall = () => service.pauseMemoryRebuild('a');
  await service.runMemoryRebuild('a');
  assert.equal((await store.readRebuildJob('a')).completed, 1);
  assert.equal((await store.readRebuildJob('a')).status, 'paused');
  assert.equal(policy.memorySnapshot(await storage.loadMemoryEntries('a')), original, 'staged summaries never enter active memory');
  onCall = undefined;
  // Simulate runtime restart; persisted progress is the source of truth.
  cache.delete('lib/memory-rebuild.ts'); service = load('./memory-rebuild');
  await service.runMemoryRebuild('a');
  job = await store.readRebuildJob('a');
  assert.equal(job.status, 'ready'); assert.equal(apiCalls, 3, 'resume does not redo completed calls');
  timeline.push({ ...timeline[0], id: 'new-after-cutoff', timestamp: '2026-02-01T12:00:00.000Z' });
  storage.incrementEventCounter('a');
  failWatermark = true;
  await assert.rejects(() => service.applyMemoryRebuild('a', job.id), /watermark failure/);
  assert.equal((await store.readRebuildJob('a')).status, 'applied', 'memory swap already committed atomically');
  assert.ok((await store.readRebuildJob('a')).progressPending, 'durable recovery marker retained');
  failWatermark = false;
  await store.reconcileRebuildProgress('a');
  const active = await storage.loadMemoryEntries('a');
  assert.equal(active.filter(e => e.type === 'long_term').length, 4);
  assert.ok(active.some(e => e.id === 'manual') && active.some(e => e.id === 'core'));
  assert.equal((await storage.loadMemoryEntries('b'))[0].content, other.content);
  assert.equal(storage.getEventCounter('a'), 1, 'new event counters never reset on activation');
  assert.equal(storage.getLastSummarizedTimestamp('a'), '2026-01-07T12:00:00.000Z');
  await service.rollbackMemoryRebuild('a', job.id);
  assert.equal(policy.memorySnapshot(await storage.loadMemoryEntries('a')), original);
  assert.equal(storage.getLastSummarizedTimestamp('a'), '2026-01-02T00:00:00Z');
  await discard(); timeline = makeTimeline();

  // Core rebuilding is explicit, staged and uses original source dates.
  job = await start({ ...options, includeCore: true });
  await service.runMemoryRebuild('a');
  job = await store.readRebuildJob('a');
  assert.equal(job.totalBatches, 5);
  const coreBatches = (await store.readRebuildBatches(job.id)).filter(b => b.type === 'core');
  assert.equal(coreBatches[0].result.metadata.eventStartAt, timeline[0].timestamp);
  await service.applyMemoryRebuild('a', job.id);
  assert.equal((await storage.loadMemoryEntries('a')).filter(e => e.type === 'core').length, 2);
  await storage.saveMemoryEntry({ ...manual, content: 'edited after activation', updatedAt: '2026-10-09T00:00:00Z' });
  await assert.rejects(() => service.rollbackMemoryRebuild('a', job.id), /新增、删除或修改/);
  await discard();
  assert.equal((await storage.loadMemoryEntries('a')).find(e => e.id === 'manual').content, 'edited after activation', 'discard never deletes active data');

  // API failures/truncation must not advance or create a visible memory.
  job = await start(); failApi = true;
  const beforeFailure = policy.memorySnapshot(await storage.loadMemoryEntries('a'));
  await service.runMemoryRebuild('a');
  assert.equal((await store.readRebuildJob('a')).completed, 0);
  failApi = false; truncated = true;
  await service.runMemoryRebuild('a');
  assert.equal((await store.readRebuildJob('a')).completed, 0);
  truncated = false;
  await service.runMemoryRebuild('a');
  assert.equal(policy.memorySnapshot(await storage.loadMemoryEntries('a')), beforeFailure);
  timeline[0].content = 'edited source';
  await assert.rejects(() => service.applyMemoryRebuild('a', job.id), /历史记录已被编辑/);
  await discard(); timeline = makeTimeline();

  // Failed checkpoint writes recover the durable state, not in-memory increments.
  job = await start();
  const write = store.writeRebuildJob;
  let failOnce = true;
  store.writeRebuildJob = async (j, batches) => {
    if (failOnce && j.completed === 1 && batches?.length) { failOnce = false; throw Error('simulated quota failure'); }
    return write(j, batches);
  };
  const beforeQuota = apiCalls;
  await service.runMemoryRebuild('a');
  assert.equal((await store.readRebuildJob('a')).completed, 0);
  store.writeRebuildJob = write;
  await service.runMemoryRebuild('a');
  assert.equal(apiCalls - beforeQuota, 3, 'saved text reused after checkpoint failure');
  await storage.saveMemoryEntry({ ...auto, id: 'new-auto-during-task' });
  const beforeConflict = policy.memorySnapshot(await storage.loadMemoryEntries('a'));
  await assert.rejects(() => service.applyMemoryRebuild('a', job.id), /新增、删除或修改/);
  assert.equal(policy.memorySnapshot(await storage.loadMemoryEntries('a')), beforeConflict);
  await discard();

  // Embedding failure resumes only embedding, not an already paid text call.
  storage.saveMemoryConfig({ ...storage.loadMemoryConfig(), vectorRecallEnabled: true });
  job = await start(); failEmbedding = true;
  const beforeEmbedding = apiCalls;
  await service.runMemoryRebuild('a');
  assert.equal((await store.readRebuildJob('a')).completed, 0);
  assert.ok((await store.readRebuildBatches(job.id))[0].result);
  failEmbedding = false; await service.runMemoryRebuild('a');
  assert.equal(apiCalls - beforeEmbedding, 3);
  assert.ok(embeddingCalls >= 4);
  await discard();

  // Inter-tab locking prevents duplicated runs. Legacy manual controls remain separate.
  heldLocks.add('float-memory-writer:a');
  await assert.rejects(() => service.runMemoryRebuild('a'), /正在运行/);
  heldLocks.clear();
  // Restoring an older schema at a higher version still upgrades the new stores.
  await new Promise((resolve, reject) => { const req = indexedDB.deleteDatabase('ai_phone_memory_db_v1'); req.onsuccess = resolve; req.onerror = reject; });
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('ai_phone_memory_db_v1', 20);
    req.onupgradeneeded = () => req.result.createObjectStore('memories', { keyPath: 'id' });
    req.onsuccess = () => { req.result.close(); resolve(); }; req.onerror = reject;
  });
  const restored = await storage.openMemoryRebuildDb();
  assert.ok(restored.version > 20 && restored.objectStoreNames.contains('rebuild_jobs') && restored.objectStoreNames.contains('rebuild_batches'));
  restored.close();
  const ui = fs.readFileSync('components/memory/memory-bank-page.tsx', 'utf8');
  assert.ok(ui.includes('接着上次总结') && ui.includes('handleManualSummarize') && ui.includes('characterId={selectedCharId}'));
  const panel = fs.readFileSync('components/memory/memory-rebuild-panel.tsx', 'utf8');
  assert.ok(panel.includes('setConfirm("start")') && panel.includes('setConfirm("apply")') && panel.includes('ConfirmDialog'));
  console.log('PASS: scoped rebuild, batching/tails/large records, no API before confirmation, checkpoint/restart, text/embedding failures, core ranges, conflict protection, atomic activation/rollback, manual-memory preservation and unchanged legacy entry.');
})().catch(error => { console.error(error); process.exitCode = 1; });
