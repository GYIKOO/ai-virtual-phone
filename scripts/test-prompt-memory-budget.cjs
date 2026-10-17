const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const cache=new Map();
function load(name){if(cache.has(name))return cache.get(name);const exports={};cache.set(name,exports);
 const file=`lib/${name.slice(2)}.ts`;
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:load,console,Date});return exports;}
const {assembleBudgetedMemory,contextCapacity}=load('./prompt-memory-budget');
const {estimateStoryMessages,storyInputBudget}=load('./story-context-budget');
const {buildOfflinePromptHistory}=load('./offline-prompt-builder');
const {narrativeExcerpt,stripNarrativeTags}=load('./narrative-context');
const at=n=>new Date(Date.UTC(2026,9,1)+n*60000).toISOString();
assert.equal(stripNarrativeTags('before<thinking a="b">secret<thinking>nested</thinking>secret2</thinking><context>BODY</context>','thinking'),'before<context>BODY</context>');
assert.equal(stripNarrativeTags('body<secret>hidden','secret'),'body');
assert.equal(narrativeExcerpt('<thinking>secret</thinking><context>BODY</context><private x="1">hidden</private>','private'),'BODY');
const offline=buildOfflinePromptHistory({id:'offline'},[{id:'turn',createdAt:at(0),userContent:'u',assistantContent:'<thinking>SECRET</thinking>DETAIL',summary:'',summaryTag:'summary'}],'now');
assert.equal(offline[1].contextSummary,'DETAIL');
assert.equal(contextCapacity({storyContextTokenLimit:150000}),150000);
assert.equal(contextCapacity({storyContextTokenLimit:150000,contextTokenLimit:80000}),80000);
const config={contextTokenLimit:6000,shortTermTokenBudget:10000,longTermTokenBudget:10000,coreMemoryTokenBudget:10000};
const history=Array.from({length:20},(_,i)=>({id:`h${i}`,sessionId:'s',role:i%2?'assistant':'user',status:'sent',createdAt:at(i),content:`PROSE${i} `+'文'.repeat(2000),contextSummary:`SUMMARY${i}`}));
history.push({id:'current',sessionId:'s',role:'user',status:'sent',createdAt:at(30),content:'CURRENT_INPUT'});
const parts=Array.from({length:15},(_,i)=>({id:`m${i}`,kind:'long',timestamp:at(i),text:`MEMORY${i} `+'事'.repeat(300)}));
const snapshot=JSON.stringify(history);
for(const group of [false,true]) {
 const input={history,preset:{openai_max_context:6000,openai_max_tokens:500},appTags:['offline'],
  ...(group?{members:[{character:{id:'a'},longTermMemories:parts.map(p=>p.text).join('\n')},{character:{id:'b'},longTermMemories:'PRIVATE_B'}]}:{character:{id:'a'},longTermMemories:parts.map(p=>p.text).join('\n')})};
 const render=value=>[
  {role:'system',content:'BACKGROUND'},
  ...('members'in value?value.members.map(m=>({role:'system',content:`OWNER_${m.character.id}\n${m.longTermMemories||''}`})):[{role:'system',content:value.longTermMemories||''}]),
  ...value.history.map(m=>({role:m.role,content:m.content})),
  {role:'system',content:'TAIL_REQUIREMENT '.repeat(20)}];
 const output=assembleBudgetedMemory(input,render,config,group?[parts,[{id:'b',kind:'long',timestamp:at(0),text:'PRIVATE_B'}]]:[parts]);
 const text=output.map(m=>m.content).join('\n');
 assert.ok(estimateStoryMessages(output)<=storyInputBudget(input.preset,config.contextTokenLimit));
 assert.ok(text.includes('CURRENT_INPUT')&&text.includes('TAIL_REQUIREMENT'));
 assert.ok(text.includes('SUMMARY'),'narrative can compact rather than disappear');
 assert.ok(text.includes('MEMORY'),'individual memories can survive when whole archive cannot fit');
 if(group)assert.ok(text.includes('OWNER_b\nPRIVATE_B'));
 assert.equal(JSON.stringify(history),snapshot,'read-time packing never mutates source');
 const oversized={...input,history:[{...history.at(-1),content:'巨'.repeat(20000)}]};
 assert.throws(()=>assembleBudgetedMemory(oversized,render,config),/上下文预算/);
}
const tools=[{id:'call',sessionId:'s',role:'assistant',mediaType:'tool_call',content:'CALL',createdAt:at(1)},
 {id:'result',sessionId:'s',role:'tool',mediaType:'tool_result',content:'RESULT',createdAt:at(2)}];
const result=assembleBudgetedMemory({character:{id:'a'},history:tools,preset:null},v=>v.history.map(m=>({role:m.role,content:m.content})),config);
assert.equal(result.length,2);
console.log('PASS shared chat/group budget, tail reserve, granular recall, protected input/tools, offline summary/excerpt and nested excluded tags');
