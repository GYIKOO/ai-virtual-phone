const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const exports_ = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/memory-context-policy.ts','utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText,{exports:exports_,require:()=>({estimateTokens:t=>t.length})});
const {selectRecentContext,compareMemoryTime}=exports_;
const at=n=>new Date(Date.UTC(2026,9,16)+n*60000).toISOString();
const cost=t=>t.length;
const scene={id:'scene',timestamp:at(0),text:'SCENE_DETAIL'.repeat(20),summary:'scene summary',narrative:true};
const chats=Array.from({length:100},(_,i)=>({id:`chat${i}`,timestamp:at(i+1),text:`chat ${i} `.repeat(5)}));
const selected=selectRecentContext([scene,...chats],1000,'standard',cost);
assert.equal(selected.find(r=>r.candidate.id==='scene')?.text,scene.text,'online burst must not evict recent prose');
assert.ok(selected.some(r=>r.candidate.id==='chat99'),'latest online developments survive');
assert.ok(selected.reduce((n,r)=>n+cost(r.text),0)<=1000);
assert.equal(selected[0].candidate.id,'scene','protected prose is not moved after newer chat');
const old={...scene,id:'old',timestamp:at(-10000)};
assert.ok(selectRecentContext([old,...chats],1000,'standard',cost).some(r=>r.text===old.text),'no hidden real-time expiry');
assert.equal(selectRecentContext([scene,scene],1000,'standard',cost).length,1);
const huge={...scene,text:'x'.repeat(10000)};
assert.equal(selectRecentContext([huge,...chats],1000,'standard',cost).find(r=>r.candidate.id==='scene')?.text,scene.summary);
const absent={...huge,summary:undefined};
assert.equal(selectRecentContext([absent],1000,'standard',cost).length,0,'selector never invents a summary');
const bubbles=Array.from({length:4},(_,i)=>({id:`b${i}`,unitId:'one-response',timestamp:at(i),text:'x'.repeat(20)}));
const grouped=selectRecentContext(bubbles,60,'standard',cost);
assert.equal(grouped.length,0,'explicit response is indivisible');
assert.equal(compareMemoryTime('2026-10-16T09:00:00+08:00','2026-10-16T02:00:00Z'),-3600000);
for(let size=1;size<50;size++) {
 const rows=Array.from({length:size},(_,i)=>({id:String(i),timestamp:at(i),text:'x'.repeat(10+i*3),summary:'s',narrative:i%3===0}));
 for(const budget of [1,50,200,500,1000]) {
  const got=selectRecentContext(rows,budget,'standard',cost);
  assert.ok(got.reduce((n,r)=>n+cost(r.text),0)<=budget);
  assert.equal(new Set(got.map(r=>r.candidate.id)).size,got.length);
  assert.ok(got.every((r,i)=>!i||compareMemoryTime(got[i-1].candidate.timestamp,r.candidate.timestamp)<=0));
 }
}
console.log('PASS shared selection: mixed online/narrative, no expiry, fallback, grouping, 245 bounded timelines');
