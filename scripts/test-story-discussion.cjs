// Pure policy assertions; no user archive, server or model is accessed.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const cache = {};
function load(name) {
  if (cache[name]) return cache[name];
  const exports = cache[name] = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`lib/${name}.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports,require:path=>load(path.replace('./','')),console});
  return exports;
}
const d=load('story-discussion'), p=load('memory-context-policy'), token=load('token-counter');
const at=n=>new Date(Date.UTC(2026,9,19,0,n)).toISOString();
const row=(id,role,text,kind='discussion',discussionId='d',time=1)=>({id,role,rawContent:text,kind,discussionId,sessionId:'s',createdAt:at(time)});
const rows=[row('u','user','first'),row('a','assistant','answer'),row('e','system','end','discussion-end','d',2)];
let groups=d.storyDiscussions(rows);
assert.equal(groups.length,1);assert.equal(groups[0].closed,true);assert.equal(groups[0].anchor.id,'e');
assert.equal(d.limitDiscussionTranscripts(groups).get('d'),'用户：first\n\nAI：answer');
const confirmed=[...rows,row('b','assistant','BRIEF','discussion-brief','d',3)];
groups=d.storyDiscussions(confirmed);
assert.equal(groups[0].brief.rawContent,'BRIEF');assert.equal(d.limitDiscussionTranscripts(groups).size,0);
assert.equal(d.storyDiscussions([...confirmed,row('u2','user','more')])[0].brief,undefined,'reopened discussion does not silently reuse a superseded brief');
const long=[];
for(let i=0;i<3;i++) long.push(row(`u${i}`,'user','甲'.repeat(1400),'discussion','d',i),row(`a${i}`,'assistant','乙'.repeat(1400),'discussion','d',i));
const retained=d.limitDiscussionTranscripts(d.storyDiscussions(long)).get('d');
assert.ok(token.estimateTokens(retained)<=4000);
assert.ok(retained.startsWith('用户：') && retained.endsWith('乙'.repeat(1400)));
const mixed=d.storyDiscussions([...rows,...long.map(r=>({...r,discussionId:'new'}))]);
const capped=d.limitDiscussionTranscripts(mixed);
assert.ok([...capped.values()].reduce((sum,text)=>sum+token.estimateTokens(text),0)<=4000);
assert.equal(d.limitDiscussionTranscripts(d.storyDiscussions([...rows,row('huge','user','甲'.repeat(10000),'discussion','huge',10)])).size,0,'never skip newest oversized discussion to fill quota with older instructions');
assert.equal(d.discussionExitMayOmitText(long,'standard'),true);
const candidates=[{id:'discussion:d',timestamp:at(0),text:'old discussion',narrative:true},...Array.from({length:10},(_,i)=>({id:`story${i}`,timestamp:at(i+1),text:'prose',narrative:true}))];
assert.ok(!p.fullContextUnitIds(candidates,'standard').has('discussion:d'),'old discussion expires even with unlimited budget and no newer discussions');
assert.ok(p.fullContextUnitIds(candidates.slice(0,10),'standard').has('discussion:d'));
const signature=d.discussionSourceSignature(rows);
assert.equal(d.discussionSourceSignature(rows.map(r=>({...r,renderedContent:'new render'}))),signature);
assert.notEqual(d.discussionSourceSignature(rows.map(r=>({...r,rawContent:'edited'}))),signature);
assert.ok(!d.discussionExitMayOmitText([...long,...Array.from({length:12},(_,i)=>row(`s${i}`,'assistant','prose',undefined,undefined,i+10))].map(r=>r.id.startsWith('s')?{...r,kind:undefined,discussionId:undefined}:r),'standard'),'expired discussions do not trigger overflow warning');
console.log('PASS: groups, confirmation replacement, shared 4k token cap, complete exchanges, age gate, stable draft validation');
