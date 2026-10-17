// Real story/offline stores, timeline selection, Story engine and final prompt assembly. No network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const {execFileSync}=require('node:child_process');
const sourceOf=file=>process.env.FLOAT_CROSS_MODE_BASE_REF
  ? execFileSync('git',['show',`${process.env.FLOAT_CROSS_MODE_BASE_REF}:${file}`],{encoding:'utf8'})
  : fs.readFileSync(file,'utf8');
const { indexedDB, IDBKeyRange } = require(require.resolve('fake-indexeddb', { paths: [process.env.FLOAT_TEST_DEPS || process.cwd()] }));
const Dexie = require('dexie');
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
const modules = new Map(), kv = new Map();
let referenceTime;
class ClockDate extends Date {
  constructor(...args) { if (args.length) super(...args); else super(referenceTime ?? Date.now()); }
  static now() { return referenceTime ?? Date.now(); }
}
const at = n => new Date(Date.UTC(2026, 9, 15, n)).toISOString();
const eventToken = id => `EVENT${id.replace(/-/g,'')}`;
const characters = ['a','b','c','z'].map(id => ({id, name:id.toUpperCase(), persona:`CARD_${id}`}));
const sessions = [
  {id:'direct', contactId:'a'}, {id:'other-direct', contactId:'b'},
  {id:'group', isGroup:true, participantIds:['a','b'], groupName:'AB'},
  {id:'foreign', isGroup:true, participantIds:['z'], groupName:'Z'},
];
const chatRows = new Map();
let config = {shortTermTokenBudget:100000, longTermTokenBudget:1000, coreMemoryTokenBudget:1000};
const preset = {id:'preset',openai_max_context:100000,openai_max_tokens:1000,prompts:[
  {identifier:'charDescription',marker:true,enabled:true,role:'system'},
  {identifier:'shortTermMemory',marker:true,enabled:true,role:'system'},
]};
const emptyStore = new Proxy({}, { get: () => () => [] });
const mocks = {
  './calendar-sync':{createCalendarSync:()=>undefined,calendarSyncPrompt:()=>''},
  dexie:Dexie,
  './kv-db': {hydrateKvDb:async()=>{}, registerKvMigration(){},registerDynamicPrefix(){}, kvGet:k=>kv.get(k),kvSet:(k,v)=>kv.set(k,v),kvRemove:k=>kv.delete(k)},
  './character-storage': {loadCharacters:()=>characters},
  './chat-storage': {loadChatSessions:()=>sessions,loadChatMessages:id=>chatRows.get(id)||[], isReadingDiscussMessage:()=>false,
    isSystemInstructionMessage:msg=>msg.role==='system'&&msg.mediaType==='system_instruction',
    getSystemInstructionPromptContent:content=>content,loadChatAppSettings:()=>({timeAware:true})},
  './settings-storage': {loadBindingConfig:()=>({characterBindings:[]}),resolveBinding:()=>({apiConfigId:'api',presetId:'preset'}),
    loadApiConfigs:()=>[{id:'api',defaultModel:'test'}],loadPresets:()=>[preset],loadRegexes:()=>[],loadWorldBooks:()=>[],resolveUserIdentity:()=>({id:'u',name:'用户'})},
  './memory-storage': {loadMemoryConfig:()=>config},
  './memory-service': {retrieveMemoriesForPrompt:async()=>[],retrieveCoreMemoriesForPrompt:async()=>[],createStoryMemoryRanker:()=>async()=>[]},
  './memory-injector': {formatLongTermMemories:()=>'',formatCoreMemories:()=>''},
  './calendar-storage': {getCurrentCalendarScheduleForPrompt:()=>'',buildCalendarScheduleMarker:()=>''},
  './character-world-storage': {formatCharactersRelationsForPrompt:()=>'',formatCharacterRelationsForPrompt:()=>''},
  './chat-engine': {ChatEngineError:Error,previewMessagesForApi:(_a,_p,m)=>m},
};
const real = new Set(['prompt-memory-budget','narrative-context','memory-context-policy','story-storage','story-tag-settings','chat-offline-storage','short-term-assembler','story-engine',
  'story-instructions','story-constraints','story-context-budget','story-ensemble-context','story-preset-selection','story-preparation',
  'llm-prompt-assembler','story-default-prompt','macro-engine','character-time','prompt-time','recent-time-context',
  'prompt-sanitizer','state-value-parser','token-counter','character-relation-context','memory-rounds']);
function load(name) {
  if (mocks[name]) return mocks[name];
  if (modules.has(name)) return modules.get(name);
  if (!real.has(name.slice(2))) return emptyStore;
  const exports = {}; modules.set(name,exports);
  const filename=`lib/${name.slice(2)}.ts`;
  vm.runInNewContext(ts.transpileModule(sourceOf(filename),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports,require:load,window:{},indexedDB,IDBKeyRange,console,Date:ClockDate,structuredClone,setTimeout,clearTimeout,AbortController},{filename});
  return exports;
}
const text = messages => messages.map(m=>m.content).join('\n');
const count = (haystack,needle)=>haystack.split(needle).length-1;
function loadChatBuilders(short, assembler) {
  const globals={exports:{},console,Date,
    ...mocks['./calendar-sync'],
    ...mocks['./chat-storage'],...mocks['./character-storage'],...mocks['./settings-storage'],...mocks['./memory-storage'],
    ...mocks['./memory-service'],...mocks['./memory-injector'],...mocks['./calendar-storage'],...short,...assembler,
    ...load('./character-time'),...load('./prompt-time'),...load('./prompt-memory-budget'),
    ChatEngineError:Error,resolveChatAccountUserIdentity:()=>({id:'u',name:'用户'}),
    mergeAppTags:(tags,_profile,id)=>tags||[id],getEnabledTools:()=>[],nativeToolProtocolForConfig:()=>false,
    applyVisionImagePromptLimit:rows=>rows,resolveVisionImagePromptLimit:()=>0,
    buildMusicLocalMacro:async()=>'',buildMusicCloudMacro:async()=>'',getWeekStartIso:()=>'',isNeteaseConfigured:()=>false,
    runChatPluginTransform:async(_name,input)=>input,buildChatPluginPromptFragments:()=>'',formatCustomAppChatDirectivesForPrompt:()=>'',buildScreenEffectPromptHint:()=>'',
    buildChatBilingualInstruction:()=>'',buildOfflineBilingualInstruction:()=>'',getStatusRegionConfig:()=>({}),
    resolveStatusRegionSection:()=>'',resolveStatusRegionExampleLine:()=>'',resolveStatusRegionComposition:()=>'',resolveStatusRegionFullExample:()=>'',
    getLatestCharacterStateValues:()=>null,getCustomStickerNames:()=>'',getCustomStickerExample:()=>'',loadCustomStickers:()=>[],
    formatToolsForPrompt:()=>'',formatGroupToolsForPrompt:()=>'',buildGroupRosterMacro:()=>'',
    isAutomaticChatGeneration:()=>false,findUserAvatarChangeIntent:()=>null,resolveMeetingInviteCardConfig:()=>({enabled:false,remarkEnabled:false}),
    appendEmptyGenerateGuardMessage:()=>{},maybeBuildStatusInjection:()=>'',
  };
  for (const [file,names] of [['lib/chat-engine.ts',['buildChatPromptMessages']],['lib/group-chat-engine.ts',['annotateGroupHistory','buildGroupChatPromptMessages']]]) {
    const source=sourceOf(file), tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
    const nodes=tree.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text));
    assert.equal(nodes.length,names.length);
    vm.runInNewContext(ts.transpileModule(nodes.map(n=>n.getText(tree)).join('\n'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,globals,{filename:file});
  }
  return globals.exports;
}
(async()=>{
  const db = new Dexie('AiPhoneStoryDB');
  db.version(1).stores({sessions:'id, characterId, updatedAt',messages:'id, sessionId, createdAt'});
  const page=(id,ids,extra={})=>({id,characterId:ids[0],ownerType:ids.length>1?'group':'single',ownerId:id,
    participantIds:ids,branchId:'main',createdAt:at(0),updatedAt:at(0),...extra});
  const storyRow=(id,sessionId,hour,extra={})=>({id,sessionId,role:'assistant',rawContent:`PROSE_${id}`,storySummary:eventToken(id),createdAt:at(hour),...extra});
  await db.sessions.bulkPut([page('single',['a']),page('multi',['b','a']),page('solo-b',['b']),page('new-group',['c','a','b']),
    page('foreign-story',['z']),page('if',['a'],{independentStory:true}),page('archive',['a'],{mergedIntoSessionId:'single'}),
    page('no-summary',['a'],{contextExcludedTags:'thinking,private'})]);
  await db.messages.bulkPut([storyRow('single','single',5),storyRow('multi','multi',6),storyRow('foreign','foreign-story',7),
    storyRow('if','if',8),storyRow('archive','archive',9),
    {id:'director',sessionId:'multi',role:'user',kind:'director',rawContent:'SECRET_DIRECTOR',createdAt:at(5)},
    storyRow('multi-detail','multi',10,{rawContent:'<thinking>SECRET_THINK</thinking><context>DETAIL_SHARED_SCENE</context>',storySummary:'AB见过面'})]);
  const story=load('./story-storage'); await story.hydrateStoryStorage();
  const offline=load('./chat-offline-storage');
  for(const [id,hour] of [['direct',3],['group',4]]) {
    kv.set(`ai_phone_chat_offline_turns:${id}`,JSON.stringify([{id:`offline-${id}`,sessionId:id,userContent:`OFFLINE_USER_${id}`,
      assistantContent:`OFFLINE_PROSE_${id}`,summary:eventToken(`offline-${id}`),summaryTag:'summary',createdAt:at(hour)}]));
  }
  for(const [id,hour] of [['direct',1],['group',2],['foreign',7]]) chatRows.set(id,[{id:`online-${id}`,sessionId:id,role:'assistant',senderName:'A',senderCharacterId:'a',content:eventToken(`online-${id}`),createdAt:at(hour)}]);
  const short=load('./short-term-assembler'), assembler=load('./llm-prompt-assembler'), engine=load('./story-engine');
  const chatBuilders=loadChatBuilders(short,assembler);
  const history = id=>story.loadStoryMessages(id);
  const sources=['online-direct','online-group','offline-direct','offline-group','single','multi'];
  const sourceCount=(output,source)=>count(output,eventToken(source)) + (source.startsWith('offline-')
    ? count(output,`OFFLINE_PROSE_${source.slice(8)}`) : ['single','multi'].includes(source)?count(output,`PROSE_${source}`):0);
  const storyOptions=(id,ids)=>({sessionId:id,participantIds:ids,globalSettings:{timeAware:true},sessionContextExcludedTags:'think,thinking,story_theater'});
  const consumers={
    'online-direct':()=>assembleChat(false,false), 'online-group':()=>assembleChat(true,false),
    'offline-direct':()=>assembleChat(false,true), 'offline-group':()=>assembleChat(true,true),
    'single':async()=> (await engine.previewStoryPromptPayload('a',history('single'),storyOptions('single',['a']))).messages,
    'multi':async()=> (await engine.previewStoryPromptPayload('b',history('multi'),storyOptions('multi',['b','a']))).messages,
  };
  async function assembleChat(group,isOffline) {
    const id=group?'group':'direct';
    const current=isOffline?offline.loadChatOfflineTurns(id).flatMap(t=>[
      {id:`${t.id}-u`,sessionId:id,role:'user',content:t.userContent,createdAt:t.createdAt},
      {id:`${t.id}-a`,sessionId:id,role:'assistant',content:t.assistantContent,createdAt:t.createdAt},
    ]):chatRows.get(id);
    const options={appTags:[group?'group_chat':'chat',isOffline?'offline':'text'],excludeOfflineSessionId:isOffline?id:undefined};
    const builder=group?chatBuilders.buildGroupChatPromptMessages:chatBuilders.buildChatPromptMessages;
    return (await builder(sessions.find(s=>s.id===id),current,options)).llmMessages;
  }
  let edges=0;
  for(const [target,build] of Object.entries(consumers)) {
    const output=text(await build());
    for(const source of sources) {
      if(source===target) continue;
      assert.equal(sourceCount(output,source),1,`${source} -> ${target}: one prose OR summary in final request`); edges++;
    }
    for(const secret of [eventToken('online-foreign'),eventToken('foreign'),'PROSE_foreign',eventToken('if'),'PROSE_if',eventToken('archive'),'PROSE_archive','SECRET_DIRECTOR','SECRET_THINK']) {
      assert.ok(!output.includes(secret),`${target}: isolation of ${secret}`);
    }
  }
  const single=text(await consumers.single());
  assert.equal(count(single,'DETAIL_SHARED_SCENE'),1,'single scene receives detail absent from group summary');
  assert.ok(single.indexOf('PROSE_single')<single.indexOf('PROSE_multi'),'single and group events ordered chronologically');
  const cSolo=(await engine.previewStoryPromptPayload('c',[],storyOptions('new-c',['c']))).messages;
  assert.ok(!text(cSolo).includes('DETAIL_SHARED_SCENE'),'nonparticipant solo cannot read group event');
  const joined=text((await engine.previewStoryPromptPayload('c',[],storyOptions('new-group',['c','a','b']))).messages);
  assert.equal(count(joined,'DETAIL_SHARED_SCENE'),1,'joined ensemble deduplicates shared experience');
  const isolated=text((await engine.previewStoryPromptPayload('a',[],{...storyOptions('if',['a']),storyMemory:{independent:true}})).messages);
  assert.ok(!isolated.includes('PROSE_multi')&&!isolated.includes(eventToken('online-direct')),'IF has no native recall');
  const retry=text((await engine.previewStoryPromptPayload('b',[],storyOptions('multi',['b','a']))).messages);
  assert.ok(!retry.includes('DETAIL_SHARED_SCENE'),'retry excludes saved current-page suffix');
  config={...config,shortTermAllowedSources:{story:false}};
  for(const target of ['online-direct','online-group','offline-direct','offline-group','single']) {
    const output=text(await consumers[target]());
    assert.ok(!output.includes('PROSE_multi')&&!output.includes(eventToken('multi'))&&!output.includes('DETAIL_SHARED_SCENE'),`${target}: story source switch respected`);
  }
  config={...config,shortTermAllowedSources:{},shortTermTokenBudget:500};
  const large=story.pushStoryMessage({sessionId:'multi',role:'assistant',rawContent:'LONG_SCENE '.repeat(2000),storySummary:'COMPACTSCENE',createdAt:at(11)});
  const bounded=text(await consumers.single());
  assert.ok(bounded.includes('COMPACTSCENE')&&!bounded.includes('LONG_SCENE'),'single cross-page prose falls back to summary under budget');
  assert.equal(story.loadStoryMessages('multi').find(m=>m.id===large.id).rawContent,'LONG_SCENE '.repeat(2000),'recall never rewrites stored prose');
  for (const disabled of ['chat','group_chat']) {
    config={...config,shortTermTokenBudget:100000,shortTermAllowedSources:{[disabled]:false}};
    for (const target of ['single','multi']) {
      const output=text(await consumers[target]());
      for (const mode of ['online','offline']) {
        const excluded=`${mode}-${disabled==='chat'?'direct':'group'}`;
        const retained=`${mode}-${disabled==='chat'?'group':'direct'}`;
        assert.equal(sourceCount(output,excluded),0,`${target}: ${disabled} excludes ${excluded}`);
        assert.equal(sourceCount(output,retained),1,`${target}: ${disabled} leaves ${retained}`);
      }
    }
  }
  config={...config,shortTermAllowedSources:{}};
  offline.preserveChatOfflineSummaries('group');
  kv.set('ai_phone_chat_offline_turns:group','[]');
  const migrated=offline.loadChatOfflineProjectionEntries('a').find(e=>e.id==='chat_offline_migrated_offline-group');
  assert.equal(migrated.groupSessionId,'group','migrated group summaries keep source ownership');
  assert.ok(!offline.loadChatOfflineProjectionEntries('a',{afterTimestamp:at(5)}).some(e=>e.id===migrated.id),'migrated summaries respect new-page time boundary');
  assert.equal(count(text(await consumers.single()),eventToken('offline-group')),1,'migrated summary remains readable once');
  story.updateStorySession('no-summary',{contextExcludedTags:'thinking,private'});
  story.pushStoryMessage(storyRow('no-summary','no-summary',12,{storySummary:'',rawContent:'<thinking x="1">HIDDEN_REASON<thinking>INNER</thinking>HIDDEN_END</thinking><context>VISIBLE_UNSUMMARIZED</context><private>HIDDEN_PRIVATE</private>'}));
  for(const target of ['online-direct','online-group','offline-direct','offline-group','single','multi']) {
    const output=text(await consumers[target]());
    assert.ok(output.includes('VISIBLE_UNSUMMARIZED'),`${target}: missing summary uses saved body`);
    assert.ok(!/HIDDEN_REASON|HIDDEN_END|HIDDEN_PRIVATE/.test(output),`${target}: source exclusions survive full/excerpt selection`);
  }
  assert.equal(story.loadStoryMessages('no-summary')[0].storySummary,'','read-time excerpt is not saved as summary');
  chatRows.get('direct').push({id:'failed',sessionId:'direct',role:'assistant',status:'failed',createdAt:at(13),content:'FAILED_REPLY'});
  assert.ok(!short.loadNativeTimeline('a').some(row=>row.content.includes('FAILED_REPLY')),'failed generation is not summary material');
  console.log(`PASS: ${edges} directed cross-mode edges reach final prompts once; participant/IF/archive/retry/source-switch isolation, detailed single recall and budget fallback`);

  // Returning to an old single page after newer shared scenes and online/offline
  // conversations must update retrieval and macros, not merely display order.
  referenceTime = Date.parse('2026-10-16T20:00:00+08:00');
  characters[0].timeZone = 'Asia/Shanghai';
  config = {...config,shortTermTokenBudget:60000,contextTokenLimit:100000,recentContextDetail:'detailed'};
  const oldTime='2026-10-15T00:03:00+08:00', newTime='2026-10-16T20:00:00+08:00';
  const old={id:'old-single',sessionId:'single',role:'assistant',rawContent:'OLD_SCENE_UNCUT',storySummary:'OLD_SUMMARY',createdAt:oldTime};
  const fresh={id:'return-input',sessionId:'single',role:'user',rawContent:'RETURN_NEW_INPUT',createdAt:newTime};
  story.replaceStoryMessages('single',[old,fresh]);
  story.replaceStoryMessages('multi',[{id:'new-multi',sessionId:'multi',role:'assistant',rawContent:'NEW_MULTIPERSON_PROGRESS',
    storySummary:'NEW_MULTI_SUMMARY',createdAt:'2026-10-16T18:00:00+08:00'}]);
  story.replaceStoryMessages('no-summary',[]);
  for(const id of ['direct','group']) {
    kv.set('ai_phone_chat_offline_turns:'+id,JSON.stringify([{id:'recent-offline-'+id,sessionId:id,
      userContent:'OFFLINE_NEW_USER_'+id,assistantContent:'OFFLINE_NEW_PROGRESS_'+id,summary:'OFFLINE_NEW_SUMMARY_'+id,
      createdAt:'2026-10-16T19:00:00+08:00'}]));
    chatRows.set(id,[{id:'new-online-'+id,sessionId:id,role:'assistant',senderName:'A',senderCharacterId:'a',
      content:'ONLINE_NEW_PROGRESS_'+id,createdAt:'2026-10-16T19:55:00+08:00'}]);
  }
  let retrievalQuery='';
  mocks['./memory-service'].createStoryMemoryRanker = query => { retrievalQuery=query; return async()=>[]; };
  mocks['./settings-storage'].resolveBinding=()=>({apiConfigId:'api',presetId:'preset',worldBookIds:['continuity']});
  mocks['./settings-storage'].loadWorldBooks=()=>[{id:'continuity',entries:[
    {key:'NEW_MULTIPERSON_PROGRESS',content:'ACTIVATED_MULTI_LORE',position:0},
    {key:'ONLINE_NEW_PROGRESS',content:'ACTIVATED_ONLINE_LORE',position:0},
  ]}];
  preset.prompts.push({identifier:'worldInfoBefore',marker:true,enabled:true,role:'system'});
  preset.prompts.push({identifier:'macro-check',enabled:true,role:'system',content:
    '<last_char>{{lastCharMessage}}</last_char><last_message>{{lastMessage}}</last_message><last_user>{{lastUserMessage}}</last_user>'});
  const output=text(await consumers.single());
  for(const fragment of ['OLD_SCENE_UNCUT','NEW_MULTIPERSON_PROGRESS','OFFLINE_NEW_PROGRESS_direct','OFFLINE_NEW_PROGRESS_group',
    'ONLINE_NEW_PROGRESS_direct','ONLINE_NEW_PROGRESS_group','RETURN_NEW_INPUT']) assert.ok(output.includes(fragment),fragment);
  const order=['OLD_SCENE_UNCUT','NEW_MULTIPERSON_PROGRESS','OFFLINE_NEW_PROGRESS_direct','ONLINE_NEW_PROGRESS_direct','RETURN_NEW_INPUT'];
  for(let i=1;i<order.length;i++) assert.ok(output.indexOf(order[i-1])<output.indexOf(order[i]),'chronology '+order[i]);
  for(const fragment of order) assert.ok(retrievalQuery.includes(fragment),'retrieval includes '+fragment);
  assert.ok(output.includes('ACTIVATED_MULTI_LORE') && output.includes('ACTIVATED_ONLINE_LORE'));
  assert.match(output,/<last_char>[^]*ONLINE_NEW_PROGRESS[^]*<\/last_char>/);
  assert.ok(!output.match(/<last_char>([^]*?)<\/last_char>/)[1].includes('OLD_SCENE_UNCUT'));
  assert.ok(output.match(/<last_user>([^]*?)<\/last_user>/)[1].includes('RETURN_NEW_INPUT'));
  assert.ok(output.match(/<last_message>([^]*?)<\/last_message>/)[1].includes('RETURN_NEW_INPUT'));
  assert.ok(output.includes('1天19小时57分钟'),'old local page age is 43h57, not last night');
  assert.ok(output.includes('2026-10-16T12:00:00.000Z'),'generation reference time uses now');
  assert.equal(story.loadStoryMessages('single')[0].rawContent,'OLD_SCENE_UNCUT','old prose is not rewritten');
  // A director-only return has no fresh in-story user input; latest experience still wins.
  story.replaceStoryMessages('single',[old]);
  const directed=text((await engine.previewStoryPromptPayload('a',[old,{id:'direction',sessionId:'single',role:'user',kind:'director',
    rawContent:'DIRECTOR_ONLY',createdAt:newTime}],storyOptions('single',['a']))).messages);
  assert.ok(directed.match(/<last_message>([^]*?)<\/last_message>/)[1].includes('ONLINE_NEW_PROGRESS'));
  assert.ok(retrievalQuery.includes('DIRECTOR_ONLY') && retrievalQuery.includes('NEW_MULTIPERSON_PROGRESS'));
  const originalOnline=chatRows.get('direct');
  chatRows.set('direct',[...originalOnline,...Array.from({length:30},(_,i)=>({id:'burst-'+i,sessionId:'direct',role:'user',
    content:'RECENT_BUBBLE_'+i,createdAt:new Date(Date.parse('2026-10-16T19:56:00+08:00')+i*1000).toISOString()}))]);
  const burst=text((await engine.previewStoryPromptPayload('a',[old,fresh],storyOptions('single',['a']))).messages);
  assert.ok(retrievalQuery.includes('NEW_MULTIPERSON_PROGRESS') && retrievalQuery.includes('OFFLINE_NEW_PROGRESS_direct'),
    'online burst cannot evict recent cross-page narrative retrieval anchors');
  assert.ok(burst.match(/<last_char>([^]*?)<\/last_char>/)[1].includes('ONLINE_NEW_PROGRESS'),
    'a newer user bubble is not misattributed as a character reply');
  chatRows.set('direct',originalOnline);
  config={...config,shortTermAllowedSources:{story:false}};
  const excludedStory=text((await engine.previewStoryPromptPayload('a',[old,fresh],storyOptions('single',['a']))).messages);
  assert.ok(!excludedStory.includes('NEW_MULTIPERSON_PROGRESS') && !retrievalQuery.includes('NEW_MULTIPERSON_PROGRESS'));
  config={...config,shortTermAllowedSources:{}};
  // No automatic expiry, even without real-time awareness; explicit isolation remains authoritative.
  const noClock=text((await engine.previewStoryPromptPayload('a',[old,fresh],{...storyOptions('single',['a']),globalSettings:{timeAware:false}})).messages);
  assert.ok(noClock.includes('OLD_SCENE_UNCUT') && noClock.includes('NEW_MULTIPERSON_PROGRESS'));
  assert.ok(!noClock.includes('2026-10-16') && !noClock.includes('1天19小时57分钟'));
  retrievalQuery='';
  const isolatedReturn=text((await engine.previewStoryPromptPayload('a',[old,fresh],{
    ...storyOptions('single',['a']),storyMemory:{independent:true}})).messages);
  assert.ok(!isolatedReturn.includes('NEW_MULTIPERSON_PROGRESS') && !isolatedReturn.includes('ONLINE_NEW_PROGRESS'));
  assert.equal(retrievalQuery,'','independent stories do not retrieve native memories');
  // Instructions stay in their online history, but neither summary counting nor
  // summary material may treat them as experiences (single and group alike).
  for (const id of ['direct','group']) {
    chatRows.set(id,[...chatRows.get(id),{id:'instruction-'+id,sessionId:id,role:'system',mediaType:'system_instruction',
      content:'OUT_OF_STORY_'+id,createdAt:newTime},
      {id:'avatar-'+id,sessionId:id,role:'system',mediaType:'system_instruction',
        mediaData:{shortTermMemoryEvent:true},content:'AVATAR_EVENT_'+id,createdAt:newTime}]);
    assert.ok(text(await consumers['online-'+id]()).includes('OUT_OF_STORY_'+id),'recent instruction stays active');
  }
  story.pushStoryMessage({sessionId:'multi',role:'user',kind:'director',rawContent:'SECRET_DIRECTOR',createdAt:newTime});
  const native=short.loadNativeTimeline('a');
  const summarize=load('./memory-rounds').selectMemorySummarySources(native);
  for(const id of ['direct','group']) {
    assert.ok(native.some(row=>row.content.includes('OUT_OF_STORY_'+id)),'timeline still contains direction');
    assert.ok(!JSON.stringify(summarize).includes('OUT_OF_STORY_'+id),'summary excludes direction');
    assert.ok(JSON.stringify(summarize).includes('AVATAR_EVENT_'+id),'real system event retained');
  }
  assert.ok(!JSON.stringify(summarize).includes('SECRET_DIRECTOR'));
  assert.ok(!JSON.stringify(summarize).includes('DIRECTOR_ONLY'));
  assert.ok(summarize.some(row=>row.sourceDetail==='chat_offline'),'offline accepted events retained');
  assert.ok(summarize.some(row=>row.sourceDetail==='story'),'story accepted events retained');
  assert.ok(story.loadStoryMessages('multi').some(row=>row.kind==='director'),'director notes remain stored');
  console.log('PASS: stored/recent online directions preserved, single/group summary exclusion, factual system events and accepted offline/story experiences retained');
  console.log('PASS: Oct 15 00:03 -> Oct 16 20:00 single-page return; real stores/engine/assembler retain old prose, retrieve new multi/online/offline events, activate new lore and resolve timestamped macros; director/no-clock/IF boundaries');
})().catch(error=>{console.error(error);process.exitCode=1;});
