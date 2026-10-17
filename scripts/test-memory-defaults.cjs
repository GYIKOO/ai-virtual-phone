const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const kv = new Map(), modules = new Map();
function load(name) {
  if (name === './kv-db') return { kvGet: k => kv.get(k), kvSet: (k,v) => kv.set(k,v), registerKvMigration() {}, registerDynamicPrefix() {} };
  if (name === './idb-open') return {};
  if (modules.has(name)) return modules.get(name);
  const exports = {}; modules.set(name,exports);
  const file = `lib/${name.slice(2)}.ts`;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'), {
    compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText, {exports,require:load,window:{},console}, {filename:file});
  return exports;
}
const {DEFAULT_MEMORY_CONFIG: defaults, DEFAULT_SUMMARIZATION_PROMPT: longPrompt, DEFAULT_CORE_MEMORY_PROMPT: corePrompt} = load('./memory-types');
const {loadMemoryConfig,saveMemoryConfig} = load('./memory-storage');
const plain = value => JSON.parse(JSON.stringify(value));
const fresh = loadMemoryConfig();
assert.deepEqual(plain(fresh),plain(defaults));
assert.equal(fresh.contextTokenLimit,100000);
assert.equal(fresh.recentContextDetail,'detailed');
assert.deepEqual([fresh.shortTermTokenBudget,fresh.longTermTokenBudget,fresh.coreMemoryTokenBudget],[60000,12000,6000]);
assert.equal(fresh.summarizationRoundInterval,30);
assert.equal(fresh.coreSummarizationInterval,5);
assert.ok(fresh.autoSummarizeEnabled && fresh.autoBuildCoreEnabled && fresh.vectorRecallEnabled);
assert.ok(Object.values(fresh.shortTermAllowedSources).every(Boolean));
assert.equal(kv.size,0,'reading new defaults never writes or migrates data');

const legacy = {shortTermTokenBudget:100000,longTermTokenBudget:17000,coreMemoryTokenBudget:3500,
  storyContextTokenLimit:48000,summarizationEventInterval:80,coreSummarizationInterval:9,
  autoSummarizeEnabled:false,vectorRecallEnabled:false,shortTermAllowedSources:{story:false},
  summarizationPrompt:'用户自定义长期总结 {{events}}',coreMemoryPrompt:'用户自定义核心总结 {{events}}'};
saveMemoryConfig(legacy);
const before = [...kv.values()][0], old = loadMemoryConfig();
for (const [key,value] of Object.entries(legacy)) assert.deepEqual(plain(old[key]),plain(value),key);
assert.equal(old.contextTokenLimit,48000,'new shared default must not mask legacy capacity');
assert.equal(old.summarizationRoundInterval,undefined,'legacy events stay events');
assert.equal(old.recentContextDetail,'standard','old implicit detail stays unchanged');
assert.equal([...kv.values()][0],before,'loading old configuration is read-only');
saveMemoryConfig({...old,contextTokenLimit:150000,recentContextDetail:'compact',summarizationRoundInterval:60});
const explicit = loadMemoryConfig();
assert.equal(explicit.contextTokenLimit,150000);
assert.equal(explicit.recentContextDetail,'compact');
assert.equal(explicit.summarizationRoundInterval,60);
assert.equal(explicit.summarizationPrompt,legacy.summarizationPrompt);
saveMemoryConfig({...explicit,summarizationPrompt:longPrompt});
assert.equal(loadMemoryConfig().coreMemoryPrompt,legacy.coreMemoryPrompt,'restoring one template leaves the other intact');

for (const prompt of [longPrompt,corePrompt]) {
  for (const macro of ['char','earliest','latest','events']) assert.ok(prompt.includes(`{{${macro}}}`));
  assert.ok(!/调试|TODO|本次更新|旧版/.test(prompt));
}
assert.match(longPrompt,/300-600/);
assert.match(longPrompt,/时间范围/);
assert.match(corePrompt,/长期目标/);
assert.ok(!/订婚|结婚|配偶|恋人/.test(corePrompt));
const {rebuildPrompt} = load('./memory-rebuild-policy');
const sources = [{key:'test-source',timestamp:'2026-10-16T09:00:00.000Z',content:'已经到达车站，约定次日出发。',sourceApp:'story'}];
for (const template of [longPrompt,corePrompt]) {
  const rendered = rebuildPrompt(template,'测试角色',sources);
  assert.ok(!/\{\{(?:char|earliest|latest|events)\}\}/.test(rendered));
  assert.ok(rendered.includes(sources[0].timestamp) && rendered.includes(sources[0].content));
}
const customRendered = rebuildPrompt(legacy.summarizationPrompt,'测试角色',sources);
assert.ok(customRendered.startsWith('用户自定义长期总结'));
assert.ok(!customRendered.includes('300-600'),'custom prompt does not inherit default length instructions');
const ui = fs.readFileSync('components/memory/memory-bank-page.tsx','utf8');
const minima = ui.match(/const MEMORY_TOKEN_BUDGET_MIN[^=]*= (\{[\s\S]*?\});/)[1];
const steps = ui.match(/const MEMORY_TOKEN_BUDGET_STEP[^=]*= (\{[\s\S]*?\});/)[1];
const min = vm.runInNewContext(`(${minima})`), step = vm.runInNewContext(`(${steps})`);
for (const key of Object.keys(min)) {
  assert.equal((defaults[key]-min[key])%step[key],0,`${key}: default must be selectable`);
  assert.equal((100000-min[key])%step[key],0,`${key}: upper endpoint must be selectable`);
}
assert.ok(ui.includes('summarizationRoundInterval:DEFAULT_MEMORY_CONFIG.summarizationRoundInterval'));
const {restoreMemorySettingsSection} = load('./memory-types');
const allowedChanges = {
  context:['contextTokenLimit','recentContextDetail'],
  budgets:['shortTermTokenBudget','longTermTokenBudget','coreMemoryTokenBudget'],
  intervals:['summarizationRoundInterval','coreSummarizationInterval'],
};
for (const [section,keys] of Object.entries(allowedChanges)) {
  const original=plain(old), restored=restoreMemorySettingsSection(old,section);
  assert.deepEqual(plain(old),original,'reset must not mutate input');
  for (const key of keys) assert.deepEqual(restored[key],defaults[key]);
  for (const key of Object.keys(old).filter(key=>!keys.includes(key))) assert.deepEqual(restored[key],old[key],`${section} must preserve ${key}`);
  saveMemoryConfig(restored);
  const loaded=loadMemoryConfig();
  for (const key of keys) assert.deepEqual(loaded[key],defaults[key],'reset survives reload');
  assert.equal(loaded.summarizationPrompt,old.summarizationPrompt);
  assert.equal(loaded.coreMemoryPrompt,old.coreMemoryPrompt);
}
assert.equal((ui.match(/<MemorySectionHeading section=/g)||[]).length,3);
assert.ok(ui.includes('onCancel={() => setResetSection(null)}'));
console.log('PASS memory defaults, legacy capacity/count/detail compatibility, custom templates, read-only loading and slider endpoints');
