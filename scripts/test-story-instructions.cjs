const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, dependencies = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => dependencies[name] || {}, console, AbortController });
  return exports;
}
const instructions = load('lib/story-instructions.ts');
const row = (id, role, rawContent, kind) => ({ id, role, rawContent, kind, sessionId: 's', createdAt: '2026-10-03T00:00:00Z' });
const user = row('u', 'user', '普通扮演');
const director = row('d', 'user', '镜头转向窗外', 'director');
const reply = row('a', 'assistant', '正文');
assert.equal(instructions.prepareStoryInstructionHistory([user, director]).directorInstruction, director.rawContent);
assert.equal(instructions.prepareStoryInstructionHistory([user, director, reply]).directorInstruction, '');
assert.equal(instructions.prepareStoryInstructionHistory([director, user]).directorInstruction, '');
assert.equal(instructions.prepareStoryInstructionHistory([]).history.length, 0);
assert.equal(instructions.prepareStoryInstructionHistory([director, row('e', 'system', '失败')]).directorInstruction, director.rawContent);
assert.equal(instructions.prepareStoryInstructionHistory([user, director, reply]).history.length, 2);
assert.equal(instructions.getStoryRetryContext([user, director, reply], 'a').length, 2);
assert.equal(instructions.getStoryRetryContext([user, director, reply], 'd').length, 2);
assert.equal(instructions.getStoryRetryContext([user], 'missing'), null);
assert.match(instructions.wrapStoryInstruction('</Request>'), /&lt;\/Request&gt;/);

(async () => {
  let captured, contextOptions, saved = [user, director, reply];
  const engine = load('lib/story-engine.ts', {
    './story-instructions': instructions,
    './story-constraints': load('lib/story-constraints.ts'),
    './character-storage': { loadCharacters: () => [{ id: 'char', name: '角色' }, { id: 'other', name: '配角' }] },
    './settings-storage': {
      loadBindingConfig: () => ({ characterBindings: [] }), resolveBinding: () => ({ apiConfigId: 'api', presetId: 'p' }),
      loadApiConfigs: () => [{ id: 'api' }], loadPresets: () => [{ id: 'p' }], loadRegexes: () => [], loadWorldBooks: () => [], resolveUserIdentity: () => ({ name: 'user' }),
    },
    './llm-prompt-assembler': { assemblePromptPayload: ({ history }) => history.map(m => ({ role: m.role, content: m.content })) },
    './chat-engine': { ChatEngineError: Error, sendLLMRequest: async (_c, _p, messages) => { captured = messages; return '<content>正文</content><summary>事件</summary>'; } },
    './memory-storage': { loadMemoryConfig: () => ({}) },
    './memory-service': { retrieveCoreMemoriesForPrompt: async () => null, retrieveMemoriesForPrompt: async () => null },
    './short-term-assembler': { prepareShortTermContext: (_c, _a, options) => { contextOptions = options; return { truncatedHistory: options.history, recentBlocks: [], unifiedRecentItems: [], wbActivationContext: '' }; } },
    './calendar-storage': { buildCalendarScheduleMarker: () => '', getCurrentCalendarScheduleForPrompt: () => '' },
    './calendar-utils': { getWeekStartIso: () => '' },
    './story-parser': { parseStoryResponse: rawText => ({ rawText, renderedText: '正文', summaryText: '事件' }) },
    './story-storage': { loadStoryMessages: () => saved, resolveActiveStorySchemes: () => ({}) },
    './macro-engine': { MacroEngine: class {} },
  });
  await engine.generateStoryCompletion('char', [user, director], { retryInstruction: '不要下雨' });
  assert.equal(contextOptions.history.length, 1, 'director excluded from narrative history');
  assert.ok(contextOptions.excludeStoryMessageIds.includes('a'), 'discarded reply projection excluded before generation');
  assert.match(captured.at(-2).content, /镜头转向窗外/);
  assert.match(captured.at(-1).content, /不要下雨/);
  const result = await engine.generateStoryCompletion('char', saved);
  assert.ok(captured.every(m => !m.content.includes('Request')), 'consumed and temporary instructions do not persist');
  assert.ok(!result.rawText.includes('不要下雨'));
  assert.equal(saved.length, 3, 'building a retry must not delete saved history');
  await engine.generateStoryCompletion('char', [], { sessionId: 's' });
  assert.ok(contextOptions.excludeStoryMessageIds.includes('a'), 'first-reply retry with empty context still excludes old projection');
  const combined = () => captured.map(m => m.content).join('\n');
  await engine.generateStoryCompletion('char', saved, { participantIds: ['char', 'other'], settings: {} });
  assert.match(combined(), /配角/);
  assert.ok(!combined().includes('不要代替用户'));
  assert.ok(!combined().includes('语音清单'));
  await engine.generateStoryCompletion('char', saved, { settings: { preventUserControl: true, enforceVoiceFormat: true } });
  assert.match(combined(), /不要代替用户/);
  assert.match(combined(), /语音清单/);
  await engine.generateStoryCompletion('char', saved, { settings: { preventUserControl: true, userAgencyPrompt: '自定义用户边界', enforceVoiceFormat: true, voiceFormatPrompt: '自定义语音格式', usePresetNarration: true } });
  assert.match(combined(), /自定义用户边界/);
  assert.match(combined(), /自定义语音格式/);
  assert.ok(!combined().includes('不要代替用户'));
  assert.ok(!combined().includes('正文长度以'));
  await engine.generateStoryCompletion('char', saved, { settings: { preventUserControl: false, userAgencyPrompt: '不应发送的边界', enforceVoiceFormat: false, voiceFormatPrompt: '不应发送的格式' } });
  assert.ok(!combined().includes('不应发送'));
  await engine.generateStoryCompletion('char', [user, director], { participantIds: ['char', 'other'], settings: { enforceVoiceFormat: true }, storyMemory: { independent: true }, retryInstruction: '临时重试优先' });
  assert.match(captured.at(-2).content, /镜头转向窗外/);
  assert.match(captured.at(-1).content, /临时重试优先/);
  console.log('PASS: multiplayer roster, default-off/editable constraints, preset narration and independent-branch director/retry');
  console.log('PASS: director lifetime, roleplay distinction, retry slicing, escaping, request-only guidance, projection exclusion and no destructive preparation');
})().catch(error => { console.error(error); process.exitCode = 1; });
