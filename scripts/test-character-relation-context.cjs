// Real relation selection/formatting and single/group assemblers; no browser or API.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const characters = ['甲方','乙方','丙方','丁方','戊方','己方'].map((name,i)=>({id:String(i),name,persona:`CARD_${i}`,briefPersona:`BRIEF_${i}`}));
const identities = [{id:'u1',name:'本轮用户'},{id:'u2',name:'另一身份'}];
const edge = (from,to,label='友人')=>({id:`${from}-${to}-${label}`,fromCharacterId:from,toCharacterId:to,label});
const relations = [edge('0','1'),{...edge('0','1'),id:'duplicate'},edge('1','2'),edge('3','4'),edge('4','5'),edge('0','__user_identity__:u1'),edge('0','__user_identity__:u2')];
const groups = [{id:'world_default',name:'测试世界',description:'世界描述中提到己方，但不应激活。',memberIds:characters.map(c=>c.id),relations,userIdentityIds:['u1','u2'],userNodes:{},createdAt:'2026-01-01',updatedAt:'2026-01-01'}];
const original = JSON.stringify(groups);
const cache = new Map();
const mocks = {
  './kv-db': {kvGet:()=>JSON.stringify(groups),kvSet:()=>assert.fail('read-only formatter must not save'),registerKvMigration(){}},
  './character-storage': {loadCharacters:()=>characters},
  './chat-storage': {loadChatContacts:()=>[],loadChatAppSettings:()=>({timeAware:false})},
  './settings-storage': {loadUserIdentities:()=>identities,resolveUserIdentity:()=>identities[0]},
  './macro-engine': {MacroEngine:class {constructor(char,user){this.char=char;this.user=user;} expand(text){return text.replace(/\{\{char\}\}/g,this.char).replace(/\{\{user\}\}/g,this.user);}},postProcessTrim:t=>t},
  './character-time': {buildCharacterTimeContext:()=>({systemTimeZone:'UTC'}),buildGroupTimeContext:()=>({systemTimeZone:'UTC',members:[]})},
  './prompt-time': {resolvePromptTimeAware:v=>v!==false,getPromptTimestampOptionsForTimeContext:()=>({})},
  './prompt-sanitizer': {stripStateAndInnerForPrompt:t=>t},
};
function load(name) {
  if(mocks[name]) return mocks[name];
  if(cache.has(name)) return cache.get(name);
  const real = new Set(['./character-relation-context','./character-world-storage','./llm-prompt-assembler']);
  if(!real.has(name)) return {};
  const exports={}; cache.set(name,exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`lib/${name.slice(2)}.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports,require:load,console},{filename:name});
  return exports;
}
const helper=load('./character-relation-context'), store=load('./character-world-storage');
let result=store.formatCharacterRelationsForPrompt('0');
assert.equal(result.split('甲方是乙方的友人。').length-1,1);
assert.ok(!result.includes('乙方是丙方') && !result.includes('丁方是戊方'),'one hop only');
assert.ok(result.includes('世界描述中提到己方') && !result.includes('戊方是己方'),'world description is preserved, not used for activation');
assert.ok(result.includes('BRIEF_1') && !result.includes('BRIEF_0') && !result.includes('BRIEF_2'));
assert.ok(result.includes('本轮用户') && !result.includes('另一身份'));
result=store.formatCharacterRelationsForPrompt('0',{userIdentityIds:['u2']});
assert.ok(result.includes('另一身份') && !result.includes('本轮用户'),'explicit scene identity overrides character default');
result=store.formatCharacterRelationsForPrompt('0',{mentionText:'我们来聊聊丁方。'});
assert.ok(result.includes('丁方是戊方') && !result.includes('戊方是己方'));
result=store.formatCharactersRelationsForPrompt(['0','1'],{mentionText:'丁方今天怎么样？',userIdentityIds:[]});
assert.equal(result.split('当前世界观：').length-1,1);
assert.equal(result.split('甲方是乙方').length-1,1);
assert.ok(result.includes('乙方是丙方') && !result.includes('BRIEF_1') && result.includes('BRIEF_2'));
assert.ok(!result.includes('本轮用户') && !result.includes('另一身份'));
assert.equal(JSON.stringify(groups),original,'stored graph unchanged');
characters.push({id:'foreign',name:'外界人物',persona:'FOREIGN_CARD'});
groups.push({id:'foreign-world',name:'另一个世界',description:'外界描述',memberIds:['foreign'],relations:[],userIdentityIds:[],userNodes:{},createdAt:'2026-01-01',updatedAt:'2026-01-01'});
result=store.formatCharacterRelationsForPrompt('0',{mentionText:'外界人物'});
assert.ok(!result.includes('另一个世界') && !result.includes('FOREIGN_CARD'),'name mentions alone do not cross world boundaries');
groups.pop(); characters.pop();
const names=[{id:'ann',name:'Ann'},{id:'anna',name:'Anna'},{id:'x1',name:'同名'},{id:'x2',name:'同名'},{id:'a',name:'起点'}];
result=helper.selectRelatedWorldRelations({nodes:names,relations:[edge('ann','a'),edge('x1','a'),edge('x2','a')],seedIds:[],mentionText:'Anna和同名。'});
assert.equal(result.relations.length,0,'substring and ambiguous names do not activate unrelated nodes');
result=helper.selectRelatedWorldRelations({nodes:names,relations:[edge('ann','a')],seedIds:[],mentionText:'Ask ANN, please.'});
assert.equal(result.relations.length,1);
assert.equal(helper.selectRelatedWorldRelations({nodes:names,relations:[edge('ann','a','同事'),edge('ann','a','同学'),edge('a','ann','上司')],seedIds:['a'],mentionText:''}).relations.length,3,'different labels and directions survive deduplication');
const recent=helper.buildRelationMentionContext(['早已过期',...Array.from({length:24},(_,i)=>`记录${i}`)],['已选记忆丁方']);
assert.ok(!recent.includes('早已过期') && recent.includes('记录0') && recent.includes('已选记忆丁方'));
console.log('PASS: one-hop/no recursion, mentions, semantic duplicate edges, world preservation, user identity scope, short briefs, 24-message window, ambiguous/Latin name matching');

const assembler=load('./llm-prompt-assembler');
const preset={prompts:['charDescription','characterRelations','shortTermMemory'].map(identifier=>({identifier,marker:true,enabled:true,role:'system',content:''}))};
const history=[{id:'u',role:'user',content:'刚才在谈丁方。',createdAt:'2026-10-15T12:00:00Z'}];
const common={preset,regexes:[],history,userIdentity:identities[0],timeAware:false};
const joined=messages=>messages.map(m=>m.content).join('\n');
const single={...common,character:characters[0],worldBooks:[],appId:'story'};
result=joined(assembler.assemblePromptPayload(single));
assert.ok(result.includes('丁方是戊方') && !result.includes('戊方是己方'));
assert.ok(result.indexOf('甲方是乙方')<result.indexOf('刚才在谈丁方'));
result=joined(assembler.assemblePromptPayload({...single,characterRelations:null}));
assert.ok(!result.includes('甲方是乙方'),'null disables automatic lookup');
result=joined(assembler.assemblePromptPayload({...single,characterRelations:''}));
assert.ok(!result.includes('甲方是乙方'),'explicit empty text cannot restore automatic lookup');
const group={...common,members:characters.slice(0,2).map(character=>({character,worldBooks:[]})),groupName:'本轮群聊'};
result=joined(assembler.assembleGroupPromptPayload(group));
assert.equal(result.split('甲方是乙方').length-1,1,'one shared graph for group');
assert.ok(result.includes('丁方是戊方'));
assert.ok(result.indexOf('CARD_1')<result.indexOf('甲方是乙方') && result.indexOf('甲方是乙方')<result.indexOf('刚才在谈丁方'));
const disabled={...preset,prompts:preset.prompts.map(p=>p.identifier==='characterRelations'?{...p,enabled:false}:p)};
assert.ok(!joined(assembler.assembleGroupPromptPayload({...group,preset:disabled})).includes('甲方是乙方'));
assert.ok(!joined(assembler.assemblePromptPayload({...single,preset:disabled})).includes('甲方是乙方'));
const noCards={...preset,prompts:preset.prompts.map(p=>p.identifier==='charDescription'?{...p,enabled:false}:p)};
result=joined(assembler.assembleGroupPromptPayload({...group,preset:noCards}));
assert.ok(!result.includes('CARD_') && !result.includes('BRIEF_0') && !result.includes('BRIEF_1'),'disabled participant cards do not return as relationship briefs');
console.log('PASS: real single/group assembler scopes recent mentions, deduplicates group relations, keeps relations before history, respects marker and explicit-empty opt-outs');
