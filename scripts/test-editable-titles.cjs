// Exercise the actual normalizers without loading API clients or the app runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function extract(file, name, globals = {}) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `${name} exists`);
  const code = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(`${code}\n${name}`, globals);
}
const dependencies = {
  DEFAULT_IMAGE_GENERATION_SETTINGS: {}, DEFAULT_NOVELAI_PRESET: {},
  normalizeNovelAiModel: value => value, normalizeNovelAiResolution: value => value,
  normalizeNovelAiSteps: value => value, normalizeNovelAiScale: value => value,
  normalizeNovelAiSampler: value => value, normalizeNovelAiNoiseSchedule: value => value,
};
for (const name of ['normalizeOpenAiPreset', 'normalizeNovelAiPreset']) {
  const normalize = extract('lib/settings-storage.ts', name, dependencies);
  for (const title of ['', ' ', ' 新标题 ', '新标题']) assert.equal(normalize({ id: 'test', name: title }, 0).name, title);
  assert.ok(normalize({ id: 'test' }, 0).name, 'missing fields still receive defaults');
}
const normalizeStory = extract('components/story/story-settings-page.tsx', 'normalizeSettings');
const repo = { proseStyleSchemes: [{ id: 'style' }], statusSchemes: [{ id: 'status' }], theaterSchemes: [{ id: 'theater' }] };
for (const title of ['', ' ', ' 新标题 ', '新标题']) assert.equal(normalizeStory({ presetName: title }, repo).presetName, title);
assert.ok(normalizeStory({}, repo).presetName);
console.log('PASS: image presets and story preset title retain empty/space/renamed input; missing fields still default');
