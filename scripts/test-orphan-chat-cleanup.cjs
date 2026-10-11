// Real cursor scan on fake-indexeddb; deletion uses mock in-memory chat services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { indexedDB, IDBKeyRange } = require(require.resolve('fake-indexeddb', { paths: [process.env.FLOAT_TEST_DEPS || process.cwd()] }));
const Dexie = require('dexie');
Dexie.dependencies.indexedDB = indexedDB; Dexie.dependencies.IDBKeyRange = IDBKeyRange;
const chatDb = new Dexie('AiPhoneChatDB');
chatDb.version(1).stores({ sessions: 'id', messages: 'id,sessionId' });
const mediaDb = new Dexie('AiPhoneMediaCacheDB'); mediaDb.version(1).stores({ entries: 'id' });
const kv = new Map();
let sessions = [], messages = [], removed = [], hydrated = true;
const deps = {
  './kv-db': { hydrateKvDb: async () => {}, isKvHydrated: () => true, kvEntries: () => [...kv].map(([key, value]) => ({ key, value })), kvGet: key => kv.get(key) },
  './media-cache-storage': { listMediaCacheSummaries: async () => [{ id: 'mc_123_orphan', bytes: 100, category: 'image', createdAt: 1000 }], MEDIA_STORE_PROTOCOL: 'media-store://', deleteMediaRef: () => { throw new Error('must not delete shared media'); } },
  './chat-storage': { hydrateChatStorage: async () => {}, isChatStorageHydrated: () => hydrated, loadChatSessions: () => sessions, loadChatMessages: id => messages.filter(m => m.sessionId === id) },
  './chat-db': { chatDb },
  './chat-session-remove': { removeChatSessionCompletely: id => {
    removed.push(id); sessions = sessions.filter(s => s.id !== id); messages = messages.filter(m => m.sessionId !== id);
    chatDb.sessions.delete(id); chatDb.messages.where('sessionId').equals(id).delete(); kv.delete(`ai_phone_chat_offline_turns:${id}`);
  } },
};
function load(file) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: name => deps[name], Blob, ArrayBuffer, Map, Set, WeakSet, Date, setTimeout, atob, decodeURIComponent, indexedDB,
      localStorage: { length: 0 }, sessionStorage: { length: 0 } });
  return exports;
}
const orphan = load('lib/orphan-chat-cleanup.ts'); deps['./orphan-chat-cleanup'] = orphan;
const scan = load('lib/storage-cleanup.ts').scanStorageCleanup;
const cards = ids => kv.set('ai_phone_characters_v1', JSON.stringify(ids.map(id => ({ id }))));
const session = (id, contactId, extra = {}) => ({ id, contactId, updatedAt: '2026-10-11T12:00:00Z', ...extra });
(async () => {
  await chatDb.open(); await mediaDb.open(); cards(['live']);
  sessions = [session('orphan', 'deleted'), session('live', 'live'), session('group', 'group_synthetic', { isGroup: true }), session('self', 'self')];
  messages = [{ id: 'm1', sessionId: 'orphan' }];
  await chatDb.sessions.bulkPut(sessions); await chatDb.messages.bulkPut(messages);
  kv.set('ai_phone_chat_offline_turns:orphan', JSON.stringify([{ id: 'offline1' }]));
  await mediaDb.entries.put({ id: 'pdf', mimeType: 'application/pdf', mediaCategory: 'file', blob: new Blob(['opaque']) });
  const report = await scan();
  assert.equal(report.media.length, 0); assert.equal(report.mediaWarnings.length, 1); assert.equal(report.errors.length, 0);
  assert.equal(report.orphanChats.length, 1, 'opaque files do not block private chat cleanup');
  assert.equal(report.orphanChats[0].id, 'orphan'); assert.equal(report.orphanChats[0].offlineCount, 1);
  cards(['live', 'deleted']); assert.equal((await orphan.cleanOrphanChats(report.orphanChats)).count, 0);
  cards(['live']); sessions[0] = { ...sessions[0], contactId: 'live' };
  assert.equal((await orphan.cleanOrphanChats(report.orphanChats)).count, 0, 'rebound chat is protected');
  sessions[0] = session('orphan', 'deleted'); messages.push({ id: 'new', sessionId: 'orphan' });
  assert.equal((await orphan.cleanOrphanChats(report.orphanChats)).count, 0, 'changed live history is protected');
  messages.pop(); await chatDb.messages.put({ id: 'new-on-disk', sessionId: 'orphan' });
  assert.equal((await orphan.cleanOrphanChats(report.orphanChats)).count, 0, 'changed disk history is protected');
  await chatDb.messages.delete('new-on-disk'); hydrated = false;
  await assert.rejects(() => orphan.cleanOrphanChats(report.orphanChats)); hydrated = true;
  assert.equal((await orphan.cleanOrphanChats(report.orphanChats)).count, 1);
  assert.deepEqual(removed, ['orphan']); assert.ok(await chatDb.sessions.get('live')); assert.ok(await chatDb.sessions.get('group'));
  assert.equal(await chatDb.messages.count(), 0); assert.equal(kv.has('ai_phone_chat_offline_turns:orphan'), false);
  await mediaDb.entries.delete('pdf');
  await mediaDb.entries.put({ id: 'html', mimeType: 'text/html', mediaCategory: 'file', blob: new Blob(['media-store://mc_123_orphan']) });
  const blobReport = await scan(); assert.equal(blobReport.media.length, 0); assert.equal(blobReport.mediaWarnings.length, 0, 'text blobs can be read safely');
  await mediaDb.entries.delete('html'); assert.equal((await scan()).media.length, 1);
  kv.delete('ai_phone_characters_v1'); assert.equal((await scan()).chatErrors.length, 1);
  console.log('PASS: orphan private chats independent of media warnings; selected deletion; restored cards, rebindings, live/disk updates, groups/self and hydration protected; text blobs inspected');
})().catch(error => { console.error(error); process.exitCode = 1; });
