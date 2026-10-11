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
const constraints = load('lib/story-constraints.ts');
assert.equal(constraints.resolveStoryUserControlMode(), 'preset');
assert.equal(constraints.resolveStoryUserControlMode({ preventUserControl: true }), 'none');
assert.equal(constraints.resolveStoryUserControlMode({ userControlMode: 'unknown', preventUserControl: true }), 'none');
assert.equal(constraints.resolveStoryUserControlMode({ userControlMode: 'unknown' }), 'preset');
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
assert.match(instructions.wrapStoryRetryInstruction(' A & </Request> '), /A &amp; &lt;\/Request&gt;/);
assert.ok(!instructions.wrapStoryInstruction('镜头转向窗外').includes('编辑反馈'), 'director mode retains its own semantics');
assert.match(instructions.wrapStoryRetryInstruction('改一下'), /事实纠正作为新版剧情的事实前提/);
assert.match(instructions.wrapStoryRetryInstruction('改一下'), /剧情方向用于安排事件发展/);

(async () => {
  let captured, contextOptions, saved = [user, director, reply];
  const engine = load('lib/story-engine.ts', {
    './story-tag-settings': load('lib/story-tag-settings.ts'),
    './story-instructions': instructions,
    './story-constraints': constraints,
    './character-storage': { loadCharacters: () => [{ id: 'char', name: '角色' }, { id: 'other', name: '配角' }] },
    './settings-storage': {
      loadBindingConfig: () => ({ characterBindings: [] }), resolveBinding: () => ({ apiConfigId: 'api', presetId: 'p' }),
      loadApiConfigs: () => [{ id: 'api' }], loadPresets: () => [{ id: 'p' }], loadRegexes: () => [], loadWorldBooks: () => [], resolveUserIdentity: () => ({ name: 'user' }),
    },
    './llm-prompt-assembler': { assemblePromptPayload: ({ history }) => history.map(m => ({ role: m.role, content: m.content })) },
    './chat-engine': { ChatEngineError: Error, previewMessagesForApi: (_c, _p, messages) => messages, sendLLMRequest: async (_c, _p, messages) => { captured = messages; return '<content>正文</content><summary>事件</summary>'; } },
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
  assert.match(captured.at(-1).content, /编辑反馈/);
  assert.ok(!captured.at(-2).content.includes('编辑反馈'), 'director and retry instructions remain distinct');
  for (const feedback of ['角色从未到访旧港，相关回忆的设定有误。', '这一段节奏太急，改得舒缓些。', '让大家在下一段动身去旧港。', '角色从未到访旧港；这一段安排初次到访。']) {
    await engine.generateStoryCompletion('char', [user], { retryInstruction: feedback });
    assert.equal(captured.at(-1).content, instructions.wrapStoryRetryInstruction(feedback), 'all feedback kinds use revision framing without guessing or rewriting user text');
    assert.equal(captured.at(-1)._debugMeta.marker, '临时重试要求');
    assert.ok(!contextOptions.history.some(m => m.content.includes(feedback)), 'editorial feedback stays outside narrative history');
    assert.equal(saved.length, 3, 'feedback must not mutate stored history');
  }
  await engine.generateStoryCompletion('char', [user], { retryInstruction: '   ' });
  assert.ok(captured.every(m => !m.content.includes('编辑反馈')), 'blank retries add no editorial instruction');
  const result = await engine.generateStoryCompletion('char', saved);
  assert.ok(captured.every(m => !m.content.includes('Request')), 'consumed and temporary instructions do not persist');
  assert.ok(!result.rawText.includes('不要下雨'));
  assert.equal(saved.length, 3, 'building a retry must not delete saved history');
  await engine.generateStoryCompletion('char', [], { sessionId: 's' });
  assert.ok(contextOptions.excludeStoryMessageIds.includes('a'), 'first-reply retry with empty context still excludes old projection');
  const combined = () => captured.map(m => m.content).join('\n');
  const taggedUser = row('tags', 'user', '正文<think>隐藏思考</think><summary>保留摘要</summary>');
  await engine.generateStoryCompletion('char', [taggedUser]);
  assert.ok(!combined().includes('隐藏思考'));
  assert.ok(combined().includes('保留摘要'), 'folding summary does not exclude it from context');
  await engine.generateStoryCompletion('char', [taggedUser], { sessionContextExcludedTags: '' });
  assert.ok(combined().includes('隐藏思考'), 'explicit empty context tags remain empty');
  await engine.generateStoryCompletion('char', [taggedUser], { sessionContextExcludedTags: 'summary' });
  assert.ok(!combined().includes('保留摘要'));
  const customFolds = await engine.generateStoryCompletion('char', [user], { sessionFoldTags: '' });
  assert.equal(customFolds.regexSignature, engine.getStoryRenderSignature('char', '').regexSignature);
  assert.notEqual(customFolds.regexSignature, engine.getStoryRenderSignature('char').regexSignature, 'fold changes invalidate render cache');
  await engine.generateStoryCompletion('char', saved, { settings: { userPerspective: 'third' } });
  assert.ok(combined().includes('TA/他/她，按用户设定选用'));
  assert.ok(!combined().includes('使用第三人称“TA”称呼用户'));
  await engine.generateStoryCompletion('char', saved, { settings: { userPerspective: 'third', usePresetNarration: true } });
  assert.ok(!combined().includes('TA/他/她，按用户设定选用'));
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
  const prompts = {
    none: constraints.DEFAULT_STORY_USER_AGENCY_PROMPT,
    moderate: constraints.DEFAULT_STORY_MODERATE_USER_CONTROL_PROMPT,
    strong: constraints.DEFAULT_STORY_STRONG_USER_CONTROL_PROMPT,
  };
  const fields = { none: 'userAgencyPrompt', moderate: 'moderateUserControlPrompt', strong: 'strongUserControlPrompt' };
  const endingPrompt = constraints.DEFAULT_STORY_USER_CONTROL_ENDING_PROMPT;
  assert.match(endingPrompt, /剧情正文都不得以用户的行动或对白结束/);
  // New modes take precedence over legacy flags, and never inject inactive defaults.
  for (const mode of ['preset', 'none', 'moderate', 'strong']) {
    await engine.generateStoryCompletion('char', saved, { participantIds: ['char', 'other'], settings: { userControlMode: mode, preventUserControl: mode !== 'none', usePresetNarration: true } });
    for (const [other, prompt] of Object.entries(prompts)) {
      assert.equal(captured.filter(m => m.content === prompt).length, mode === other ? 1 : 0, `${mode}: only active prompt injected once`);
    }
    assert.equal(captured.filter(m => m.content === endingPrompt).length, ['moderate', 'strong'].includes(mode) ? 1 : 0, 'ending rule applies once to both takeover modes only');
    const preview = await engine.previewStoryPromptPayload('char', saved, { participantIds: ['char', 'other'], settings: { userControlMode: mode, preventUserControl: mode !== 'none', usePresetNarration: true } });
    assert.deepEqual(preview.messages, captured, 'preview and actual generation use identical constraints');
    assert.ok(!combined().includes('正文长度以'));
  }
  const customSettings = { userAgencyPrompt: '自定不抢话', moderateUserControlPrompt: '自定适当抢话', strongUserControlPrompt: '自定强抢话' };
  for (const mode of ['none', 'moderate', 'strong', 'preset', 'moderate']) {
    const settings = JSON.parse(JSON.stringify({ ...customSettings, userControlMode: mode }));
    await engine.generateStoryCompletion('char', saved, { settings });
    assert.equal(combined().includes(endingPrompt), ['moderate', 'strong'].includes(mode), 'existing custom prompts also receive shared ending rule');
    for (const [other, field] of Object.entries(fields)) {
      assert.equal(combined().includes(customSettings[field]), mode === other, 'switching/serialization retains each draft without leaking inactive prompts');
    }
    assert.ok(Object.values(prompts).every(prompt => !combined().includes(prompt)), 'custom prompts replace defaults');
    if (fields[mode]) {
      await engine.generateStoryCompletion('char', saved, { settings: { ...settings, [fields[mode]]: '  ' } });
      assert.ok(Object.values(prompts).every(prompt => !combined().includes(prompt)), 'explicit blank does not restore default');
      assert.ok(Object.values(customSettings).every(prompt => !combined().includes(prompt)));
      assert.equal(combined().includes(endingPrompt), ['moderate', 'strong'].includes(mode), 'clearing mode text does not remove the shared ending requirement');
    }
  }
  for (const mode of ['moderate', 'strong']) {
    await engine.generateStoryCompletion('char', saved, { settings: { userControlMode: mode, userControlEndingPrompt: '自定义收尾要求' } });
    assert.match(combined(), /自定义收尾要求/);
    assert.ok(!combined().includes(endingPrompt));
    await engine.generateStoryCompletion('char', saved, { settings: { userControlMode: mode, userControlEndingPrompt: '' } });
    assert.ok(!combined().includes(endingPrompt), 'editable blank ending rule remains blank');
  }
  await engine.generateStoryCompletion('char', [user, director], { participantIds: ['char', 'other'], settings: { enforceVoiceFormat: true, userControlMode: 'strong' }, storyMemory: { independent: true }, retryInstruction: '临时重试优先' });
  assert.ok(combined().includes(prompts.strong));
  assert.equal(captured.at(-3).content, endingPrompt, 'shared ending rule follows voice formatting and precedes director/retry instructions');
  assert.match(captured.at(-2).content, /镜头转向窗外/);
  assert.match(captured.at(-1).content, /临时重试优先/);
  console.log('PASS: multiplayer roster, default-off/editable constraints, preset narration and independent-branch director/retry');
  console.log('PASS: user-control modes, legacy compatibility, independent editable drafts and explicit empty prompts');
  console.log('PASS: shared takeover ending rule, custom prompts, preview parity and instruction ordering');
  console.log('PASS: retry editorial feedback framing, escaping, correction/direction/mixed notes and request-only lifetime');
  console.log('PASS: director lifetime, roleplay distinction, retry slicing, escaping, request-only guidance, projection exclusion and no destructive preparation');
})().catch(error => { console.error(error); process.exitCode = 1; });
