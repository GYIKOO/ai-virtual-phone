// Actual action handlers with controlled model/storage boundaries; no API calls.
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const modules = {};
function load(name) {
  if (modules[name]) return modules[name];
  const exports = modules[name] = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`lib/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: path => load(path.replace('./', '')), console });
  return exports;
}
const ast = ts.createSourceFile('story.tsx', fs.readFileSync('components/story/story-app-base.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const wanted = new Set(['startDiscussion', 'closeDiscussion', 'requestDiscussionExit', 'prepareDiscussionBrief', 'confirmDiscussionBrief']);
const functions = [];
ts.forEachChild(ast, function visit(node) {
  if (ts.isFunctionDeclaration(node) && wanted.has(node.name?.text)) functions.push(node.getText(ast));
  ts.forEachChild(node, visit);
});
assert.equal(functions.length, wanted.size);
function fixture() {
  const session = { id: 's', characterId: 'a' };
  const rows = [{ id: 'u', sessionId: 's', role: 'user', kind: 'discussion', discussionId: 'd', rawContent: 'question', createdAt: '2026-10-22T12:00:00Z' }];
  const storage = { loadStorySessions: () => [session], loadStoryMessages: () => rows };
  const registry = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/story-generation-runs.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: registry, require: () => storage, AbortController });
  let resolve, reject, calls = 0;
  const c = { ...load('story-discussion'), ...storage, ...registry, Error,
    currentSession: session, activeSessionId: 's', activeCharacterId: 'a', activeDiscussionId: 'd',
    isGenerating: false, isReadOnly: false, mergingPageRef: { current: false }, storyGlobalSettings: {},
    discussionDialog: null, messages: rows, discussions: [], crypto: require('node:crypto'),
    setAutoReading() {}, refreshGenerationView() {}, showVoiceNotice() {},
    setDiscussionDialog(value) { c.discussionDialog = typeof value === 'function' ? value(c.discussionDialog) : value; },
    updateStorySession(id, patch) { assert.equal(id, 's'); Object.assign(session, patch); },
    pushStoryMessage(row) { const saved = { ...row, id: `new-${rows.length}` }; rows.push(saved); return saved; },
    markGenerating(id, value) { assert.equal(id, 's'); c.isGenerating = value; },
    isAbortLikeError: error => error.name === 'AbortError',
    loadMemoryConfig: () => ({ recentContextDetail: 'standard' }),
    generateStoryCompletion(_, history, options) {
      calls++; assert.equal(options.discussion.brief, true); assert.equal(history, rows);
      return new Promise((yes, no) => { resolve = yes; reject = no; });
    },
  };
  vm.createContext(c);
  vm.runInContext(ts.transpileModule(functions.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, c);
  return { c, rows, session, resolve: text => resolve({ rawText: text }), reject: error => reject(error), calls: () => calls };
}
(async () => {
  const f = fixture(), c = f.c;
  let pending = c.prepareDiscussionBrief('d');
  assert.equal(c.discussionDialog.loading, true); assert.equal(f.rows.length, 1);
  c.confirmDiscussionBrief(); assert.equal(f.rows.length, 1, 'loading draft cannot commit');
  f.resolve('first draft'); await pending;
  assert.equal(f.rows.length, 1, 'generated draft is not accepted yet');
  c.discussionDialog.text = 'manual edit';
  pending = c.prepareDiscussionBrief('d'); f.reject(new Error('offline')); await pending;
  assert.equal(c.discussionDialog.text, 'manual edit'); assert.equal(c.discussionDialog.error, 'offline');
  pending = c.prepareDiscussionBrief('d'); f.resolve('rerolled'); await pending;
  c.discussionDialog.text = ' reviewed edit ';
  c.confirmDiscussionBrief();
  assert.equal(f.rows.at(-1).kind, 'discussion-brief'); assert.equal(f.rows.at(-1).rawContent, 'reviewed edit');
  assert.equal(f.session.activeDiscussionId, undefined); assert.equal(c.discussionDialog, null);
  assert.equal(f.calls(), 3);

  for (const reason of ['cancel', 'edit', 'page', 'readonly']) {
    const f = fixture(), c = f.c;
    const pending = c.prepareDiscussionBrief('d');
    if (reason === 'cancel') { c.cancelStoryGenerationRun('s'); c.setDiscussionDialog(null); }
    if (reason === 'page') c.activeSessionId = 'other';
    f.resolve('draft'); await pending;
    if (reason === 'edit') f.rows[0].rawContent = 'edited after draft';
    if (reason === 'readonly') c.isReadOnly = true;
    c.confirmDiscussionBrief();
    assert.equal(f.rows.length, 1, `${reason} cannot commit draft`);
    if (reason === 'edit') assert.match(c.discussionDialog.error, /变化/);
    if (reason === 'cancel') assert.equal(c.discussionDialog, null, 'late cancelled result cannot reopen dialog');
  }
  const abandoned = fixture();
  pending = abandoned.c.prepareDiscussionBrief('d'); abandoned.resolve('discard'); await pending;
  abandoned.c.setDiscussionDialog(null);
  assert.equal(abandoned.rows.length, 1); assert.equal(abandoned.session.activeDiscussionId, 'd', 'discard returns to discussion');
  abandoned.c.closeDiscussion('d');
  assert.equal(abandoned.calls(), 1, 'plain exit does not call API');
  assert.equal(abandoned.rows.at(-1).kind, 'discussion-end');
  assert.equal(abandoned.session.activeDiscussionId, undefined);
  console.log('PASS: actual discussion actions: editable/retryable drafts, failure retains edits, confirm-only commit, cancel/late results, changed history, other page, read-only and plain exit');
})().catch(error => { console.error(error); process.exitCode = 1; });
