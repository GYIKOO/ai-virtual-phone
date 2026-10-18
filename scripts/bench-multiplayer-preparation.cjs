// Synthetic local histories only; reuses the cross-mode fixture's real storage,
// timeline and prompt builders. No model/network calls or user data.
const fs = require('node:fs');
const fixture = fs.readFileSync('scripts/test-cross-mode-recall.cjs', 'utf8').split('(async()=>{')[0];
const workload = String.raw`
const {performance}=require('node:perf_hooks');
const {createHash}=require('node:crypto');
const metrics=new Map();
let queries=[];
mocks['./memory-service'].retrieveMemoriesForPrompt=async(id,query)=>{queries.push([id,query]);return [];};
mocks['./memory-service'].createStoryMemoryRanker=query=>{queries.push(['scene',query]);return async()=>[];};
function instrument(name, exports) {
  for(const key of Object.keys(exports)) {
    if(typeof exports[key]!=='function') continue;
    const original=exports[key];
    exports[key]=function(...args) {
      const started=performance.now();
      try {return original.apply(this,args);} finally {
        const id=name+'.'+key, row=metrics.get(id)||{calls:0,ms:0,max:0};
        const ms=performance.now()-started;row.calls++;row.ms+=ms;row.max=Math.max(row.max,ms);metrics.set(id,row);
      }
    };
  }
}
// Measure CPU rather than synthetic 40ms background-tab timers.
mocks['./story-preparation']={yieldStoryPreparation:async()=>{},throwIfStoryAborted(){}};
(async()=>{
  referenceTime=Date.UTC(2026,9,17,20);
  characters.splice(0,characters.length,...Array.from({length:9},(_,i)=>({id:'c'+i,name:'角色'+i,persona:'人物设定。'.repeat(120),timeZone:process.env.FLOAT_BENCH_ZONES ? (i%2?'Asia/Shanghai':'America/New_York') : undefined})));
  const ids=characters.map(c=>c.id);
  const stamp=n=>new Date(referenceTime-10*86400000+n*60000).toISOString();
  sessions.splice(0,sessions.length,{id:'group',isGroup:true,participantIds:ids,groupName:'九人群'},
    ...ids.map(id=>({id:'private-'+id,contactId:id})),
    {id:'other',isGroup:true,participantIds:ids,groupName:'共同经历'});
  for(const s of sessions) chatRows.set(s.id,Array.from({length:300},(_,i)=>({
    id:s.id+'-'+i,sessionId:s.id,role:i%2?'assistant':'user',senderName:'角色0',senderCharacterId:'c0',
    content:'最近的日常聊天以及计划。'.repeat(6),createdAt:stamp(i),responseRoundId:s.id+'-round-'+Math.floor(i/2),
  })));
  const db=new Dexie('AiPhoneStoryDB');db.version(1).stores({sessions:'id, characterId, updatedAt',messages:'id, sessionId, createdAt'});
  await db.sessions.bulkPut(Array.from({length:6},(_,i)=>({id:'page'+i,characterId:'c0',ownerType:'group',ownerId:'group',participantIds:ids,
    branchId:'main',createdAt:stamp(0),updatedAt:stamp(800)})));
  await db.messages.bulkPut(Array.from({length:6},(_,p)=>Array.from({length:80},(_,i)=>({
    id:'page'+p+'-'+i,sessionId:'page'+p,role:i%2?'assistant':'user',rawContent:'这一段是已经发生的正式剧情。'.repeat(i%2?100:10),
    storySummary:i%2?'一起探索了城市并讨论接下来的计划。':'',createdAt:stamp(400+p*80+i),
  }))).flat());
  const story=load('./story-storage');await story.hydrateStoryStorage();
  for(const name of ['./story-storage','./short-term-assembler','./story-context-budget','./character-time','./llm-prompt-assembler','./token-counter']) instrument(name,load(name));
  const short=load('./short-term-assembler'),assembler=load('./llm-prompt-assembler');
  const builders=loadChatBuilders(short,assembler),engine=load('./story-engine');
  config={...config,shortTermTokenBudget:24000,contextTokenLimit:100000,recentContextDetail:'standard'};
  for(const count of [2,8,9]) for(const mode of ['group','offline','story','retry']) {
    const subset=ids.slice(0,count);metrics.clear();queries=[];
    const start=performance.now();
    const messages=['group','offline'].includes(mode)?(await builders.buildGroupChatPromptMessages({...sessions[0],participantIds:subset},chatRows.get('group'),mode==='offline'?{appTags:['group_chat','offline'],excludeOfflineSessionId:'group'}:undefined)).llmMessages
      :(await engine.previewStoryPromptPayload('c0',mode==='retry'?story.loadStoryMessages('page5').slice(0,-1):story.loadStoryMessages('page5'),{sessionId:'page5',participantIds:subset,globalSettings:{timeAware:true}})).messages;
    console.log(JSON.stringify({mode,participants:count,ms:Math.round(performance.now()-start),chars:text(messages).length,hash:createHash('sha256').update(JSON.stringify(messages)).digest('hex'),queryHash:createHash('sha256').update(JSON.stringify(queries)).digest('hex'),
      hotspots:[...metrics].sort((a,b)=>b[1].ms-a[1].ms).slice(0,12).map(([fn,r])=>({fn,calls:r.calls,ms:Math.round(r.ms),maxMs:Math.round(r.max)}))}));
  }
  if(short.prepareGroupShortTermContextAsync) {
    let checkpoints=0;
    const args=[ids,chatRows.get('group'),{excludeGroupSessionId:'group'}];
    const sync=short.prepareGroupShortTermContext(...args);
    const asyncResult=await short.prepareGroupShortTermContextAsync(...args,async()=>{checkpoints++;await new Promise(resolve=>setTimeout(resolve,0));});
    assert.equal(JSON.stringify(asyncResult),JSON.stringify(sync));
    assert.equal(checkpoints,ids.length+1,'yield before each member timeline and final packing');
    let abortedAt=0;
    const controller=new AbortController();
    const cancellable=loadChatBuilders(short,assembler,async(signal)=>{
      await new Promise(resolve=>setTimeout(resolve,0));
      if(++abortedAt===3) controller.abort();
      if(signal?.aborted){const error=new Error('stopped');error.name='AbortError';throw error;}
    });
    await assert.rejects(cancellable.buildGroupChatPromptMessages(sessions[0],chatRows.get('group'),{signal:controller.signal}),{name:'AbortError'});
    assert.equal(abortedAt,3,'cancelled preparation does not continue through remaining members');
    console.log('PASS: asynchronous group preparation matches sync, yields between members, and stops when cancelled');
  }
  db.close();await Dexie.delete('AiPhoneStoryDB');
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
new Function('require', fixture + workload)(require);
