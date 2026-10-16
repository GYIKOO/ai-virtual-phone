// Offline request inspection: real short-term selection, assembly and provider serialization.
// App stores return empty fixtures except the supplied A -> B conversation. No network.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { execFileSync } = require('node:child_process');
const emptyStore = new Proxy({}, { get: () => () => [] });
function load(file, deps = {}, source = fs.readFileSync(file, 'utf8')) {
  const exports = {};
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
  assert.equal(compiled.diagnostics.length, 0, file);
  vm.runInNewContext(compiled.outputText, { exports, require: name => deps[name] || emptyStore, console });
  return exports;
}
const time = load('lib/character-time.ts');
const promptTime = load('lib/prompt-time.ts', { './character-time': time, './chat-storage': { loadChatAppSettings: () => ({ timeAware: true }) } });
const sanitizer = load('lib/prompt-sanitizer.ts', { './state-value-parser': load('lib/state-value-parser.ts') });
const macro = load('lib/macro-engine.ts', { './character-time': time });
const character = { id: 'c', name: '测试角色', persona: '测试人设' };
const shortTerm = load('lib/short-term-assembler.ts', {
  './character-storage': { loadCharacters: () => [character] },
  './chat-storage': { loadChatSessions: () => [], loadChatMessages: () => [], isSystemInstructionMessage: () => false, isReadingDiscussMessage: () => false },
  './memory-storage': { loadMemoryConfig: () => ({ shortTermTokenBudget: 10000 }) },
  './settings-storage': { resolveUserIdentity: () => ({ name: '测试用户' }) },
  './prompt-time': promptTime, './prompt-sanitizer': sanitizer,
  './token-counter': { estimateTokens: text => text.length },
});
const assembler = load('lib/llm-prompt-assembler.ts', {
  './macro-engine': macro, './character-time': time, './prompt-time': promptTime, './prompt-sanitizer': sanitizer,
  './content-tag-utils': load('lib/content-tag-utils.ts', { './checkphone-config': load('lib/checkphone-config.ts') }),
  './recent-time-context': load('lib/recent-time-context.ts', { './character-time': time }),
  './character-world-storage': { formatCharacterRelationsForPrompt: () => '', formatCharactersRelationsForPrompt: () => '' },
  './character-relation-context': load('lib/character-relation-context.ts'),
  './dwelling-storage': { readDwellingLayoutCache: () => null },
  './dwelling-engine': { formatDwellingContext: () => '' },
});
const provider = load('lib/llm-provider-adapter.ts', {
  './api-helpers': load('lib/api-helpers.ts'),
  './generation-parameters': load('lib/generation-parameters.ts'),
});
const at = Date.parse('2026-10-12T12:00:00Z');
const history = [
  { id: 'u', sessionId: 's', role: 'user', content: 'USER_A_想问图书馆几点关门', createdAt: '2026-10-11T12:00:00Z' },
  { id: 'a', sessionId: 's', role: 'assistant', content: 'CHAR_B_晚上九点关门我已经查过了', senderName: '测试角色', senderCharacterId: 'c', createdAt: '2026-10-11T12:01:00Z' },
];
const preset = process.env.FLOAT_AUDIT_PRESET
  ? JSON.parse(fs.readFileSync(process.env.FLOAT_AUDIT_PRESET, 'utf8'))
  : { prompts: [{ identifier: 'shortTermMemory', enabled: true, marker: true, role: 'system' }] };
let count = 0;
for (const group of [false, true]) for (const replay of [false, true]) {
  const opts = { history, historicalAt: replay ? at - 3600000 : undefined };
  const selected = group ? shortTerm.prepareGroupShortTermContext(['c'], history, opts)
    : shortTerm.prepareShortTermContext('c', 'chat', opts);
  assert.equal(selected.truncatedHistory.length, 2, 'both A and the already sent reply B survive selection');
  const common = { history: selected.truncatedHistory, unifiedRecentItems: selected.unifiedRecentItems,
    preset, regexes: [], appTags: [group ? 'group_chat' : 'chat', 'text', 'proactive'],
    timeContext: time.buildCharacterTimeContext('UTC', new Date(opts.historicalAt ?? at)) };
  const messages = group
    ? assembler.assembleGroupPromptPayload({ ...common, groupName: '测试群', userName: '测试用户', memberNames: ['测试角色'], members: [{ character, worldBooks: [] }] })
    : assembler.assemblePromptPayload({ ...common, character, worldBooks: [] });
  if (process.env.FLOAT_AUDIT_PRESET) {
    const assembled = messages.map(m => m.content).join('\n');
    assert.equal(assembled.split('USER_A_').length - 1, 1, 'old user input is not re-injected by the preset');
    assert.equal(assembled.split('CHAR_B_').length - 1, 1, 'already sent reply appears once');
    assert.ok(!assembled.includes('<user_input>') && !assembled.includes('<offline_preparation>'), 'offline input anchor does not leak into online proactive requests');
    console.log(JSON.stringify({ group, replay, turns: messages.map(m => ({ role: m.role, chars: m.content.length, oldInput: m.content.includes('USER_A_'), sentReply: m.content.includes('CHAR_B_') })) }));
  }
  messages.push({ role: 'system', content: '本轮自主交流机会；时间：' + new Date(opts.historicalAt ?? at).toISOString() });
  for (const kind of ['Custom', 'Anthropic', 'Google']) {
    const config = { provider: kind, apiKey: 'offline-test-not-a-key', defaultModel: kind === 'Google' ? 'gemini-test' : kind === 'Anthropic' ? 'claude-test' : 'test', baseUrl: kind === 'Google' ? 'https://generativelanguage.googleapis.com/v1beta' : kind === 'Anthropic' ? 'https://api.anthropic.com/v1' : 'https://example.invalid/v1' };
    const request = provider.buildProviderRequest(config, null, provider.toLlmRequestMessages(messages));
    const raw = JSON.stringify(request.body);
    assert.ok(raw.includes('USER_A_') && raw.includes('CHAR_B_'), `${group}/${replay}/${kind}: reply must reach provider body`);
    assert.ok(raw.indexOf('USER_A_') < raw.indexOf('CHAR_B_'), 'old user input precedes the already sent reply');
    const turns = request.body.messages ?? request.body.contents;
    assert.ok(turns.some(t => ['assistant', 'model'].includes(t.role) && JSON.stringify(t).includes('CHAR_B_')), 'reply retains assistant/model identity');
    count++;
  }
}
const defaults = load('lib/moments-default-prompt.ts');
const deps = { './checkphone-config': { getCheckPhonePromptTags: () => [] }, './story-default-prompt': load('lib/story-default-prompt.ts'), './moments-default-prompt': defaults };
const original = load('lib/builtin-preset.ts', deps, execFileSync('git', ['show', 'HEAD:lib/builtin-preset.ts'], { encoding: 'utf8' })).createBuiltinPreset();
const originalEntry = original.prompts.find(p => p.identifier === 'moments_optional_actions');
originalEntry.enabled = false;
const upgraded = defaults.migrateBuiltinMomentsActions(original);
const entry = upgraded.prompts.find(p => p.identifier === originalEntry.identifier);
assert.match(entry.content, /直接关联/); assert.match(entry.content, /亲近关系/); assert.equal(entry.enabled, false);
assert.equal(upgraded.prompt_order, original.prompt_order);
assert.equal(upgraded.builtInVersion, original.builtInVersion, 'no preset version reset');
assert.equal(defaults.migrateBuiltinMomentsActions(upgraded), upgraded);
const custom = { ...original, prompts: original.prompts.map(p => p === originalEntry ? { ...p, content: p.content + '\n自定义' } : p) };
assert.equal(defaults.migrateBuiltinMomentsActions(custom), custom);
const imported = { ...original, builtIn: false };
assert.equal(defaults.migrateBuiltinMomentsActions(imported), imported);
assert.equal(load('lib/builtin-preset.ts', deps).createBuiltinPreset().prompts.find(p => p.identifier === originalEntry.identifier).content, entry.content);
console.log(`PASS: ${count} single/group, current/replay and provider request bodies retain A -> B; untouched Moments preset migration only. This verifies request data, not model behavior.`);
module.exports = { load, shortTerm, assembler, time, promptTime, sanitizer, character, history, at };
