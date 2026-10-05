const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
let sessions = [{ id: 'a', proactiveDisabled: true }, { id: 'b', proactiveDisabled: false }];
const records = new Map([['a', { config: { enabled: false, intervalMinutes: 777, followUpTier: 3 } }]]);
const cancelled = [];
const exportsObject = {};
const dependencies = {
  './chat-storage': { loadChatSessions: () => sessions, saveChatSessions: rows => { sessions = rows; } },
  './proactive-policy': { defaultProactiveConfig: () => ({ enabled: false, intervalMinutes: 480 }) },
  './proactive-storage': { loadProactive: id => records.get(id), saveProactiveConfig: (id, config) => records.set(id, { config }) },
  './follow-up-service': { cancelProactiveForSession: id => cancelled.push(id) },
};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/proactive-controls.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
  { exports: exportsObject, require: name => dependencies[name] });
exportsObject.setSessionProactiveEnabled('a', true);
assert.equal(sessions[0].proactiveDisabled, false);
assert.equal(records.get('a').config.enabled, true);
assert.equal(records.get('a').config.intervalMinutes, 777);
exportsObject.setSessionProactiveEnabled('a', false);
assert.equal(sessions[0].proactiveDisabled, true);
assert.equal(records.get('a').config.enabled, false);
assert.deepEqual(cancelled, ['a']);
assert.equal(sessions[1].proactiveDisabled, false, 'other sessions unchanged');
exportsObject.setSessionProactiveEnabled('b', true);
assert.equal(records.get('b').config.enabled, true, 'explicit migration enables new scheduler');
assert.throws(() => exportsObject.setSessionProactiveEnabled('deleted', true));
const profile = fs.readFileSync('components/chat/user-profile-panel.tsx', 'utf8');
const chat = fs.readFileSync('components/chat/chat-settings-panel.tsx', 'utf8');
assert.ok(profile.includes('<ProactiveManager'));
assert.ok(!chat.includes('ProactiveSettings') && !chat.includes('setProactiveAllowed'), 'no duplicate per-chat controls');
console.log('PASS: central switch, migration, cancellation, settings preservation and entry relocation');
