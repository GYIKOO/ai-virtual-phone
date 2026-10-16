// Real ensemble planner, memory ranking and prompt assembler. No API, browser or model required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { performance } = require('node:perf_hooks');
const cache = new Map();
let events = {}, turns = {}, memories = {}, vectorCalls = 0, vectorFailure = false, vectors = false;
let queried = [], embeddingQueries = [], memoryReads = 0;
const at = n => new Date(Date.UTC(2026, 9, 1) + n * 3600000).toISOString();
const mocks = {
  './macro-engine': { MacroEngine: class { expand(text) { return text; } }, postProcessTrim: text => text },
  './prompt-time': { resolvePromptTimeAware: value => value !== false, formatPromptTimestamp: value => value, getPromptTimestampOptionsForTimeContext: () => ({}) },
  './character-time': { buildCharacterTimeContext: () => ({ referenceTime: Date.parse(at(1000)), systemTimeZone:'UTC' }) },
  './recent-time-context': { buildRecentTimeContext: () => '' },
  './prompt-sanitizer': { stripStateAndInnerForPrompt: text => text },
  './settings-storage': { resolveUserIdentity: () => ({name:'用户'}), resolveAuxiliaryApiConfig: () => vectors ? {provider:'test'} : null },
  './short-term-assembler': { prepareShortTermContext: (id, app, options) => {
    assert.equal(options.tokenBudget, 0, 'collect before shared trimming');
    queried.push({id, options});
    const excluded = new Set(options.excludeStoryMessageIds.map(id => `story_projection_${id}`));
    return { recentBlocks:[], truncatedHistory:options.history, wbActivationContext:'UNRELATED_OLD_CHAT',
      unifiedRecentItems:(events[id] || []).filter(event => !excluded.has(event.entryId) && (!options.afterTimestamp || event.timestamp > options.afterTimestamp)) };
  } },
  './story-storage': { loadStoryRecallTurns: id => turns[id] || [] },
  './memory-storage': { loadMemoryEntriesByType: async (id,type) => {
    memoryReads++;
    return (memories[id] || []).filter(entry => entry.type === type);
  } },
  './calendar-storage': { getCurrentCalendarScheduleForPrompt: () => '', buildCalendarScheduleMarker: () => '' },
  './calendar-utils': { getWeekStartIso: () => '' },
  './character-world-storage': { formatCharacterRelationsForPrompt: () => '', formatCharactersRelationsForPrompt: () => '' },
};
function load(name) {
  if (mocks[name]) return mocks[name];
  if (cache.has(name)) return cache.get(name);
  const exports = {};
  cache.set(name,exports);
  const filename = `lib/${name.slice(2)}.ts`;
  const real = new Set(['./token-counter','./story-context-budget','./story-ensemble-context','./memory-service','./memory-time','./memory-embedding','./llm-prompt-assembler','./story-default-prompt','./llm-provider-adapter','./api-helpers','./generation-parameters','./character-relation-context']);
  if (!real.has(name)) return {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports,require:load,console}, {filename});
  return exports;
}
const embedding = load('./memory-embedding');
mocks['./memory-embedding'] = { ...embedding, resolveEmbeddingModel: () => 'local-test', generateEmbedding: async query => {
  vectorCalls++; embeddingQueries.push(query); return vectorFailure ? null : [1,0];
} };
const budget = load('./story-context-budget');
const builder = load('./story-ensemble-context');
const ranker = load('./memory-service');
const text = messages => messages.map(message => message.content).join('\n');
const occurrence = (value, needle) => value.split(needle).length - 1;
const event = (id, hour, content) => ({kind:'event',entryId:id,timestamp:at(hour),sourceApp:'story',sourceTag:'recent_events',text:content});
const history = (id,hour,content,role='user') => ({id,sessionId:'current',createdAt:at(hour),content,role});
const config = {shortTermTokenBudget:100000,longTermTokenBudget:100000,coreMemoryTokenBudget:100000,vectorRecallEnabled:true};
const preset = {openai_max_context:16000,openai_max_tokens:2000,prompts:
  ['charDescription','charPersonality','worldInfoBefore','memoryCore','memoryLongTerm','shortTermMemory'].map(identifier => ({identifier,marker:true,enabled:true,role:'system',content:''}))};
function options(ids, extra={}) {
  const characters = ids.map(id => ({id,name:id.toUpperCase(),persona:`PERSONA_${id}_END`,personality:''}));
  return {characters,config,excludedMessageIds:[],independent:false,tail:[],
    formatStoryMessage: message => ({...message,content:message.rawContent.replace(/<think>[\s\S]*?<\/think>/g,'')}),
    cleanText: value => value.replace(/<think>[\s\S]*?<\/think>/g,''),
    base:{character:characters[0],preset,worldBooks:[],regexes:[],history:[],appId:'story',timeAware:true,characterRelations:null,dwellingContext:null},...extra};
}
(async () => {
  const shared = event('story_projection_abc', 2, '共享车站摘要');
  events = {a:[shared],b:[shared],c:[shared],d:[]};
  const turn = {id:shared.entryId,timestamp:at(2),summary:'共享车站摘要',messages:[{id:'abc',sessionId:'abc',createdAt:at(2),role:'assistant',rawContent:'共享车站完整正文<think>不可见内容</think>'}]};
  turns = {a:[turn],b:[turn],c:[turn]};
  const input = options(['d','a','b','c']);
  input.base.history = [history('h1',3,'车站后线上交流'),history('h2',4,'当前见面接续','assistant')];
  let result = await builder.buildEnsembleStoryPrompt(input), output = text(result);
  assert.equal(occurrence(output,'共享车站完整正文'),1);
  assert.ok(!output.includes('共享车站摘要') && !output.includes('不可见内容'));
  assert.match(output,/记录归属：A、B、C/);
  assert.ok(!output.includes('记录归属：A、B、C、D'));
  assert.ok(output.indexOf('共享车站完整正文') < output.indexOf('车站后线上交流'));
  assert.ok(output.indexOf('车站后线上交流') < output.indexOf('当前见面接续'));
  assert.equal(occurrence(output,'PERSONA_d_END'),1, 'lead character is described once');
  assert.ok(output.includes(at(2)) && output.includes(at(3)) && output.includes(at(4)), 'timestamps survive assembly');
  const currentProjection = event('story_projection_h2',4,'不应重复的当前页摘要');
  for (const id of ['a','b','c']) events[id].push(currentProjection);
  input.excludedMessageIds = ['h1','h2'];
  assert.ok(!text(await builder.buildEnsembleStoryPrompt(input)).includes('不应重复'));
  const before = queried.length;
  assert.ok(!text(await builder.buildEnsembleStoryPrompt({...input,independent:true})).includes('共享车站完整正文'));
  assert.equal(queried.length,before,'independent stories do not query native memory');
  assert.ok(!text(await builder.buildEnsembleStoryPrompt({...input,afterTimestamp:at(2)})).includes('共享车站完整正文'));
  console.log('PASS: ABC → DABC shared event once, full prose replaces summary, time order, tags, retry/IF/start boundaries');

  // Reproduce an old ABC page followed by several new DABC exchanges, including
  // actual native-provider conversion. No generated response is simulated here.
  const continued = options(['d','a','b','c']);
  const chronology = ['共享车站完整正文'];
  continued.base.history = Array.from({length:8}, (_,i) => {
    const content = `DABC当前页进展_${i}_END`;
    chronology.push(content);
    return history(`progress-${i}`,10+i,content,i%2 ? 'assistant' : 'user');
  });
  continued.base.preset = {...preset,prompts:[
    {identifier:'story_output_format',role:'system',enabled:true,content:load('./story-default-prompt').DEFAULT_STORY_OUTPUT_PROMPT},
    ...preset.prompts,
  ]};
  const continuedMessages = await builder.buildEnsembleStoryPrompt(continued);
  assert.ok(continuedMessages.filter(m=>m.role==='system').some(m=>m.content.includes('【模式】')));
  assert.ok(continuedMessages.filter(m=>m.role==='assistant').every(m=>!m.content.includes('【模式】') && !m.content.includes('【时间】')));
  const adapter = load('./llm-provider-adapter');
  for (const provider of ['OpenAI','Anthropic','Google']) {
    const request = adapter.buildProviderRequest({provider,apiKey:'offline-fixture',defaultModel:'fixture'}, continued.base.preset, adapter.toLlmRequestMessages(continuedMessages));
    const body = request.body;
    const serialized = provider === 'Google'
      ? JSON.stringify([body.systemInstruction,body.contents])
      : JSON.stringify([body.system,body.messages]);
    let previous = -1;
    for (const fragment of chronology) {
      assert.equal(occurrence(serialized,fragment),1,`${provider}: each prose segment occurs once`);
      const position = serialized.indexOf(fragment);
      assert.ok(position>previous,`${provider}: older page stays before current-page progress`);
      previous = position;
    }
  }
  console.log('PASS: ABC → eight DABC messages remain ordered and unique in OpenAI/Anthropic/Gemini payloads; factory headings are system instructions, not inserted assistant prose');

  // Exact provenance + content may merge; equal words from unrelated sources must not merge.
  const c = {id:'same-source',kind:'long',timestamp:at(1),text:'同一事实',owners:['a']};
  assert.equal(budget.deduplicateStoryCandidates([c,{...c,owners:['b']}]).length,1);
  assert.equal(budget.deduplicateStoryCandidates([c,{...c,id:'other-source',owners:['b']}]).length,2);
  assert.equal(budget.deduplicateStoryCandidates([c,{...c,text:'不同理解',owners:['b']}]).length,2);
  memories = {a:[{id:'secret-a',characterId:'a',type:'long_term',content:'车站 私人约定A',sourceApp:'chat',createdAt:at(1)},
    {id:'off-topic',characterId:'a',type:'long_term',content:'火山岩地质研究',sourceApp:'chat',createdAt:at(1)}],
    b:[{id:'secret-b',characterId:'b',type:'long_term',content:'车站 私人约定B',sourceApp:'story',createdAt:at(1)}]};
  output = text(await builder.buildEnsembleStoryPrompt(input));
  assert.match(output,/记忆归属：A；来源：chat[\s\S]*?私人约定A/);
  assert.match(output,/记忆归属：B；来源：story[\s\S]*?私人约定B/);
  assert.ok(!output.includes('火山岩'), 'small archives also select relevant long-term memories');
  assert.ok(output.includes('角色之间的信息传递以剧情中实际发生的交流和经历为依据'));
  const disabled = {...input,base:{...input.base,preset:{...preset,prompts:preset.prompts.map(p => ['memoryCore','memoryLongTerm','shortTermMemory'].includes(p.identifier)?{...p,enabled:false}:p)}}};
  output = text(await builder.buildEnsembleStoryPrompt(disabled));
  assert.ok(!output.includes('私人约定') && !output.includes('共享车站完整正文'));
  console.log('PASS: private memories keep owner/source; unrelated same-text records are not merged; disabled markers stay disabled');

  // Query embedding is generated once; unembedded and mismatched legacy entries still use keywords.
  vectors = true; vectorCalls = 0;
  memories = Object.fromEntries(['a','b'].map(id => [id,[
    {id:`${id}-vector`,type:'long_term',content:'语义相关记忆',createdAt:at(1),embedding:[1,0]},
    {id:`${id}-old`,type:'long_term',content:'车站旧记录',createdAt:at(2)},
    {id:`${id}-dimension`,type:'long_term',content:'车站不同维度记录',createdAt:at(3),embedding:[1,0,0]},
  ]]));
  const rank = ranker.createStoryMemoryRanker('车站',config);
  for (const id of ['a','b']) assert.equal((await rank(id,'long_term')).length,3);
  assert.equal(vectorCalls,1);
  assert.deepEqual(embeddingQueries, ['车站']);
  vectorFailure = true;
  assert.equal((await ranker.createStoryMemoryRanker('车站',config)('a','long_term')).length,2);
  vectorFailure = false; vectors = false;
  console.log('PASS: one scene embedding, keyword recall for legacy/dimension mismatch, API failure fallback');

  // UTC instants, not string ordering, determine the chronological sequence.
  events = {a:[{...event('zone-later',1,'UTC较晚事件'),timestamp:'2026-10-01T01:30:00Z'},
    {...event('zone-earlier',0,'东八区较早事件'),timestamp:'2026-10-01T08:30:00+08:00'}],b:[]};
  turns = {}; memories = {};
  output = text(await builder.buildEnsembleStoryPrompt(options(['a','b'])));
  assert.ok(output.indexOf('东八区较早事件') < output.indexOf('UTC较晚事件'));
  // Calendar and relation switches are independent of the memoryCore marker.
  mocks['./calendar-storage'].getCurrentCalendarScheduleForPrompt = () => '今日车站日程';
  const life = options(['a','b']);
  life.base.preset = {...preset,prompts:[...preset.prompts.map(p => p.identifier==='memoryCore'?{...p,enabled:false}:p),
    {identifier:'calendarSchedule',marker:true,enabled:true,role:'system',content:''}]};
  assert.ok(text(await builder.buildEnsembleStoryPrompt(life)).includes('今日车站日程'));
  mocks['./calendar-storage'].getCurrentCalendarScheduleForPrompt = () => '';
  console.log('PASS: timezone-aware ordering; schedule permission does not depend on core-memory permission');

  // Marker placement applies to ALL cards, personalities, schedules and shared relations.
  const placed = options(['a','b']);
  placed.characters.forEach(character => { character.personality = `性格_${character.id}_{{char}}_END`; });
  placed.base.history = [history('u',20,'当前分页输入_END'),history('a',21,'当前分页回复_END','assistant')];
  placed.base.preset = {...preset,prompts:[
    ...['charDescription','charPersonality','calendarSchedule','characterRelations','memoryCore','memoryLongTerm','shortTermMemory'].map(identifier=>({identifier,marker:true,role:'system',content:'',enabled:true})),
    {identifier:'after-history',role:'system',content:'预设末尾格式要求_END',enabled:true},
  ]};
  placed.tail = [{role:'system',content:'本轮剧情设置_END'}];
  let relationOptions;
  mocks['./character-world-storage'].formatCharactersRelationsForPrompt = (ids,options) => {
    assert.equal(ids.join(','),'a,b'); relationOptions = options; return '共享关系条目_END';
  };
  mocks['./calendar-storage'].getCurrentCalendarScheduleForPrompt = (_type,id) => `日程_${id}_END`;
  output = text(await builder.buildEnsembleStoryPrompt(placed));
  for (const fragment of ['PERSONA_a_END','PERSONA_b_END','性格_a_A_END','性格_b_B_END','日程_a_END','日程_b_END','共享关系条目_END']) {
    assert.equal(occurrence(output,fragment),1,fragment);
    assert.ok(output.indexOf(fragment)<output.indexOf('当前分页输入_END'),`${fragment}: before history`);
  }
  assert.ok(output.indexOf('当前分页回复_END')<output.indexOf('预设末尾格式要求_END'));
  assert.ok(output.indexOf('预设末尾格式要求_END')<output.indexOf('本轮剧情设置_END'));
  assert.ok(relationOptions.mentionText.includes('当前分页回复_END'));
  assert.ok(!relationOptions.mentionText.includes('PERSONA_'));
  // Even with memories disabled, users retain independent control of relationship/schedule markers.
  const noMetadata = {...placed,base:{...placed.base,preset:{...placed.base.preset,prompts:placed.base.preset.prompts.map(p=>['charDescription','charPersonality','calendarSchedule','characterRelations'].includes(p.identifier)?{...p,enabled:false}:p)}}};
  output = text(await builder.buildEnsembleStoryPrompt(noMetadata));
  assert.ok(!/PERSONA_|性格_|日程_\w_END|共享关系条目_END/.test(output));
  const unbound = {...placed,base:{...placed.base,preset:null}};
  assert.ok(text(await builder.buildEnsembleStoryPrompt(unbound)).includes('PERSONA_b_END'));
  const moved = {...placed,base:{...placed.base,preset:{...placed.base.preset,prompts:[
    ...placed.base.preset.prompts.filter(p=>p.identifier!=='characterRelations'),
    placed.base.preset.prompts.find(p=>p.identifier==='characterRelations'),
  ]}}};
  output = text(await builder.buildEnsembleStoryPrompt(moved));
  assert.ok(output.indexOf('共享关系条目_END')>output.indexOf('当前分页回复_END'),'explicit preset reordering is respected');
  mocks['./character-world-storage'].formatCharactersRelationsForPrompt = () => '';
  mocks['./calendar-storage'].getCurrentCalendarScheduleForPrompt = () => '';
  console.log('PASS: all ensemble cards/traits/schedules/shared relations follow preset positions and switches; current history precedes tail requirements; no card text activates relations');

  // Stress the real assembler with character count and private history growth.
  for (const count of [2,4,8,16,32]) {
    const ids = Array.from({length:count},(_,i)=>`p${i}`);
    events = {}; turns = {}; memories = {};
    const common = Array.from({length:80},(_,i)=>event(`shared-${i}`,i,`共同事件${i}：`+'生活经历'.repeat(50)));
    for (const id of ids) {
      events[id] = [...common,...Array.from({length:150},(_,i)=>event(`${id}-${i}`,i,`${id}私人近期${i}：`+'个人经历'.repeat(70)))];
      memories[id] = Array.from({length:60},(_,i)=>({id:`${id}-m${i}`,type:i<4?'core':'long_term',sourceApp:'chat',createdAt:at(i),content:`车站 ${id}重要事实${i}：`+'个人经历'.repeat(40)}));
    }
    const stress = options(ids);
    stress.base.history = [history('latest-user',200,'车站此刻的新输入'), history('latest-assistant',201,'当前剧情最新回复','assistant')];
    stress.tail = [{role:'user',content:'本轮导演指令：车站会合'}];
    const readsBefore = memoryReads;
    const started = performance.now();
    const messages = await builder.buildEnsembleStoryPrompt(stress);
    const elapsed = performance.now() - started;
    const tokens = budget.estimateStoryMessages(messages);
    assert.ok(tokens <= budget.storyInputBudget(preset));
    assert.ok(text(messages).includes('车站此刻的新输入') && text(messages).includes('当前剧情最新回复'));
    assert.equal(occurrence(text(messages),'本轮导演指令：车站会合'),1);
    for(let i=0;i<80;i++) assert.ok(occurrence(text(messages),`共同事件${i}：`)<=1);
    console.log(`PASS: ${count} participants, ${count*230} recent candidates, estimated input ${tokens}/${budget.storyInputBudget(preset)} tokens`);
    if (process.env.FLOAT_STORY_PROFILE === '1') {
      console.log(`PROFILE: ${count} participants, ${elapsed.toFixed(1)} ms, ${memoryReads-readsBefore} memory reads (in-memory fixtures; excludes IndexedDB, native timeline collection and network)`);
      const wide = {...stress,base:{...stress.base,preset:{...preset,openai_max_context:100000}}};
      const wideStarted = performance.now();
      const wideMessages = await builder.buildEnsembleStoryPrompt(wide);
      const wideElapsed = performance.now()-wideStarted;
      assert.ok(budget.estimateStoryMessages(wideMessages)<=budget.storyInputBudget(wide.base.preset));
      console.log(`PROFILE: ${count} participants at 100K capacity, ${wideElapsed.toFixed(1)} ms, input ${budget.estimateStoryMessages(wideMessages)} tokens (same fixture limitations)`);
    }
  }
  // Fallback summary is whole, and immutable content failure happens before any API call.
  const huge = {id:'huge',kind:'recent',owners:['a'],timestamp:at(1),text:'正文'.repeat(10000),summary:'完整已有摘要'};
  const render = selected => [{role:'system',content:selected.map(item=>item.text).join('\n')}];
  const packed = budget.packStoryContext({candidates:[huge],inputBudget:200,limits:{recent:200,long:0,core:0},render});
  assert.equal(packed.selected[0].text,'完整已有摘要');
  assert.throws(()=>budget.packStoryContext({candidates:[],inputBudget:20,limits:{recent:20,long:0,core:0},render:()=>[{role:'system',content:'必需设定'.repeat(100)}]}),/超过上下文预算/);
  const calls = vectorCalls;
  const oversized = options(['a','b'],{tail:[{role:'user',content:'不能删除的本轮输入'.repeat(20000)}]});
  await assert.rejects(builder.buildEnsembleStoryPrompt(oversized),/超过上下文预算/);
  assert.equal(vectorCalls,calls);
  assert.equal(budget.storyInputBudget({...preset,openai_max_context:100000}),Math.floor((100000-2000)*0.85));
  assert.equal(budget.storyInputBudget({...preset,openai_max_context:100000},32768),Math.floor((32768-2000)*0.85),'explicit existing limits are preserved');
  assert.equal(budget.storyInputBudget({...preset,openai_max_context:1000000}),Math.floor((100000-2000)*0.85));
  assert.equal(budget.storyInputBudget({...preset,openai_max_context:1000000},150000),Math.floor((150000-2000)*0.85));
  assert.equal(budget.storyInputBudget(preset,8000),5100);
  assert.equal(budget.storyInputBudget({...preset,openai_max_context:1000,openai_max_tokens:2000}),0);
  const oldHistory = options(['a','b']);
  oldHistory.base.history = [history('old',0,'旧正文'.repeat(10000),'assistant'),history('u',4,'现在用户输入'),history('a',5,'现在角色回复','assistant')];
  oldHistory.historySummaries = new Map([['old','旧页既有摘要']]);
  oldHistory.config = {...config,shortTermTokenBudget:1000};
  const beforeHistory = JSON.stringify(oldHistory.base.history);
  output = text(await builder.buildEnsembleStoryPrompt(oldHistory));
  assert.ok(output.includes('旧页既有摘要') && !output.includes('旧正文'));
  assert.equal(JSON.stringify(oldHistory.base.history),beforeHistory,'read selection never edits stored/source messages');
  const worldbook = options(['a','b']);
  worldbook.base.worldBooks = [{entries:[{constant:true,disable:false,content:'不可删减世界书'.repeat(20000),position:0}]}];
  await assert.rejects(builder.buildEnsembleStoryPrompt(worldbook),/超过上下文预算/);
  console.log('PASS: summary fallback, oversized mandatory input fails locally, no silent deletion or network request');
})().catch(error=>{console.error(error);process.exitCode=1;});
