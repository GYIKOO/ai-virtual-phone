// Real assembler; synthetic data only, no browser storage or model calls.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const assembler = {};
const mocks = {
  './macro-engine': { MacroEngine: class {
    constructor(char, user) { this.char = char; this.user = user; }
    expand(text) { return text.replace(/\{\{char\}\}/g, this.char).replace(/\{\{user\}\}/g, this.user); }
  }, postProcessTrim: text => text },
  './character-time': { buildCharacterTimeContext: () => ({}), buildGroupTimeContext: () => ({ members: [] }) },
  './prompt-time': { resolvePromptTimeAware: value => value !== false, getPromptTimestampOptionsForTimeContext: () => ({}) },
  './character-world-storage': { formatCharacterRelationsForPrompt: () => '', formatCharactersRelationsForPrompt: () => '' },
  './character-relation-context': { buildRelationMentionContext: () => '' },
  './chat-storage': { loadChatAppSettings: () => ({ timeAware: false }) },
  './prompt-sanitizer': { stripStateAndInnerForPrompt: text => text },
};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/llm-prompt-assembler.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: assembler, require: name => mocks[name] || {}, console });

const prompt = (identifier, overrides = {}) => ({ identifier, name: identifier, content: identifier, role: 'system', enabled: true, ...overrides });
const marker = identifier => prompt(identifier, { marker: true, content: '' });
const mkPreset = prompts => ({ prompts, prompt_order: prompts.map(p => ({ identifier: p.identifier, enabled: p.enabled })) });
const entry = (uid, key, content, extra = {}) => ({ uid, key, content, position: 0, ...extra });
const shared = { id: 'shared', name: 'shared', entries: [entry(1, '', 'SHARED_BEFORE', { constant: true }), entry(2, '', 'SHARED_AFTER', { constant: true, position: 1 })] };
const members = ['A', 'B'].map(name => ({ character: { id: name, name, persona: `CARD_${name}` }, characterRelations: '', worldBooks: [shared] }));
const history = [{ id: 'history', role: 'user', content: 'HISTORY_LINE', createdAt: '2026-10-22T12:00:00Z' }];
const base = { members, history, regexes: [], userIdentity: { id: 'user', name: 'USER_NAME', bio: 'USER_BIO' }, timeAware: false, groupName: 'test' };
const flat = messages => messages.map(m => m.content).join('\n');
const assertOrder = (text, parts) => {
  let previous = -1;
  for (const part of parts) {
    const index = text.indexOf(part);
    assert.ok(index >= 0, `missing ${part}`);
    assert.ok(index > previous, `wrong ordering of ${part}`);
    previous = index;
  }
};
const prompts = [prompt('OPENING'), marker('personaDescription'), prompt('AFTER_USER'), marker('worldInfoBefore'),
  marker('charDescription'), prompt('AFTER_CARDS'), marker('worldInfoAfter'), marker('shortTermMemory'), prompt('TAIL')];
const preset = mkPreset(prompts);
for (const appTags of [['group_chat', 'text'], ['group_chat', 'text', 'spectator'], ['group_chat', 'offline']]) {
  const payload = assembler.assembleGroupPromptPayload({ ...base, preset, appTags });
  const text = flat(payload);
  assertOrder(text, ['OPENING', 'USER_BIO', 'AFTER_USER', 'SHARED_BEFORE', 'CARD_A', 'CARD_B', 'AFTER_CARDS', 'SHARED_AFTER', 'HISTORY_LINE', 'TAIL']);
  assert.equal(text.split('SHARED_BEFORE').length - 1, 1);
  assert.equal(text.split('SHARED_AFTER').length - 1, 1);
  assert.equal(text.split('当前该角色状态值').length - 1, 2);
}
// Order table, not prompts-array order, is authoritative.
const reordered = { ...preset, prompt_order: [...preset.prompt_order] };
reordered.prompt_order.splice(0, 0, reordered.prompt_order.splice(2, 1)[0]);
assertOrder(flat(assembler.assembleGroupPromptPayload({ ...base, preset: reordered })), ['AFTER_USER', 'OPENING', 'USER_BIO']);
const disabled = { ...preset, prompt_order: preset.prompt_order.map(p => ['OPENING', 'personaDescription', 'worldInfoBefore', 'worldInfoAfter'].includes(p.identifier) ? { ...p, enabled: false } : p) };
const disabledText = flat(assembler.assembleGroupPromptPayload({ ...base, preset: disabled }));
for (const absent of ['OPENING', 'USER_BIO', 'SHARED_BEFORE', 'SHARED_AFTER']) assert.ok(!disabledText.includes(absent), absent);
const many = Array.from({ length: 9 }, (_, i) => ({ ...members[0], character: { id: `c${i}`, name: `C${i}`, persona: `MANY_CARD_${i}` } }));
const manyText = flat(assembler.assembleGroupPromptPayload({ ...base, members: many, preset }));
assertOrder(manyText, ['OPENING', 'USER_BIO', 'SHARED_BEFORE', ...many.map(m => m.character.persona), 'SHARED_AFTER', 'HISTORY_LINE', 'TAIL']);
assert.equal(manyText.split('SHARED_BEFORE').length - 1, 1);
assert.equal(manyText.split('当前该角色状态值').length - 1, 9);
const depthBook = { id: 'depth', entries: [entry(20, '', 'DEPTH_LORE_{{char}}', { constant: true, position: 4, depth: 1 })] };
const depthText = flat(assembler.assembleGroupPromptPayload({ ...base, preset,
  members: members.map((m, i) => ({ ...m, worldBooks: [...m.worldBooks, ...(i ? [] : [depthBook])] })) }));
assertOrder(depthText, ['OPENING', 'CARD_A', 'DEPTH_LORE_A', 'HISTORY_LINE', 'TAIL']);
assert.equal(depthText.split('DEPTH_LORE_').length - 1, 1);
// Relative interleaving, speaker roles and absolute-depth entries survive ordering.
const varied = mkPreset([prompt('OPEN_USER', { role: 'user' }), marker('charDescription'),
  prompt('DEPTH_ONE', { injection_position: 1, injection_depth: 1, role: 'assistant' }), marker('shortTermMemory'),
  marker('worldInfoAfter'), prompt('FINAL_USER', { role: 'user' }), prompt('CHAT_ONLY', { tags: ['chat'] })]);
const variedMessages = assembler.assembleGroupPromptPayload({ ...base, preset: varied, appTags: ['group_chat', 'text'] });
assertOrder(flat(variedMessages), ['OPEN_USER', 'CARD_A', 'DEPTH_ONE', 'HISTORY_LINE', 'SHARED_AFTER', 'FINAL_USER']);
assert.equal(variedMessages.find(m => m.content.includes('OPEN_USER')).role, 'user');
assert.equal(variedMessages.find(m => m.content.includes('DEPTH_ONE')).role, 'assistant');
assert.ok(!flat(variedMessages).includes('CHAT_ONLY'));
console.log('PASS: group/observer/offline preset order, interleaved markers, shared lore once, switches, roles, absolute depth and post-history markers.');

// A -> B -> C: an activated entry's body must not become a new matching input.
const chain = { id: 'chain', entries: [entry(10, 'alpha-key', 'BODY_A mentions beta-key'), entry(11, 'beta-key', 'BODY_B mentions gamma-key'), entry(12, 'gamma-key', 'BODY_C')] };
const wbPreset = mkPreset([marker('worldInfoBefore'), marker('charDescription'), marker('shortTermMemory')]);
for (const sharedBook of [true, false]) {
  const participants = members.map((m, index) => ({ ...m, worldBooks: sharedBook || !index ? [chain] : [] }));
  const text = flat(assembler.assembleGroupPromptPayload({ ...base, preset: wbPreset, members: participants, worldBookActivationContext: 'alpha-key' }));
  assert.ok(text.includes('BODY_A') && !text.includes('BODY_B') && !text.includes('BODY_C'));
}
const single = { history, character: members[0].character, preset: wbPreset, worldBooks: [chain], regexes: [], timeAware: false, characterRelations: '', worldBookActivationContext: 'alpha-key' };
const oneText = flat(assembler.assemblePromptPayload(single));
assert.ok(oneText.includes('BODY_A') && !oneText.includes('BODY_B') && !oneText.includes('BODY_C'));
const allText = flat(assembler.assemblePromptPayload({ ...single, activateAllWorldBooks: true }));
assert.ok(allText.includes('BODY_A') && allText.includes('BODY_B') && allText.includes('BODY_C'));
assert.ok(assembler.isWorldBookEntryActivated(entry(1, 'cat', ''), 'CATalog'));
assert.ok(!assembler.isWorldBookEntryActivated(entry(1, '', ''), 'anything'));
assert.ok(assembler.isWorldBookEntryActivated(entry(1, '', '', { constant: true }), ''));
assert.ok(!assembler.isWorldBookEntryActivated(entry(1, 'a', '', { useProbability: true, probability: 0 }), 'a'));
console.log('PASS: no A->B->C recursion in single/shared/private group lore; explicit activate-all, substring matching, constant, empty keywords and probability semantics.');
