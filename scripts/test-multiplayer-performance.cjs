// Exact behavior checks and synthetic before/after timings. No model or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const {execFileSync} = require('node:child_process');
const base = process.env.FLOAT_PERF_BASE || 'bac69a887edcfb279c58dcbdd9e5101b4f4cc24e';
function load(file, baseline = false, deps = {}) {
  const source = baseline ? execFileSync('git', ['show', `${base}:${file}`], {encoding:'utf8'}) : fs.readFileSync(file,'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports, require:key=>{assert.ok(key in deps,key);return deps[key];}, console, Date, Intl});
  return exports;
}
const token=load('lib/token-counter.ts'), oldToken=load('lib/token-counter.ts',true);
for(let n=0;n<65536;n++) assert.equal(token.estimateTokens(String.fromCharCode(n)),oldToken.estimateTokens(String.fromCharCode(n)));
let seed=23;
for(let n=0;n<200;n++) {
  let text='';
  for(let i=0;i<n*17;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;text+=String.fromCharCode(seed%65536);}
  assert.equal(token.estimateTokens(text),oldToken.estimateTokens(text));
}
const policy=load('lib/memory-context-policy.ts',false,{'./token-counter':token});
const compare=policy.createMemoryTimeComparator();
const stamps=['2026-10-17T01:00:00Z','2026-10-17T09:00:00+08:00','2026-10-16T18:00:00-07:00','invalid','','2026-10-17','2026-10-17T20:00:00Z'];
for(const a of stamps) for(const b of stamps) assert.equal(compare(a,b),policy.compareMemoryTime(a,b));
const time=load('lib/character-time.ts'),oldTime=load('lib/character-time.ts',true);
for(const zone of ['America/Los_Angeles','Asia/Shanghai','UTC','Pacific/Auckland','Asia/Kathmandu', 'invalid']) {
  assert.equal(time.normalizeTimeZone(zone),oldTime.normalizeTimeZone(zone));
  for(const stamp of ['2026-03-08T09:59:00Z','2026-03-08T10:01:00Z','2026-11-01T08:59:00Z','2026-11-01T09:01:00Z','2026-10-17T23:59:00Z']) {
    const date=new Date(stamp);
    assert.deepEqual(JSON.parse(JSON.stringify(time.buildCharacterTimeContext(zone,date))),JSON.parse(JSON.stringify(oldTime.buildCharacterTimeContext(zone,date))));
    if(zone!=='invalid') assert.equal(time.formatZonedPromptTimestamp(date,zone,true),oldTime.formatZonedPromptTimestamp(date,zone,true));
  }
}
console.log('PASS: all UTF-16 code units + mixed text token parity; offset/invalid timestamp sorting; timezone/DST formatter parity');
for(const zones of ['', '1']) {
  const run=baseline=>execFileSync(process.execPath,['scripts/bench-multiplayer-preparation.cjs'],{
    encoding:'utf8',maxBuffer:10*1024*1024,env:{...process.env,FLOAT_BENCH_ZONES:zones,FLOAT_CROSS_MODE_BASE_REF:baseline?base:''},
  }).split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
  const before=run(true),after=run(false);
  assert.equal(before.length,12);assert.equal(after.length,12);
  for(let i=0;i<before.length;i++) {
    const a=before[i],b=after[i];
    assert.equal(b.hash,a.hash,`${zones}/${a.mode}/${a.participants}: complete request bytes`);
    assert.equal(b.queryHash,a.queryHash,`${zones}/${a.mode}/${a.participants}: retrieval queries`);
    console.log(`${zones?'different zones':'same zone'} ${a.participants} ${a.mode}: ${a.ms} -> ${b.ms} ms; prompt and queries identical`);
  }
}
