// Isolated IndexedDB integration test. No browser data, device, or model API.
// FLOAT_TEST_DEPS may point to a separate installation of fake-indexeddb.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Dexie = require('dexie');
const { indexedDB, IDBKeyRange } = require(require.resolve('fake-indexeddb', {
  paths: [process.env.FLOAT_TEST_DEPS || process.cwd()],
}));
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
const kv = new Map(), modules = new Map(), events = [];
let failSave = false;
const storage = { length: 0, key: () => null, getItem: () => null };
const mocks = {
  'lib/kv-db.ts': {
    kvGet: key => kv.get(key),
    kvSet: (key, value) => { if (failSave) throw Error('simulated storage failure'); kv.set(key, value); },
    kvEntries: () => [...kv].map(([key, value]) => ({ key, value })),
    registerKvMigration() {}, hydrateKvDb: async () => {}, isKvHydrated: () => true,
  },
  'lib/screenshot/bridge.ts': {},
  'lib/shell-notify.ts': { sendShellNotification() {} },
  'lib/orphan-chat-cleanup.ts': { orphanChatCandidate: () => null },
};
function load(file) {
  if (mocks[file]) return mocks[file];
  if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  const source = fs.readFileSync(file, 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    exports,
    require: name => name === 'dexie' ? Dexie : load(path.posix.normalize(path.posix.join(path.posix.dirname(file), name + '.ts'))),
    Blob, ArrayBuffer, Uint8Array, Map, Set, WeakSet, Date, Math, console, atob, decodeURIComponent,
    indexedDB, IDBKeyRange, setTimeout, clearTimeout,
    localStorage: storage, sessionStorage: storage,
    window: { dispatchEvent: event => events.push(event.type) },
    CustomEvent: class { constructor(type) { this.type = type; } },
  }, { filename: file });
  return exports;
}
const engine = load('lib/screenshot/engine.ts');
const config = load('lib/screenshot/config.ts');
const media = load('lib/media-cache-storage.ts');
const cleanup = load('lib/storage-cleanup.ts');
const captured = { base64: 'iVBORw0KGgo=', width: 1, height: 1 };
const take = () => engine.recordUserShot(captured);
const ids = () => config.loadScreenshotRecords().map(r => r.id).join();

(async () => {
  assert.equal(typeof engine.deleteScreenshotRecord, 'function');
  assert.match(fs.readFileSync('lib/screenshot/index.ts', 'utf8'), /export \* from "\.\/engine"/);
  assert.match(fs.readFileSync('components/screenshot/screenshot-settings.tsx', 'utf8'), /await deleteScreenshotRecord\(id\)/);
  config.saveScreenshotConfig({ ...config.SCREENSHOT_DEFAULTS, keepRecent: 2 });
  kv.set('ai_phone_characters_v1', '[]');
  const chat = new Dexie('AiPhoneChatDB');
  chat.version(1).stores({ messages: 'id, sessionId', sessions: 'id' });
  await chat.open();
  const shared = await take(), unused = await take();
  await chat.table('messages').put({ id: 'image-message', sessionId: 'test', mediaUrl: shared.ref });
  const latest = await take();
  assert.equal(ids(), [latest.id, unused.id].join(), 'retention trims only oldest history');
  assert.ok(await media.loadMediaBlob(shared.ref), 'eviction preserves chat image');
  await engine.deleteScreenshotRecord(unused.id);
  assert.equal(ids(), latest.id, 'single deletion removes exactly selected record');
  assert.ok(await media.loadMediaBlob(unused.ref), 'unreferenced files await safe cleanup');
  const beforeEvents = events.length;
  await engine.deleteScreenshotRecord('missing');
  assert.equal(events.length, beforeEvents, 'unknown ID is a no-op');

  const pending = await take();
  await engine.deleteScreenshotRecord(pending.id);
  assert.ok(await media.loadMediaBlob(pending.ref), 'in-flight share survives deletion before chat write');
  await chat.table('messages').put({ id: 'pending-share', sessionId: 'test', mediaUrl: pending.ref });
  config.saveScreenshotRecords([{ ...shared, id: 'duplicate-one' }, { ...shared, id: 'duplicate-two' }]);
  await engine.deleteScreenshotRecord('duplicate-one');
  assert.equal(ids(), 'duplicate-two', 'shared ref does not delete sibling record');
  assert.ok(await media.loadMediaBlob(shared.ref));
  await engine.clearAllScreenshots();
  assert.equal(ids(), '');
  assert.ok(await media.loadMediaBlob(shared.ref), 'clear-all preserves chat image');
  assert.ok(await media.loadMediaBlob(pending.ref));
  assert.equal(await chat.table('messages').count(), 2, 'history actions never delete messages');

  config.saveScreenshotConfig({ ...config.SCREENSHOT_DEFAULTS, keepRecent: 50 });
  const concurrent = await Promise.all(Array.from({ length: 8 }, take));
  assert.equal(config.loadScreenshotRecords().length, 8, 'concurrent captures do not lose history entries');
  const before = ids();
  failSave = true;
  await assert.rejects(() => engine.deleteScreenshotRecord(concurrent[0].id), /storage failure/);
  await assert.rejects(() => engine.clearAllScreenshots(), /storage failure/);
  failSave = false;
  assert.equal(ids(), before, 'failed history write leaves records unchanged');
  assert.ok(await media.loadMediaBlob(concurrent[0].ref));

  // Exercise the actual cleanup scanner against persisted chat messages and media blobs.
  assert.equal((await cleanup.scanStorageCleanup()).media.length, 0, 'fresh screenshots have a 24-hour grace period');
  const mediaDb = new Dexie('AiPhoneMediaCacheDB');
  mediaDb.version(1).stores({ entries: 'id, createdAt' });
  await mediaDb.open();
  await mediaDb.table('entries').toCollection().modify({ createdAt: Date.now() - 3 * 86400000 });
  const report = await cleanup.scanStorageCleanup();
  assert.equal(report.errors.length, 0);
  assert.equal(report.mediaWarnings.length, 0);
  assert.equal(report.media.map(m => m.id).sort().join(), [unused.ref, latest.ref].map(r => r.slice('media-store://'.length)).sort().join(),
    'only old, unreferenced screenshots qualify; chat and retained history are protected');
  const result = await cleanup.cleanStorageCandidates(report.media);
  assert.equal(result.count, 2, 'unused screenshots remain reclaimable through existing cleanup');
  assert.equal(await media.loadMediaBlob(unused.ref), null);
  assert.equal(await media.loadMediaBlob(latest.ref), null);
  assert.ok(await media.loadMediaBlob(shared.ref), 'shared chat media survives actual cleanup');
  assert.ok(await media.loadMediaBlob(pending.ref));
  for (const record of concurrent) assert.ok(await media.loadMediaBlob(record.ref));
  chat.close(); mediaDb.close();
  console.log('PASS: screenshot exports, single/unknown/duplicate deletion, trim, clear, in-flight shares, concurrent captures, failed saves, actual IndexedDB media preservation and safe orphan reclamation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
