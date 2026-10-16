// Offline merge contracts: real scope normalization and follow-up scheduling.
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
function load(file, deps, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: id => deps[id] || {}, console, ...globals });
  return exports;
}
const kv = new Map();
const window = { dispatchEvent() {} };
const storage = { kvGet: k => kv.get(k), kvSet: (k,v) => kv.set(k,v), registerKvMigration() {} };
const identities = [{ id: 'u1', name: 'one' }, { id: 'u2', name: 'two' }];
const settings = { loadUserIdentities: () => identities, loadBindingConfig: () => ({}),
  resolveBinding: (_config, id) => ({ userIdentityId: id === 'b' ? 'u2' : 'u1' }),
  resolveUserIdentity: () => identities[0] };
const alt = load('lib/chat-alt-account-storage.ts', { './kv-db': storage, './settings-storage': settings }, { window });
kv.set('ai_phone_chat_alt_accounts_v1', JSON.stringify([{ id: 'alt', userIdentityId: 'u2', nickname: 'saved account' }]));
const savedAlt = kv.get('ai_phone_chat_alt_accounts_v1');
const scope = load('lib/chat-scope-storage.ts', { './kv-db': storage, './settings-storage': settings,
  './chat-alt-account-storage': alt, './character-world-storage': {
    loadCharacterWorldGroups: () => [{ id: 'w1' }, { id: 'w2' }], getCharacterWorldGroupId: id => id === 'b' ? 'w2' : 'w1',
  } }, { window, CustomEvent: class {} });
const selection = scope.saveChatScope({ userIdentityId: 'u1', worldId: 'w1', chatAccountId: 'alt' });
assert.equal(selection.chatAccountId, null);
assert.equal(selection.userIdentityId, 'u1');
assert.equal(selection.worldId, 'w1');
assert.equal(scope.characterMatchesChatScope('a'), true);
assert.equal(scope.characterMatchesChatScope('b'), false);
assert.equal(scope.sessionMatchesChatScope({ chatAccountId: 'alt' }), false);
assert.throws(() => alt.createChatAltAccount({ userIdentityId: 'u1', nickname: 'new' }), /暂未开放/);
assert.equal(kv.get('ai_phone_chat_alt_accounts_v1'), savedAlt, 'existing small-account data is not deleted');
const ui = fs.readFileSync('components/chat/chat-scope-switcher.tsx','utf8');
assert.match(ui, /CHAT_ALT_ACCOUNTS_ENABLED && <ScopeMenuRow/);
assert.match(ui, /label="选择世界观"/);
assert.ok(!fs.readFileSync('lib/group-chat-engine.ts','utf8').includes('resolveChatScopeUserIdentity'), 'background group generation is not affected by current UI filters');
assert.ok(!fs.readFileSync('lib/moments-engine.ts','utf8').includes('resolveChatScopeUserIdentity'), 'background moments retain character binding');
assert.ok(!fs.readFileSync('lib/image-generation-service.ts','utf8').includes('loadChatScope'), 'image reference identity does not change with list filters');
assert.ok(!fs.readFileSync('components/chat/global-chat-info-settings.tsx','utf8').includes('clearChatOfflineTurns'), 'entry preference never deletes offline history');
const storySettings = fs.readFileSync('components/story/story-settings-page.tsx', 'utf8');
assert.ok(!storySettings.includes('window.prompt('), 'settings naming works in embedded browsers');
assert.ok(storySettings.includes('<ContentDialog title="设置预设名称"'));
assert.ok(storySettings.includes('value={settingsPresetNameDraft}'), 'blank names remain an editable draft');

const now = Date.now();
const session = { id: 's', contactId: 'a' };
const message = { id:'reply', role:'assistant', createdAt: new Date(now).toISOString(), freshStateValues:[{ name:'跟进意愿', value:90 }] };
let record = { config:{ enabled:true, groupFollowUpEnabled:true, followUpTier:2 }, state:{ clockVersion:2, anchor:`reply:${message.createdAt}`, anchorAt:now, followupCount:0, followupAt:now+1000 } };
let rules = { disableAllCharacters:true, allowCharacterIds:[], followUpFieldName:'跟进意愿' };
const service = load('lib/proactive-service.ts', {
  './chat-storage': { loadChatSessions:()=>[session], loadChatMessages:()=>[message] },
  './settings-storage': { loadFollowUpConfig:()=>rules },
  './proactive-storage': { loadProactive:()=>record, saveProactiveState:(_id,state)=>{record={...record,state};return true;} },
  './proactive-clock': { changeQuiet:state=>state, releaseQuiet:state=>state },
  './push-client': { loadPushQuietHours:()=>({}) },
  './proactive-followup': { followUpDelay:()=>60, groupFollowUpDelay:()=>60, groupFollowUpValue:()=>90 },
}, { Date });
service.schedulePersonalityFollowUp('s');
assert.equal(record.state.followupAt, undefined, 'global disable clears pending personality follow-up');
rules = { ...rules, allowCharacterIds:['a'] };
service.schedulePersonalityFollowUp('s');
assert.equal(record.state.followupAt, now+60000, 'explicit exception schedules normally');
rules = { ...rules, allowCharacterIds:[] };
session.isGroup=true;
service.schedulePersonalityFollowUp('s');
assert.equal(record.state.followupAt, now+60000, 'group follow-up remains independent');
console.log('PASS: hidden alt entry, retained data/identity/world filtering, session-bound background identity, nondestructive offline toggle, follow-up disable/exceptions/group independence.');
