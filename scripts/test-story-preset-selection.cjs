const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, deps={}) {
  const exports={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports,require:name=>deps[name]||{},console});
  return exports;
}
const selection=load('lib/story-preset-selection.ts');
const assembler=load('lib/llm-prompt-assembler.ts',{
  './macro-engine':{MacroEngine:class{expand(value){return value;}},postProcessTrim:value=>value},
  './prompt-time':{resolvePromptTimeAware:()=>false,getPromptTimestampOptionsForTimeContext:()=>({})},
  './character-time':{buildCharacterTimeContext:()=>({})},
});
const prompt=(identifier,enabled,marker=false)=>({identifier,enabled,marker,content:marker?'':`TEXT_${identifier}`,role:'system'});
const preset={prompts:[prompt('a',false),prompt('b',true),prompt('charDescription',true,true)],prompt_order:[{identifier:'b',enabled:false},{identifier:'a',enabled:true},{identifier:'charDescription',enabled:false}]};
const original=JSON.stringify(preset);
const content=p=>assembler.assemblePromptPayload({character:{id:'x',name:'x',persona:'CARD_TEXT'},history:[],preset:p,worldBooks:[],regexes:[],appId:'story',timeAware:false}).map(m=>m.content).join('\n');
assert.equal(selection.selectStoryPresetPrompts(preset),preset);
assert.equal(selection.isStoryPresetPromptEnabled(preset,preset.prompts[0]),true);
assert.equal(selection.isStoryPresetPromptEnabled(preset,preset.prompts[1]),false);
assert.equal(content(preset),'TEXT_a');
assert.equal(content(selection.selectStoryPresetPrompts(preset,['b'])),'TEXT_b','local choice overrides both enabled fields');
assert.equal(content(selection.selectStoryPresetPrompts(preset,[])),'');
assert.equal(content(selection.selectStoryPresetPrompts(preset,['charDescription'])),'','markers are not overridden');
const noOrder={...preset,prompt_order:undefined};
assert.ok(content(selection.selectStoryPresetPrompts(noOrder,['a'])).includes('TEXT_a'));
assert.equal(JSON.stringify(preset),original,'shared preset stays unchanged');
assert.equal(content(selection.selectStoryPresetPrompts(preset,undefined)),'TEXT_a','reset follows defaults again');
assert.equal(selection.selectStoryPresetPrompts(null,[]),null);
console.log('PASS: real assembled request honors local text switches, order overrides, marker isolation, reset, empty selection and shared-preset immutability');
