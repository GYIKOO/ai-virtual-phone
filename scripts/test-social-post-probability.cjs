// Offline regression: real storage and engine functions, fake model transport and KV.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
function load(file, deps = {}, globals = {}) {
  const exports = {};
  const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0, file);
  vm.runInNewContext(result.outputText, { exports, require: name => deps[name] || {}, console, ...globals });
  return exports;
}
const social = load('lib/social-post-probability.ts');
const kv = new Map();
const kvMock = { kvGet: key => kv.get(key), kvSet: (key, value) => kv.set(key, value), registerKvMigration() {} };
const moments = load('lib/moments-storage.ts', { './kv-db': kvMock, './social-post-probability': social }, { window: {} });
let config = moments.loadMomentsConfig();
for (const app of ['moments', 'xiaohongshu']) assert.equal(social.getSocialPostProbability('a', app, config), .5);
config = { ...config, ...social.setSocialPostProbability('a', 'moments', .2, config) };
assert.equal(social.getSocialPostProbability('a', 'xiaohongshu', config), .2);
config = { ...config, ...social.setSocialPostLinked('a', 'xiaohongshu', false, config) };
assert.equal(social.getSocialPostProbability('a', 'xiaohongshu', config), .2, 'unlink preserves current value');
config = { ...config, ...social.setSocialPostProbability('a', 'xiaohongshu', .8, config) };
assert.equal(social.getSocialPostProbability('a', 'moments', config), .2);
config = { ...config, ...social.setSocialPostLinked('a', 'xiaohongshu', true, config) };
assert.equal(social.getSocialPostProbability('a', 'moments', config), .8, 'relink adopts this panel value');
config = { ...config, ...social.setSocialPostProbability('a', 'xiaohongshu', 0, config) };
moments.saveMomentsConfig(config);
assert.equal(moments.getMomentPostProbability('a'), 0);
assert.equal(moments.getMomentPostProbability('new'), .5);
assert.ok(social.isSocialPostLinked('a', moments.loadMomentsConfig()));
assert.equal(config.autoPostDisabledCharacterIds.length, 0, 'probability does not edit enabled lists');
const original = moments.loadMomentsConfig();
const draft = { ...original, ...social.setSocialPostLinked('a', 'moments', false, original) };
const current = { ...original, ...social.setSocialPostProbability('b', 'moments', .3, original) };
const merged = social.mergeSocialPostDraft(original, draft, current);
assert.equal(merged.autoPostProbabilityByCharacter.b, .3, 'unrelated live edit survives draft save');
assert.equal(merged.xiaohongshuPostProbabilityByCharacter.a, 0);
for (const values of [[.1,.9],[.9,.1],[.1,.1],[.9,.9]]) {
  let i = 0;
  const plan = social.rollXiaohongshuActivity(.5, .5, () => values[i++]);
  assert.equal(plan.post, values[0] < .5); assert.equal(plan.comment, values[1] < .5); assert.equal(i, 2);
}
assert.equal(social.rollXiaohongshuActivity(0, 0, () => 0).post, false);
assert.equal(social.rollXiaohongshuActivity(1, 1, () => .99999).comment, true);
const types = load('lib/xiaohongshu-types.ts');
const storage = load('lib/xiaohongshu-storage.ts', { './kv-db': kvMock, './social-post-probability': social,
  './xiaohongshu-types': types, './settings-storage': { resolveUserIdentity: () => null } }, { window: {} });
const custom = '崩铁自定义世界观，只生成首页笔记。';
let settings = storage.normalizeXiaohongshuSettings({ npcFeedPrompt: custom, participantCharacterIds: ['a'], sendToCharacterProbability: 0 });
assert.equal(settings.npcFeedPrompt, custom, 'no nearby marker requirement');
assert.equal(settings.sendToCharacterProbability, 0);
assert.equal(settings.browseCommentProbability, 25);
for (const probability of [0, 50, 100]) {
  assert.equal(storage.normalizeXiaohongshuSettings({ browseCommentProbability: probability }).browseCommentProbability, probability);
}
assert.equal(storage.normalizeXiaohongshuSettings({ npcFeedPrompt: '字'.repeat(9000) }).npcFeedPrompt.length, 8000);
assert.equal(storage.normalizeXiaohongshuSettings({ npcFeedPrompt: '' }).npcFeedPrompt, types.DEFAULT_XIAOHONGSHU_SETTINGS.npcFeedPrompt);
const saved = { ...storage.loadXiaohongshuState(), settings };
storage.saveXiaohongshuState(saved);
assert.equal(storage.loadXiaohongshuState().settings.npcFeedPrompt, custom, 'save/reload preserves customized text');

let calls = [];
const raw = '#评论1\n[笔记ID]note1\n[内容]路过分享\n[点赞]是\n#发帖1\n[标题]近况\n[正文]今天的生活\n[评论1作者]路人\n[评论1内容]挺有趣';
const engine = load('lib/xiaohongshu-engine.ts', {
  './social-post-probability': social, './xiaohongshu-types': types, './xiaohongshu-storage': storage,
  './chat-engine': { ChatEngineError: class extends Error {}, sendLLMRequest: async (...args) => { calls.push(args); return raw; } },
  './character-storage': { loadCharacters: () => [{ id: 'a', name: '角色' }] },
  './settings-storage': { loadBindingConfig: () => ({}), resolveBinding: () => ({ apiConfigId: 'api', presetId: 'preset' }),
    loadApiConfigs: () => [{ id: 'api' }], loadPresets: () => [{ id: 'preset' }], loadWorldBooks: () => [], loadRegexes: () => [], resolveUserIdentity: () => null },
  './short-term-assembler': { prepareShortTermContext: () => ({ recentBlocks: [], unifiedRecentItems: [] }) },
  './memory-storage': { loadMemoryConfig: () => ({}) },
  './memory-service': { retrieveMemoriesForPrompt: async () => [], retrieveCoreMemoriesForPrompt: async () => [] },
  './memory-injector': { formatLongTermMemories: () => '', formatCoreMemories: () => '' },
  './bilingual-prompt-defaults': { resolveBilingualPrompt: () => '' },
  './xiaohongshu-character-profile': { resolveCharacterXiaohongshuDisplayName: c => c.name },
  './llm-prompt-assembler': { assemblePromptPayload: () => [{ role: 'system', content: custom }] },
});
async function main() {
  const notes = [{ id: 'note1', source: 'npc', authorName: '路人', title: '候选', body: '生活', tags: [], comments: [], recentLikeNames: [], recentSaveNames: [] }];
  for (const plan of [{ post:false,comment:false },{ post:true,comment:false },{ post:false,comment:true },{ post:true,comment:true }]) {
    const before = calls.length;
    const result = await engine.generateXiaohongshuCharacterActivity('a', notes, settings, plan);
    if (!plan.post && !plan.comment) { assert.equal(result, null); assert.equal(calls.length, before); continue; }
    assert.equal(calls.length, before + 1, 'both selected still use one model request');
    assert.equal(!!result.post, plan.post); assert.equal(result.comments.length, plan.comment ? 1 : 0);
    if (plan.post) assert.equal(result.post.comments.length, 1, 'post-associated NPC comments preserved');
    const messages = calls.at(-1)[2];
    assert.equal(messages[0].content, custom, 'preset content is not rewritten');
    assert.equal(messages.at(-1).content, social.buildXiaohongshuActivityScope(plan));
  }
  const source = fs.readFileSync('components/xiaohongshu/xiaohongshu-app.tsx','utf8');
  assert.ok(source.includes('if (!plan.post && !plan.comment) continue;'));
  assert.ok(source.includes('current.notes.slice(0, 30), activeSettings, plan'));
  console.log('PASS: shared/unlinked probabilities, defaults, independent rolls, draft merge, prompt retention/cap, real engine request scoping and persistence filtering. No model calls.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
