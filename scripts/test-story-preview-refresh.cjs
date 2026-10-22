const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const panelText = fs.readFileSync('components/debug-prompt-panel.tsx', 'utf8');
const ast = ts.createSourceFile('panel.tsx', panelText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findFunction(root, name) {
  let found;
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(root);
  assert.ok(found, name);
  return found;
}
const handlerText = findFunction(ast, 'handleStoryPreview').getText(ast);
const selection = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/story-preset-selection.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { exports: selection });
const oldPage = { id: 'page', characterId: 'A', settings: { enabledPresetPromptIds: ['old'] }, contextExcludedTags: 'old-tag' };
let latestPage = { ...oldPage, settings: { enabledPresetPromptIds: ['old', 'new'] }, contextExcludedTags: 'new-tag', participantIds: ['A', 'B'] };
let latestPreset = { name: 'test', prompts: ['old', 'new'].map(identifier => ({ identifier, enabled: true, content: identifier })),
  prompt_order: ['old', 'new'].map(identifier => ({ identifier, enabled: true })) };
let shown, requestOptions, deferred;
const context = {
  storySessionOptions: [oldPage], storySessionId: 'page', storyOwnerOptions: [], storyOwnerKey: 'single:A',
  storyPreviewRevisionRef: { current: 0 },
  loadStorySessions: () => latestPage ? [latestPage] : [],
  loadStoryMessages: () => [], loadStoryGlobalSettings: () => ({}),
  previewStoryPromptPayload: async (_, history, options) => {
    requestOptions = options;
    const effective = selection.selectStoryPresetPrompts(latestPreset, options.settings?.enabledPresetPromptIds);
    const result = { messages: effective.prompts.filter(p => p.enabled).map(p => p.content) };
    return deferred ? await deferred(result) : result;
  },
  setError: error => { if (error) context.lastError = error; }, setLoading() {},
  setStoryResult: value => { shown = value; }, setExpandedIdx() {}, setBadgesShownIdx() {},
  requestAnimationFrame: callback => callback(), scrollRef: { current: null }, console,
};
vm.createContext(context);
vm.runInContext(ts.transpileModule(handlerText, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
async function main() {
  await context.handleStoryPreview();
  assert.deepEqual(shown.messages, ['old', 'new'], 'new locally enabled entry must appear without remounting viewer');
  assert.equal(requestOptions.contextExcludedTags, undefined);
  assert.equal(requestOptions.sessionContextExcludedTags, 'new-tag');
  assert.deepEqual(requestOptions.participantIds, ['A', 'B']);
  latestPage = { ...latestPage, settings: { enabledPresetPromptIds: ['new'] } };
  latestPreset = { ...latestPreset, prompts: latestPreset.prompts.map(p => p.identifier === 'new' ? { ...p, content: 'edited-body' } : p) };
  await context.handleStoryPreview();
  assert.deepEqual(shown.messages, ['edited-body'], 'latest body and switches, not cached selector object');
  latestPage = { ...latestPage, settings: {} };
  await context.handleStoryPreview();
  assert.deepEqual(shown.messages, ['old', 'edited-body'], 'reset follows shared preset');
  let release;
  deferred = result => new Promise(resolve => { release = () => resolve(result); });
  const pending = context.handleStoryPreview();
  context.storyPreviewRevisionRef.current++;
  shown = null;
  release(); await pending;
  assert.equal(shown, null, 'old in-flight result must not overwrite invalidated preview');
  deferred = null;
  latestPage = null;
  shown = { messages: ['old-result'] };
  await context.handleStoryPreview();
  assert.equal(shown, null, 'deleted page must not generate from cached selector');
  console.log('PASS: real preview handler reads latest local switches, text, participants and exclusions; reset, deletion and stale async results.');

  // Execute the actual subscription effect and verify cleanup, not just string presence.
  let effect;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes('const refreshStoryPreview')) effect = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(effect);
  const listeners = new Map();
  let version = 0;
  context.setSessionsVersion = fn => { version = fn(version); };
  context.window = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const cleanup = vm.runInContext(ts.transpileModule(`(${effect.getText(ast)})()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  for (const event of ['story-owner-settings-updated', 'story-session-settings-updated', 'settings-presets-updated', 'settings-bindings-updated']) {
    shown = { messages: ['stale'] };
    assert.ok(listeners.has(event));
    listeners.get(event)();
    assert.equal(shown, null);
  }
  assert.equal(version, 4);
  cleanup(); assert.equal(listeners.size, 0);

  // Compare the real preview/generation entry points up to their shared assembler.
  // Stop there deliberately: no network request, fixture mutation or API call.
  const engineText = fs.readFileSync('lib/story-engine.ts', 'utf8');
  const engineAst = ts.createSourceFile('engine.ts', engineText, ts.ScriptTarget.Latest, true);
  const entryNames = ['previewStoryPromptPayload', 'generateStoryCompletion'];
  const entryText = [...entryNames, 'selectDiscussionPreset'].map(name => findFunction(engineAst, name).getText(engineAst)).join('\n');
  const stop = new Error('ASSEMBLY_BOUNDARY');
  let selected;
  const engineContext = {
    exports: {}, loadCharacters: () => [{ id: 'A' }], createCalendarSync: () => ({}), yieldStoryPreparation: async () => {},
    resolveStoryConfigs: () => ({ preset: latestPreset }), selectStoryPresetPrompts: selection.selectStoryPresetPrompts,
    DEFAULT_STORY_FOLD_TAGS: '', DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS: '',
    buildStoryPromptMessages: async (_, history, preset) => { selected = preset; throw stop; },
  };
  vm.runInNewContext(ts.transpileModule(entryText, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, engineContext);
  for (const ids of [['old', 'new'], ['new'], [], undefined]) {
    const outputs = [];
    for (const name of entryNames) {
      await assert.rejects(engineContext.exports[name]('A', [], { settings: { enabledPresetPromptIds: ids } }), error => error === stop);
      outputs.push(JSON.stringify(selected));
    }
    assert.equal(outputs[0], outputs[1], 'actual generation and preview select identical current preset entries');
  }
  console.log('PASS: subscription invalidation/cleanup; real generation and preview select identical presets for enable, disable, empty and default states (stopped before model calls).');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
