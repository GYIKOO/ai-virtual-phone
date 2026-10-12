// Read-only diagnostic reproductions. No model, browser, app store, or network calls.
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { load, shortTerm, assembler, time, promptTime, sanitizer, character, history, at } = require('./test-proactive-request-history.cjs');
const source = fs.readFileSync('lib/chat-engine.ts', 'utf8');
const ast = ts.createSourceFile('chat-engine.ts', source, ts.ScriptTarget.Latest, true);
const names = new Set(['EMPTY_GENERATE_CONTINUATION_PROMPT', 'shouldApplyEmptyGenerateGuard', 'isRealUserHistoryMessage', 'isToolFlowHistoryMessage', 'isBlacklistEventHistoryMessage', 'appendEmptyGenerateGuardMessage']);
const guardSource = ast.statements.filter(n => names.has(n.name?.text)
  || (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.has(d.name.getText(ast)))))
  .map(n => n.getText(ast)).join('\n');
const guard = load('guard-fragment.ts', {}, guardSource);
const generationContext = load('lib/chat-generation-context.ts');
for (const file of ['lib/chat-engine.ts', 'lib/group-chat-engine.ts']) {
  const raw = fs.readFileSync(file, 'utf8');
  const call = raw.split('\n').find(line => line.includes('if (!isAutomaticChatGeneration(options)) appendEmptyGenerateGuardMessage'));
  assert.ok(call, file);
  for (const trigger of ['proactive', 'idle_wake', 'timed_wake', 'user_timed_wake', 'followup', 'period_care', 'manual']) {
    const messages = [];
    vm.runInNewContext(call, { options: { appTags: ['chat', 'text', trigger] }, llmMessages: messages,
      config: { preventEmptyGenerateRambling: true }, history, historyForPrompt: history, ...guard, ...generationContext });
    assert.equal(messages.some(m => m.content.includes('不要开启新事件')), trigger === 'manual');
  }
}
assert.equal(generationContext.isAutomaticChatGeneration({ automatic: true }), true);
assert.equal(generationContext.isAutomaticChatGeneration({ followUpCount: 1 }), true);
assert.equal(generationContext.isAutomaticChatGeneration({ ephemeralSystemNote: 'event' }), true);
console.log('PASS: all scheduled triggers exclude manual continuation; manual empty-send keeps its original behavior.');

const avatar = load('lib/chat-avatar-intent.ts');
const avatarHistory = [
  { ...history[0], mediaType: 'image', mediaUrl: 'https://example.invalid/photo.jpg', content: '把这张换成头像' },
  { ...history[1], content: '这张照片拍得挺好。' },
];
assert.ok(avatar.findUserAvatarChangeIntent(avatarHistory, 's', 'c'), 'an answered but unresolved avatar request is still returned');
assert.equal(avatar.findUserAvatarChangeIntent(avatarHistory, 's', 'c', { allowAnsweredTurn: false }), null);
assert.ok(avatar.findUserAvatarChangeIntent(avatarHistory.slice(0, 1), 's', 'c', { allowAnsweredTurn: false }));
assert.match(source, /!isAutomaticChatGeneration\(options\)\s*\? findUserAvatarChangeIntent/);
assert.equal(avatar.findUserAvatarChangeIntent([
  { ...avatarHistory[0], mediaData: { avatarRecommendationStatus: 'accepted' } }, avatarHistory[1],
], 's', 'c'), null);
console.log('PASS: prompt only detects new user avatar intent; post-save avatar decision lookup still sees the answered turn.');

const preset = { prompts: [{ identifier: 'shortTermMemory', marker: true, role: 'system', enabled: true }] };
const groupSource = fs.readFileSync('lib/group-chat-engine.ts', 'utf8');
const groupAst = ts.createSourceFile('group-chat-engine.ts', groupSource, ts.ScriptTarget.Latest, true);
const annotateNode = groupAst.statements.find(n => n.name?.text === 'annotateGroupHistory');
const annotateSource = 'const { loadCharacters, formatRichMediaForHistory } = require("fixture");\n' + annotateNode.getText(groupAst);
const { annotateGroupHistory } = load('annotation-fragment.ts', { fixture: { loadCharacters: () => [character], formatRichMediaForHistory: assembler.formatRichMediaForHistory } }, annotateSource);
for (const group of [false, true]) {
  const variants = [
    history,
    [history[0], { ...history[1], mediaType: 'audio', content: '', mediaData: { label: history[1].content } }],
    [history[0], { ...history[1], mediaType: 'quote', mediaData: { quotePreview: history[0].content } }],
    [history[0], { ...history[1], content: '[内心]准备回答[/内心]\n' + history[1].content }],
  ];
  for (const sample of variants) {
    const annotated = group ? annotateGroupHistory(sample, ['c'], '测试用户') : sample;
    const selected = group ? shortTerm.prepareGroupShortTermContext(['c'], annotated, { history: annotated })
      : shortTerm.prepareShortTermContext('c', 'chat', { history: sample });
    const input = { history: selected.truncatedHistory, unifiedRecentItems: selected.unifiedRecentItems,
      preset, regexes: [], appTags: [group ? 'group_chat' : 'chat', 'text', 'proactive'],
      timeContext: time.buildCharacterTimeContext('UTC', new Date(at)) };
    const assemble = regexes => group
      ? assembler.assembleGroupPromptPayload({ ...input, regexes, groupName: '测试群', userName: '测试用户', members: [{ character, worldBooks: [] }] })
      : assembler.assemblePromptPayload({ ...input, regexes, character, worldBooks: [] });
    const payload = assemble([]);
    assert.ok(JSON.stringify(payload).includes('CHAR_B_'), JSON.stringify({ group, media: sample[1].mediaType, selected: selected.truncatedHistory, payload }));
  }
  const selected = group ? shortTerm.prepareGroupShortTermContext(['c'], history, { history })
    : shortTerm.prepareShortTermContext('c', 'chat', { history });
  const args = { history: selected.truncatedHistory, unifiedRecentItems: selected.unifiedRecentItems,
    preset, regexes: [{ rules: [{ id: 'fixture', disabled: false, placement: [1], promptOnly: true, historyOnly: true,
      findRegex: '/CHAR_B_[^\\n]*/g', replaceString: '' }] }], appTags: [group ? 'group_chat' : 'chat', 'text', 'proactive'] };
  const messages = group ? assembler.assembleGroupPromptPayload({ ...args, groupName: '测试群', userName: '测试用户', members: [{ character, worldBooks: [] }] })
    : assembler.assemblePromptPayload({ ...args, character, worldBooks: [] });
  assert.ok(JSON.stringify(messages).includes('USER_A_') && !JSON.stringify(messages).includes('CHAR_B_'));
}
console.log('PASS: single/group text, voice, quote and inner-tag stripping retain replies. A controlled prompt-only regex can erase B without altering stored history; this does not establish that the user has such a rule.');

for (const budget of [8, 32, 64, 128]) {
  const selector = load('lib/short-term-assembler.ts', {
    './character-storage': { loadCharacters: () => [character] },
    './chat-storage': { loadChatSessions: () => [], loadChatMessages: () => [], isSystemInstructionMessage: () => false, isReadingDiscussMessage: () => false },
    './memory-storage': { loadMemoryConfig: () => ({ shortTermTokenBudget: budget }) },
    './settings-storage': { resolveUserIdentity: () => ({ name: '测试用户' }) },
    './prompt-time': promptTime, './prompt-sanitizer': sanitizer,
    './token-counter': { estimateTokens: text => text.length },
  });
  for (const group of [false, true]) {
    const selected = group ? selector.prepareGroupShortTermContext(['c'], history, { history })
      : selector.prepareShortTermContext('c', 'chat', { history });
    const ids = selected.truncatedHistory.map(m => m.id);
    assert.ok(!ids.includes('u') || ids.includes('a'), 'oldest-first budget must not keep A while discarding newer B');
  }
}
console.log('PASS: eight single/group budget cases remove oldest history first, not only the latest reply. Extremely small budgets can remove both turns.');

const cloud = fs.readFileSync('supabase/functions/push-generate/index.ts', 'utf8');
const cloudAst = ts.createSourceFile('push-generate.ts', cloud, ts.ScriptTarget.Latest, true);
const helperNames = new Set(['appendIdleTurn', 'idleGenerationContext', 'prepareIdleGeneration', 'advanceIdlePayload']);
const cloudFunctions = cloudAst.statements.filter(n => helperNames.has(n.name?.text)).map(n => 'export ' + n.getText(cloudAst)).join('\n');
const compiledCloud = ts.transpileModule(cloudFunctions, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const cloudExports = {};
vm.runInNewContext(compiledCloud.outputText, { exports: cloudExports, structuredClone, Intl, Date });
assert.ok(cloud.includes('const nextPayload = advanceIdlePayload(payload, rawText, Date.now(), nextMerge)'));
assert.ok(cloud.includes('job.kind === "timed_task" && job.trigger_key.startsWith("idle:")'));
const repeatGuard = cloud.split('\n').find(line => line.includes('if (') && line.includes('Number(idleRepeat.remaining) > 0'));
assert.ok(repeatGuard);
for (const [kind, trigger, expected] of [['timed_task', 'idle:rule:0', true], ['timed_task', 'idle:rule:0+', true],
  ['shortcut_resume', 'shortcut:cmd', false], ['timed_task', 'shortcut:cmd+', false], ['reply', 'reply:s', false]]) {
  const outcome = { fired: false };
  vm.runInNewContext(repeatGuard + '\n outcome.fired = true; }', {
    job: { kind, trigger_key: trigger }, idleRepeat: { remaining: 2, intervalMs: 3600000 }, outcome,
  });
  assert.equal(outcome.fired, expected, `${kind}/${trigger}: only idle tasks may continue the idle chain`);
}
console.log('PASS: inherited shortcut metadata cannot start a second cloud repeat chain.');
for (const kind of ['openai-compatible', 'anthropic', 'gemini']) {
  const wire = (role, text) => kind === 'gemini' ? { role: role === 'assistant' ? 'model' : role, parts: [{ text }] }
    : kind === 'anthropic' ? { role, content: [{ type: 'text', text }] } : { role, content: text };
  const key = kind === 'gemini' ? 'contents' : 'messages';
  const request = { providerKind: kind, url: 'https://example.invalid', headers: {}, body: { model: 'test', [key]: [wire('user', 'A'), wire('assistant', 'B')] } };
  const payload = { request, merge: { idleClock: { snapshotAt: '2026-10-12T00:00:00Z', characterTimeZone: 'Asia/Shanghai', userTimeZone: 'America/Los_Angeles', lastMessageAt: '2026-10-12T01:00:00Z' } },
    shortcutContinuation: { replyMarker: '__REPLY__', resultMarker: '__RESULT__', request: { ...request, body: { ...request.body, [key]: [...request.body[key], wire('assistant', '__REPLY__'), wire('user', '__RESULT__')] } } } };
  const original = JSON.stringify(payload);
  let current = payload;
  for (let round = 0; round < 3; round++) {
    const at = Date.parse('2026-10-12T02:00:00Z') + round * 3600000;
    const prepared = cloudExports.prepareIdleGeneration(current, at);
    const sent = JSON.stringify(prepared.request.body);
    assert.ok(sent.includes(new Date(at).toISOString()) && sent.includes('Asia/Shanghai') && sent.includes('America/Los_Angeles'));
    for (let previous = 0; previous < round; previous++) assert.ok(sent.includes('REPLY_' + previous));
    current = cloudExports.advanceIdlePayload(prepared, 'REPLY_' + round, at + 1000, { ...prepared.merge, armAt: 'next' });
    const turns = current.request.body[key];
    assert.equal(turns.at(-1).role, kind === 'gemini' ? 'model' : 'assistant');
    const continuation = JSON.stringify(current.shortcutContinuation.request.body);
    assert.ok(continuation.indexOf('REPLY_' + round) < continuation.indexOf('__REPLY__'));
    assert.ok(continuation.includes('__RESULT__'));
  }
  assert.equal(JSON.stringify(payload), original, 'never mutate the original snapshot');
}
console.log('PASS: three cloud repeat rounds across three provider formats carry every preceding reply, refresh time/timezones and preserve shortcut continuation markers.');

// Exercise the real multi-round save wrapper with a controlled persistence boundary.
// This verifies cancellation plumbing, not IndexedDB or a live model.
const followSource = fs.readFileSync('lib/follow-up-service.ts', 'utf8');
const followAst = ts.createSourceFile('follow-up-service.ts', followSource, ts.ScriptTarget.Latest, true);
assert.ok(!followAst.statements.find(n => n.name?.text === 'generateBackgroundCompletionRounds').getText(followAst).includes('automatic: true'),
  'the shared background wrapper also handles actual user replies; do not classify all of them as autonomous');
const saveNames = new Set(['canPersistAutomaticReply', 'saveBackgroundCompletionRounds']);
const saveSource = 'const { isBackgroundGenerationCancelled, loadChatSessions, parseAndSaveResponse } = require("fixture");\n'
  + followAst.statements.filter(n => saveNames.has(n.name?.text)).map(n => 'export ' + n.getText(followAst)).join('\n');
async function checkSaveCancellation() {
  for (const mode of ['disable', 'delete', 'cancel', 'manual-disabled', 'normal']) {
    let cancelled = false;
    let sessions = [{ id: 's', proactiveDisabled: mode === 'manual-disabled' }];
    const saved = [];
    const helpers = load('save-fragment.ts', { fixture: {
      isBackgroundGenerationCancelled: () => cancelled,
      loadChatSessions: () => sessions,
      parseAndSaveResponse: async (text, id, count, index, context, options) => {
        // Simulate a setting change after the first round, before persisting the second.
        if (text === 'second') {
          if (mode === 'disable') sessions[0].proactiveDisabled = true;
          if (mode === 'delete') sessions = [];
          if (mode === 'cancel') cancelled = true;
        }
        const allowed = options.canPersist();
        if (allowed) saved.push(text);
        return { hasVisible: allowed, newCount: count, stateValues: [] };
      },
    } }, saveSource);
    const options = mode === 'manual-disabled' ? undefined : { canPersist: () => helpers.canPersistAutomaticReply('s') };
    await helpers.saveBackgroundCompletionRounds([{ text: 'first' }, { text: 'second' }], 's', 0, undefined, [], options);
    assert.deepEqual(saved, ['normal', 'manual-disabled'].includes(mode) ? ['first', 'second'] : ['first'], mode);
  }
  for (const name of ['fireFollowUp', 'fireIdleReconnect', 'fireTimedWake', 'fireMenstrualPeriodCare']) {
    const fn = followAst.statements.find(n => n.name?.text === name);
    assert.ok(fn.getText(followAst).includes('canPersist: () => canPersistAutomaticReply(session.id)'), name);
  }
  console.log('PASS: scheduled multi-round saves recheck disabled/deleted sessions and cancellation; manual replies are not blocked by the proactive switch.');
}
checkSaveCancellation().catch(error => { console.error(error); process.exitCode = 1; });
