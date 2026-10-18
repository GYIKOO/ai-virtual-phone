// No model, network, browser data, or device access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');
function load(file, deps = {}, globals = {}, source = fs.readFileSync(file, 'utf8')) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports, require: name => { assert.ok(name in deps, `unmocked import ${name}`); return deps[name]; },
      console, setTimeout, clearTimeout, AbortController, ...globals}, {filename:file});
  return exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const token = load('lib/token-counter.ts');
const policy = load('lib/memory-context-policy.ts', {'./token-counter':token});
const budget = load('lib/story-context-budget.ts', {'./token-counter':token,'./memory-context-policy':policy});
const preparation = load('lib/story-preparation.ts');

(async () => {
  // Yield must permit a paint, survive background rAF starvation, and cancel promptly.
  let painted = false;
  const interactive = load('lib/story-preparation.ts', {}, {
    window:{}, requestAnimationFrame: fn => setTimeout(() => {painted = true; fn();}, 0), cancelAnimationFrame: clearTimeout,
  });
  await interactive.yieldStoryPreparation();
  assert.ok(painted);
  let frameCount=0, clock=0;
  const throttled = load('lib/story-preparation.ts', {}, {
    window:{}, performance:{now:()=>clock},
    requestAnimationFrame:fn=>setTimeout(()=>{frameCount++;fn();},0),cancelAnimationFrame:clearTimeout,
  });
  const checkpointAbort=new AbortController();
  const checkpoint=throttled.createPromptPreparationCheckpoint(checkpointAbort.signal);
  await checkpoint();
  for(let i=0;i<20;i++) await checkpoint();
  assert.equal(frameCount,1,'small member preparations do not wait a frame each');
  clock=9;await checkpoint();assert.equal(frameCount,2,'CPU budget yields a fresh paint opportunity');
  checkpointAbort.abort();await assert.rejects(checkpoint(),{name:'AbortError'});
  const background = load('lib/story-preparation.ts', {}, {window:{}, requestAnimationFrame: () => 1, cancelAnimationFrame() {}});
  await background.yieldStoryPreparation();
  const cancelled = new AbortController();
  const waiting = background.yieldStoryPreparation(cancelled.signal);
  cancelled.abort();
  await assert.rejects(waiting, {name:'AbortError'});
  await assert.rejects(interactive.yieldStoryPreparation(cancelled.signal), {name:'AbortError'});

  const oldSource = process.env.FLOAT_STORY_BASE_REF
    ? cp.execFileSync('git', ['show', `${process.env.FLOAT_STORY_BASE_REF}:lib/story-context-budget.ts`], {encoding:'utf8'}) : null;
  const oldBudget = oldSource ? load('lib/story-context-budget.ts', {'./token-counter':token}, {}, oldSource) : budget;
  let checkpoints = 0;
  for (let round = 0; round < 60; round++) {
    const candidates = Array.from({length:40 + round * 3}, (_,i) => ({
      id:`event-${i%31}`, kind:['core','long','recent'][i%3], owners:[`char-${i%4}`],
      timestamp:new Date(1700000000000 + i * 10000).toISOString(),
      text:'既有事件。'.repeat(5 + i%28), summary:i%2 ? '既有摘要' : undefined, score:i%7/10,
    }));
    const options = {candidates, inputBudget:1200 + round*13, limits:{core:900,long:800,recent:1000},
      render: selected => [{role:'system',content:'固定资料'}, ...selected.map(item => ({role:'system',content:`${item.candidate.owners.join('、')} 来源与归属 ${item.text}`}))]};
    const before = oldBudget.packStoryContext(options);
    assert.deepEqual(plain(budget.packStoryContext(options)), plain(before));
    assert.deepEqual(plain(await budget.packStoryContextAsync(options, async () => { checkpoints++; })), plain(before));
  }
  assert.ok(checkpoints > 60);
  await assert.rejects(budget.packStoryContextAsync({candidates:[], inputBudget:1000, limits:{core:100,long:100,recent:100},render:()=>[]}, async () => preparation.throwIfStoryAborted(cancelled.signal)), {name:'AbortError'});

  let reads = 0, vectors = 0, vectorOptions;
  const memories = [{id:'c',type:'core',content:'core',createdAt:'2026-10-01'}, ...[1,2,3,4].map(n=>({id:`l${n}`,type:'long_term',content:'long',createdAt:`2026-10-0${n}`,embedding:[1,0]}))];
  const ranker = load('lib/memory-service.ts', {
    './memory-storage':{loadMemoryEntries: async () => {reads++; await new Promise(resolve => setTimeout(resolve, 5)); return memories;}},
    './settings-storage':{resolveAuxiliaryApiConfig:()=>({})},
    './memory-embedding':{generateEmbedding:async (_query,_api,options)=>{vectors++; vectorOptions=options; return [1,0];},resolveEmbeddingModel:()=> 'embed',cosineSimilarity:()=>1,keywordSearch:(_q,entries)=>entries.map(entry=>({entry,score:1}))},
    './token-counter':token, './proactive-replay':{knownAt:()=>true}, './memory-time':{memoryEventRange:()=>undefined}, './story-preparation':preparation,
  });
  const rank = ranker.createStoryMemoryRanker('scene', {vectorRecallEnabled:true});
  await Promise.all(['a','b','c','d'].flatMap(id=>[rank(id,'core'),rank(id,'long_term')]));
  assert.equal(reads,4); assert.equal(vectors,1); assert.equal(vectorOptions.timeoutMs,10000);
  await ranker.createStoryMemoryRanker('scene', {vectorRecallEnabled:false})('a','core');
  assert.equal(reads,5,'new requests do not reuse stale records');

  const embedding = load('lib/memory-embedding.ts', {'./api-helpers':{determineBaseUrl:()=> 'https://example.invalid/v1',buildRequestHeaders:()=>({})}}, {
    console:{warn(){}}, fetch: (_url, {signal}) => new Promise((_resolve,reject) => {
      const fail = () => {const error = new Error('aborted'); error.name='AbortError'; reject(error);};
      if (signal.aborted) fail(); else signal.addEventListener('abort',fail,{once:true});
    }),
  });
  const api = {provider:'Custom',defaultModel:'text-embedding-test',apiKey:'test'};
  assert.equal(await embedding.generateEmbedding('scene',api,{timeoutMs:10}),null,'timeout uses existing recall fallback');
  const stop = new AbortController();
  const pending = embedding.generateEmbedding('scene',api,{signal:stop.signal,timeoutMs:10000}); stop.abort();
  await assert.rejects(pending,{name:'AbortError'});

  const runs = load('lib/story-generation-runs.ts', {'./story-storage':{loadStoryMessages:()=>[],loadStorySessions:()=>[{id:'s'}]}});
  const first = runs.createStoryGenerationRun('s');
  assert.equal(runs.getStoryGenerationPhase('s'),'preparing');
  runs.setStoryGenerationPhase('s',first.runId,'recalling');
  assert.equal(runs.getStoryGenerationPhase('s'),'recalling');
  const second = runs.createStoryGenerationRun('s');
  runs.setStoryGenerationPhase('s',first.runId,'requesting');
  assert.equal(runs.getStoryGenerationPhase('s'),'preparing','stale callbacks cannot update replacement runs');
  runs.cancelStoryGenerationRun('s');
  runs.setStoryGenerationPhase('s',second.runId,'requesting');
  assert.equal(runs.getStoryGenerationPhase('s'),undefined);
  console.log('PASS: paint/background yield, stop during preparation, request-scoped read cache, one bounded vector call, timeout/abort, phase ownership');
  console.log('PASS: 60 budget scenarios preserve exact candidates, content, order and estimates across synchronous/asynchronous packing and baseline');
})().catch(error=>{console.error(error); process.exitCode=1;});
