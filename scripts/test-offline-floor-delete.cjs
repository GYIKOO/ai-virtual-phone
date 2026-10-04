const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const cache = new Map();
function load(file, deps = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports, require: name => deps[name] || {} });
  return exports;
}
const storage = load('lib/chat-offline-storage.ts', {
  './kv-db': { kvGet: key => cache.get(key), kvSet: (key, value) => cache.set(key, value), registerDynamicPrefix() {} },
  './chat-storage': { loadChatSessions: () => [{ id: 's', contactId: 'c' }] },
  './llm-prompt-assembler': { formatChatTimestamp: text => text },
});
const prompt = load('lib/offline-prompt-builder.ts');
const make = id => ({ id, sessionId: 's', userContent: 'user ' + id, assistantContent: 'reply ' + id, rawText: '<content>reply</content>', summary: 'event', summaryTag: 'summary', reasoningText: 'reason', thinkingText: 'think', createdAt: `2026-10-04T00:00:0${id}Z` });
function reset() { storage.saveChatOfflineTurns('s', ['1', '2', '3'].map(make)); storage.saveChatOfflineTurns('other', [{ ...make('1'), sessionId: 'other' }]); }
reset();
let rows = storage.deleteChatOfflineTurn('s', '2', 'assistant');
assert.equal(rows.length, 3);
assert.equal(rows[1].userContent, 'user 2');
assert.equal(rows[1].assistantContent, '');
assert.equal(rows[1].summary, '');
assert.equal(rows[1].rawText, undefined);
assert.equal(rows[1].thinkingText, undefined);
assert.equal(rows[1].reasoningText, undefined);
assert.equal(storage.loadChatOfflineTurns('s')[1].userContent, 'user 2');
assert.equal(storage.loadChatOfflineTurns('other')[0].assistantContent, 'reply 1');
assert.equal(prompt.buildOfflinePromptHistory({ id: 's' }, rows, '').filter(m => m.id === '2_assistant').length, 0);
assert.equal(storage.loadChatOfflineProjectionEntries('c').length, 2);
rows = storage.deleteChatOfflineTurn('s', '2', 'user');
assert.equal(rows.length, 2);
reset();
rows = storage.deleteChatOfflineTurn('s', '2', 'user');
assert.equal(rows[1].userContent, '');
assert.equal(rows[1].assistantContent, 'reply 2');
reset();
rows = storage.deleteChatOfflineTurnsFrom('s', '2', 'assistant');
assert.equal(rows.length, 2);
assert.equal(rows[1].userContent, 'user 2');
assert.equal(rows[1].assistantContent, '');
reset();
assert.equal(storage.deleteChatOfflineTurnsFrom('s', '2', 'user').length, 1);
reset();
assert.equal(storage.deleteChatOfflineTurn('s', 'missing', 'assistant').length, 3);
assert.equal(storage.deleteChatOfflineTurnsFrom('s', 'missing', 'assistant').length, 3);
assert.equal(storage.deleteChatOfflineTurn('s', '2').length, 2);
console.log('PASS: per-floor deletion, suffix boundaries, persistence, history/projection cleanup, other-session isolation and legacy whole-turn deletion');
