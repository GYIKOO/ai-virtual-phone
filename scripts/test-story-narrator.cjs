// Prompt assembly only: no browser, database, model, API calls or dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, dependencies = {}) {
  const exports = {};
  const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true,
  });
  assert.equal(result.diagnostics?.length || 0, 0, `${file} transpiles`);
  vm.runInNewContext(result.outputText, { exports, require: name => dependencies[name] || {}, console });
  return exports;
}
const defaults = load('lib/story-default-prompt.ts');
const builtin = load('lib/builtin-preset.ts', {
  './story-default-prompt': defaults, './checkphone-config': { getCheckPhonePromptTags: () => [] },
});
const assembler = load('lib/llm-prompt-assembler.ts', {
  './macro-engine': { MacroEngine: class { expand(text) { return text; } }, postProcessTrim: text => text },
  './prompt-time': { resolvePromptTimeAware: () => false, getPromptTimestampOptionsForTimeContext: () => ({}) },
  './character-time': { buildCharacterTimeContext: () => ({}) },
});
const marker = { identifier: 'charDescription', marker: true, enabled: true, role: 'system', content: '' };
const input = { character: { id: 'a', name: '林舟', persona: '测试人物资料' }, history: [],
  preset: { prompts: [marker] }, worldBooks: [], regexes: [] };
const text = options => assembler.assemblePromptPayload({ ...input, ...options }).map(m => m.content).join('\n');
assert.equal(text({ appId: 'story' }), '<charDescription>\n角色资料：林舟\n测试人物资料\n</charDescription>');
for (const options of [{}, { appId: 'chat' }, { appId: 'chat', appTags: ['chat', 'offline'] }, { appId: 'other', appTags: ['story'] }]) {
  assert.equal(text(options), '<charDescription>\nYou are 林舟.\n测试人物资料\n</charDescription>', 'only the story app changes identity framing');
}
assert.equal(text({ appId: 'story', preset: { prompts: [{ ...marker, enabled: false }] } }), '', 'disabled description stays absent');
assert.equal(text({ appId: 'story', preset: { prompts: [] } }), '', 'no implicit narrator instruction is added');
assert.match(text({ appId: 'story', preset: { prompts: [marker, { identifier: 'custom', enabled: true, role: 'system', content: '我的自定义视角与角色权限' }] } }), /我的自定义视角与角色权限/);

const fresh = builtin.createBuiltinPreset();
assert.equal(builtin.BUILTIN_PRESET_VERSION, 265, 'do not reset users built-in presets via a version bump');
const entry = fresh.prompts.find(p => p.identifier === 'story_output_format');
assert.equal(entry.content, defaults.DEFAULT_STORY_OUTPUT_PROMPT);
assert.match(entry.content, /各人物的对白、行动和心理符合各自的人设/);
assert.match(entry.content, /代写范围按当前抢话设置与用户预设执行/);
assert.ok(!entry.content.includes('你的人设与背景'));
const legacyText = entry.content
  .replace(/^【模式】.*$/m, '【模式】你当前处于剧情模式。这不是即时通讯聊天，而是连续推进的长文本互动场景。')
  .replace(/^【上下文】.*$/m, '【上下文】assistant 是你在剧情模式中之前说过或叙述过的内容，user 是 {{user}} 在剧情模式中的输入；<charDescription>、<worldInfoBefore>、<worldInfoAfter> 中是你的人设与背景；<memoryCore>、<memoryLongTerm> 和 <shortTermMemory> 是你可以调用的记忆与近期事件。')
  .replace(/^- 各人物的对白、行动和心理.*$/m, '- 语言风格必须符合 {{char}} 的人设和当前情境');
const old = { ...fresh, prompts: fresh.prompts.map(p => p === entry ? { ...p, content: legacyText, enabled: false } : p) };
const upgraded = defaults.migrateBuiltinStoryNarration(old);
assert.notEqual(upgraded, old);
assert.equal(upgraded.prompts.find(p => p.identifier === entry.identifier).content, entry.content);
assert.equal(upgraded.prompts.find(p => p.identifier === entry.identifier).enabled, false, 'migration keeps enable state');
assert.equal(upgraded.prompt_order, old.prompt_order, 'migration keeps order and selection');
assert.equal(upgraded.builtInVersion, old.builtInVersion);
assert.equal(old.prompts.find(p => p.identifier === entry.identifier).content, legacyText, 'migration does not mutate input');
for (let i = 0; i < old.prompts.length; i++) {
  if (old.prompts[i].identifier !== entry.identifier) assert.equal(upgraded.prompts[i], old.prompts[i], 'other app prompts untouched');
}
const custom = { ...old, prompts: old.prompts.map(p => p.identifier === entry.identifier ? { ...p, content: `${p.content}\n我的修改` } : p) };
assert.equal(defaults.migrateBuiltinStoryNarration(custom), custom, 'edited built-in entry stays byte-for-byte intact');
const imported = { ...old, builtIn: false };
assert.equal(defaults.migrateBuiltinStoryNarration(imported), imported, 'custom presets are never migrated');
assert.equal(defaults.migrateBuiltinStoryNarration(upgraded), upgraded, 'migration is idempotent');
console.log('PASS: real story marker assembly is neutral; chat/offline unchanged; custom prompts and marker toggles preserved');
console.log('PASS: editable narrator default, exact legacy-only migration, no preset reset, untouched custom text/order/enabled state/other apps');
