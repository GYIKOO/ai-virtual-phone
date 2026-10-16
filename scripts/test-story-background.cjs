const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
function evaluate(source, context) {
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
}
const source = fs.readFileSync('components/story/story-app-base.tsx', 'utf8');
const ast = ts.createSourceFile('story-app-base.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map(); let auto;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes('virtualMessage: StoryMessage')) auto = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(auto);
assert.ok(!source.includes('mountedRef.current && isStoryGenerationRunActive'));
const unmount = source.slice(source.indexOf('mountedRef.current = false;'), source.indexOf('mountedRef.current = false;') + 380);
assert.ok(!unmount.includes('cancelStoryGenerationRun'), 'view unmount must not cancel the request');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
async function run(mode, invalidate) {
  let rows = mode === 'retry' ? [{ id: 'u', sessionId: 's', role: 'user', rawContent: 'original user' }, { id: 'a', sessionId: 's', role: 'assistant', rawContent: 'old answer' }] : [];
  const session = { id: 's', characterId: 'c', participantIds: ['c'], autoStartPrompt: mode === 'auto' ? 'begin' : undefined };
  let sessions = [session], complete, signal, counters = 0, savedWhileUnmounted = 0, viewed = 0, mounted = true;
  const registry = {};
  const storage = { loadStoryMessages: id => rows.filter(r => r.sessionId === id), loadStorySessions: () => sessions };
  evaluate(fs.readFileSync('lib/story-generation-runs.ts', 'utf8'), { exports: registry, require: () => storage, AbortController });
  const context = { ...registry, ...storage, exports: {}, console, Date,
    activeSessionId: 's', activeCharacterId: 'c', isGenerating: false, isReadOnly: false, ready: true,
    currentSession: session, mergingPageRef: { current: false }, mountedRef: { current: true },
    storyGlobalSettings: { streamingEnabled: false }, clearStoryStream() {}, appendStoryStreamDelta() {},
    autoStartedSessionIdsRef: { current: new Set() }, floatingChatContext: '', characters: [{ id: 'c', name: 'test' }],
    messages: rows, autoBottomLockRef: { current: false }, requestAnimationFrame: cb => cb(), scrollStoryToBottom() {},
    pushStoryMessage: row => { if (!mounted) savedWhileUnmounted++; const saved = { ...row, id: String(rows.length + 1) }; rows.push(saved); return saved; },
    replaceStoryMessages: (_, replacement) => { rows = [...replacement]; },
    updateStorySession: (_, patch) => Object.assign(session, patch),
    setMessages() {}, setStorageVersion() {}, setActiveMessageId() {}, markGenerating() {},
    refreshGenerationView: () => { if (mounted) viewed++; },
    getStoryRetryContext: list => list.slice(0, 1),
    incrementEventCounter: () => counters++, maybeRunSummarization: async () => {},
    isAbortLikeError: () => false,
    generateStoryCompletion: (_, history, options) => { signal = options.signal; return new Promise(resolve => { complete = resolve; }); },
  };
  evaluate(functions.get('handleSend') + '\n' + functions.get('handleStoryRetry') + `\nexports.send=handleSend;exports.retry=handleStoryRetry;exports.auto=${auto};`, context);
  const promise = mode === 'retry' ? context.exports.retry('a', 'edit') : mode === 'auto' ? context.exports.auto() : context.exports.send('new user', mode === 'director' ? 'director' : undefined);
  await flush(); assert.ok(registry.getGeneratingStorySessionIds().has('s'));
  mounted = false; context.mountedRef.current = false;
  assert.equal(signal.aborted, false, 'leaving the view does not abort');
  let remountNotifications = 0;
  const unsubscribe = registry.subscribeStoryGeneration(() => remountNotifications++);
  if (invalidate === 'cancel') { registry.cancelStoryGenerationRun('s'); assert.equal(signal.aborted, true); }
  if (invalidate === 'delete') sessions = [];
  if (invalidate === 'merge') session.mergedIntoSessionId = 'main';
  if (invalidate === 'edit') rows[0].rawContent = 'edited after request';
  if (mode === 'retry') assert.ok(rows.some(r => r.rawContent === 'old answer'), 'old reply retained until successful replacement');
  complete({ rawText: 'new answer', renderedText: 'new answer', storySummary: 'new facts' });
  await promise; await flush();
  if (invalidate) assert.ok(!rows.some(r => r.rawContent === 'new answer'), `${mode}/${invalidate}: stale output discarded`);
  else {
    assert.equal(rows.filter(r => r.rawContent === 'new answer').length, 1);
    assert.equal(savedWhileUnmounted, 1);
    assert.equal(rows.find(r => r.rawContent === 'new answer').storySummary, 'new facts');
    if (mode !== 'retry') assert.ok(counters > 0, 'memory side effects survive unmount');
    if (mode === 'retry') assert.ok(!rows.some(r => r.rawContent === 'old answer'));
  }
  assert.equal(viewed, 0, 'old view is not updated');
  assert.equal(registry.getGeneratingStorySessionIds().size, 0);
  assert.ok(remountNotifications > 0, 'new view can subscribe to completion and re-read persisted messages');
  unsubscribe();
}
(async () => {
  for (const mode of ['send', 'director', 'retry', 'auto']) {
    await run(mode);
    for (const invalidation of ['cancel', 'delete', 'merge']) await run(mode, invalidation);
    if (mode !== 'auto') await run(mode, 'edit');
  }
  console.log('PASS: real send/director/retry/auto-start handlers persist after unmount, retain summary/memory flow, notify remount, and reject cancelled/deleted/archived/edited-history results. API/storage/UI are controlled fixtures.');
})().catch(error => { console.error(error); process.exitCode = 1; });
