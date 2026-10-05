const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const now = Date.now();
const old = now - 3 * 86400000;
const item = (suffix, extra = {}) => ({ id: `mc_123_${suffix}`, bytes: 100, category: 'image', createdAt: old, ...extra });
let entries = [], summaries = [], deleted = [], failures = false, hydrated = true;
const exportsObject = {};
const storage = { length: 0, key: () => null, getItem: () => null };
const deps = {
  './kv-db': { hydrateKvDb: async () => {}, isKvHydrated: () => hydrated, kvEntries: () => entries },
  './media-cache-storage': { MEDIA_STORE_PROTOCOL: 'media-store://', listMediaCacheSummaries: async () => summaries,
    deleteMediaRef: async ref => { deleted.push(ref); } },
};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/storage-cleanup.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, { exports: exportsObject, require: n => deps[n], Blob, ArrayBuffer, Map, Set, WeakSet, Date, setTimeout,
  localStorage: storage, sessionStorage: storage,
  indexedDB: { databases: async () => failures ? [{ name: 'broken' }] : [{ name: 'AiPhoneMediaCacheDB' }], open: () => { const request = { result: { objectStoreNames: [], close() {} } }; setTimeout(() => failures ? request.onerror() : request.onsuccess(), 0); return request; } },
});
const { collectMediaReferences, cleanupCandidates, scanStorageCleanup, cleanStorageCandidates } = exportsObject;
(async () => {
  const refs = new Set();
  const cyclic = { url: 'media-store://mc_123_shared', html: '<img src="media-store://mc_123_html">', nestedJson: '{"image":"mc_123_json"}', mc_123_key: true };
  cyclic.self = cyclic;
  collectMediaReferences(cyclic, refs);
  collectMediaReferences(new Map([['mc_123_map', new Set(['mc_123_set'])]]), refs);
  for (const suffix of ['shared', 'html', 'json', 'key', 'map', 'set']) assert.ok(refs.has(`mc_123_${suffix}`));
  collectMediaReferences('data:text/html;base64,bWNfMTIzX3NoYXJlZA==', refs);
  assert.ok(refs.has('__opaque_document__'), 'opaque embedded documents require blocking cleanup');
  const rows = [item('shared'), item('orphan'), item('voice', { category: 'audio' }), item('new', { createdAt: now }), item('unknown', { category: 'file' }), item('bad', { createdAt: NaN })];
  assert.equal(cleanupCandidates(rows, refs, now).map(x => x.id).join(), 'mc_123_orphan,mc_123_voice');
  summaries = [item('orphan')];
  const first = await scanStorageCleanup();
  assert.equal(deleted.length, 0, 'scanning never deletes');
  entries = [{ key: 'plugin-draft', value: JSON.stringify({ image: 'media-store://mc_123_orphan' }) }];
  const skipped = await cleanStorageCandidates(first.media);
  assert.equal(skipped.count, 0, 'new cross-app reference protects selected asset');
  assert.equal(deleted.length, 0);
  entries = [{ key: 'embedded', value: 'data:text/html;base64,bWNfMTIzX3NoYXJlZA==' }];
  assert.equal((await scanStorageCleanup()).media.length, 0, 'uninspectable documents protect all media');
  await assert.rejects(() => cleanStorageCandidates(first.media));
  entries = []; failures = true;
  const incomplete = await scanStorageCleanup();
  assert.equal(incomplete.media.length, 0);
  assert.equal(incomplete.errors.length, 1);
  await assert.rejects(() => cleanStorageCandidates(first.media));
  assert.equal(deleted.length, 0, 'read failures fail closed');
  failures = false;
  summaries = [item('orphan', { bytes: 101 })];
  assert.equal((await cleanStorageCandidates(first.media)).count, 0, 'modified candidate is skipped');
  summaries = [item('orphan'), item('unselected')];
  const result = await cleanStorageCandidates(first.media);
  assert.equal(result.count, 1);
  assert.equal(result.bytes, 100);
  assert.deepEqual(deleted, ['media-store://mc_123_orphan']);
  hydrated = false;
  await assert.rejects(() => scanStorageCleanup());
  console.log('PASS: shared/nested references, 24h protection, unknown formats, scan-only mode, fresh recheck, read failures and exact selections.');
})().catch(e => { console.error(e); process.exitCode = 1; });
