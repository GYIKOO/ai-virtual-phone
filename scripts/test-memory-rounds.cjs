const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const modules=new Map();
let timeline=[],saved=[],watermark=null,calls=0,core=0,removed=[],failAt=0,writeFailure=false,editDuringCall=false;
let config={autoSummarizeEnabled:true,summarizationRoundInterval:2,summarizationEventInterval:80,vectorRecallEnabled:false,maxLongTermEntries:1};
const retained=[{id:'core',type:'core',createdAt:'2020-01-01'}, {id:'manual',type:'long_term',metadata:{origin:'user_manual'},createdAt:'2020-01-01'},
 {id:'old-auto',type:'long_term',createdAt:'2020-01-01'}];
const mocks={
 './memory-storage':{loadMemoryConfig:()=>config,getLastSummarizedTimestamp:()=>watermark,getEventCounter:()=>0,resetEventCounter(){},
  saveMemoryEntries:async rows=>{if(writeFailure)throw Error('disk full');saved.push(...rows);},setLastSummarizedTimestamp:(_id,value)=>watermark=value,
  loadMemoryEntries:async()=>[...retained,...saved],deleteMemoryEntries:async ids=>removed.push(...ids),incrementCoreMemoryCounter:()=>core++},
 './settings-storage':{resolveAuxiliaryApiConfig:()=>({id:'fake-api'})},
 './short-term-assembler':{loadNativeTimeline:(_id,opts)=>timeline.filter(e=>!opts?.afterTimestamp||e.timestamp>opts.afterTimestamp),filterTimelineByAllowedSources:rows=>rows,
  formatTimelineForSummarization:rows=>({eventsText:rows.map(r=>r.content).join('\n'),earliest:rows[0].startTimestamp||rows[0].timestamp,latest:rows.at(-1).timestamp})},
 './api-helpers':{simpleLLMCall:async()=>{calls++;if(editDuringCall)timeline=timeline.map((row,i)=>i?row:{...row,content:row.content+' edited'});return {content:'总结'+calls,wasTruncated:calls===failAt};}},
 './memory-embedding':{},'./core-memory-builder':{maybeRunCoreMemoryPipeline:async()=>{}},
 './memory-writer-lock':{assertNoMemoryRebuild:async()=>{},withMemoryWriterLock:async(_id,fn)=>fn()},
};
function load(name){if(mocks[name])return mocks[name];if(modules.has(name))return modules.get(name);
 const exports={};modules.set(name,exports);const file=`lib/${name.slice(2)}.ts`;
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
 {exports,require:load,console,Date},{filename:file});return exports;}
const {groupMemoryRounds}=load('./memory-rounds');
const at=n=>new Date(Date.UTC(2026,9,16)+n*1000).toISOString();
const msg=(id,n,role,batch,channel='a')=>({id,timestamp:at(n),content:id,sourceApp:'chat',sourceDetail:'direct',dialogueSessionId:channel,dialogueRole:role,responseUnitId:batch});
const rows=[msg('u',0,'user'),msg('a1',1,'assistant','r'),msg('a2',2,'assistant','r'),
 msg('followup',3,'assistant','f'),msg('pending',4,'user'),
 {...msg('story',5),dialogueSessionId:undefined,dialogueRole:undefined,sourceApp:'story'}];
assert.equal(groupMemoryRounds(rows).length,3,'one reply split into bubbles is one round; follow-up and narrative each one');
assert.equal(groupMemoryRounds(rows)[0].content,'u\na1\na2');
assert.equal(groupMemoryRounds(rows)[0].startTimestamp,at(0));
assert.ok(!JSON.stringify(groupMemoryRounds(rows)).includes('pending'));
assert.equal(groupMemoryRounds([...rows,msg('answer',8,'assistant','answer')]).length,4);
assert.equal(groupMemoryRounds([...rows,msg('b',7,'assistant','r','b')]).length,4,'different sessions cannot collapse');
const original=JSON.stringify(rows);groupMemoryRounds(rows);assert.equal(JSON.stringify(rows),original);
const {maybeRunSummarization,runSummarizationPipeline}=load('./memory-summarizer');
function reset(){saved=[];watermark=null;calls=0;core=0;removed=[];failAt=0;writeFailure=false;editDuringCall=false;}
(async()=>{
 timeline=Array.from({length:5},(_,i)=>({id:`story${i}`,sourceApp:'story',timestamp:at(i),content:`剧情${i}`}));
 await maybeRunSummarization('a','A');
 assert.equal(calls,2);assert.equal(saved.length,2);assert.equal(watermark,at(3),'under-threshold tail remains unsummarized');
 assert.equal(core,2);assert.ok(!removed.includes('manual')&&!removed.includes('core'));
 assert.ok(saved.every(e=>e.sourceMessageIds.length===2));
 await maybeRunSummarization('a','A');assert.equal(calls,2,'tail cannot re-trigger');
 reset();failAt=2;const failed=await runSummarizationPipeline('a','A');
 assert.equal(failed.success,false);assert.equal(saved.length,0);assert.equal(watermark,null,'truncated batch does not advance watermark');
 reset();writeFailure=true;assert.equal((await runSummarizationPipeline('a','A')).success,false);assert.equal(watermark,null);
 reset();editDuringCall=true;assert.equal((await runSummarizationPipeline('a','A')).success,false);assert.equal(saved.length,0);assert.equal(watermark,null,'source edits prevent stale summary activation');
 reset();config={...config,summarizationRoundInterval:undefined};await maybeRunSummarization('a','A');
 assert.equal(calls,0,'legacy event threshold is not silently reinterpreted');
 console.log('PASS persisted-round grouping, active follow-ups, pending input, legacy counters, batched summaries, atomic failure, tail preservation and protected retention');
})().catch(e=>{console.error(e);process.exitCode=1;});
