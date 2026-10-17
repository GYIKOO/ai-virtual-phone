const fs = require("node:fs"), vm = require("node:vm"), assert = require("node:assert/strict"), ts = require("typescript");
let now = new Date("2026-10-16T20:00:00").getTime();
class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));} static now(){return now;}}
const cache=new Map(), window=new EventTarget();
const kv={kvGet:key=>cache.get(key),kvSet:(key,value)=>cache.set(key,value),kvSetAsync:async(key,value)=>cache.set(key,value),kvRefresh:async()=>{},registerKvMigration(){}};
let enabled=true, identity="user1";
const settings={resolveUserIdentity:()=>({id:identity})};
function load(file,deps={}) {
  const exports={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports,require:name=>{if(!(name in deps))throw Error("Unexpected import "+name);return deps[name];},Date:Clock,structuredClone,window,Event,Intl,console,navigator:{locks:{request:async(_,run)=>run()}}});
  return exports;
}
const utils=load("lib/calendar-utils.ts");
const storage=load("lib/calendar-storage.ts",{"./kv-db":kv,"./settings-storage":settings,"./calendar-utils":utils,"./character-time":{getSystemTimeZone:()=>Intl.DateTimeFormat().resolvedOptions().timeZone}});
const changes=load("lib/calendar-changes.ts",{"./calendar-storage":storage,"./calendar-utils":utils});
const sync=load("lib/calendar-sync.ts",{
  "./internal-capability-storage":{CALENDAR_MANAGEMENT_CAPABILITY_ID:"calendar_management",getInternalCapability:()=>({enabled,mode:"auto"})},
  "./character-storage":{loadCharacters:()=>["a","b","c"].map(id=>({id,name:id}))},"./settings-storage":settings,"./calendar-storage":storage,"./calendar-utils":utils,"./calendar-changes":changes,
});
const ctx={characterIds:["a","b"],userIdentityId:"user1",app:"story",now};
const empty=()=>({plans:[],commitments:[],appliedBatches:[],revision:0});
const promise={op:"commitment.save",participantIds:["a","b"],date:"2026-10-17",startTime:"10:00",endTime:"11:00",title:"一起见面",location:"车站"};
const schedule={op:"schedule.save",characterId:"a",date:"2026-10-17",startTime:"12:00",endTime:"13:00",title:"午饭",location:"家"};
const clone=value=>JSON.parse(JSON.stringify(value));
function onlineTools() {
  const file="lib/tool-executor.ts", source=fs.readFileSync(file,"utf8"), ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  const names=["executeCalendarTool","executeCalendarListTool","parseCalendarDraft","normalizeCalendarDate","findCalendarItemByArgs","getCalendarSearchWeekStarts","calendarKeywordMatch","formatCalendarItemForTool","calendarToolFailure","cleanToolString","isSupportedChatToolContext"];
  const fragment=ast.statements.filter(node=>names.includes(node.name?.text)).map(node=>node.getText(ast)).join("\n")+"\nexports.execute=executeCalendarTool;";
  const exports={}, roster=[{id:"direct",contactId:"a"},{id:"group",isGroup:true,participantIds:["a","b"]}];
  vm.runInNewContext(ts.transpileModule(fragment,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports,console,Date:Clock,...utils,...storage,...sync,
      getInternalCapability:()=>({enabled,mode:"auto"}),CALENDAR_MANAGEMENT_CAPABILITY_ID:"calendar_management",
      loadCharacters:()=>["a","b"].map(id=>({id,name:id})),loadChatSessions:()=>roster,truncate:value=>value});
  return exports.execute;
}
async function main(){
  cache.set("ai_phone_calendar_plans_v1",JSON.stringify({plans:[]}));
  assert.deepEqual(clone(storage.loadCalendarStore()),empty(),"legacy storage migrates without dropping plans");
  let state=changes.planCalendarChanges(empty(),[promise],ctx);
  assert.equal(state.commitments.length,1,"shared promise stored once");
  state=changes.planCalendarChanges(state,[promise],ctx);
  assert.equal(state.commitments.length,1,"repeat accepted promise deduplicates");
  assert.throws(()=>changes.planCalendarChanges(state,[{...promise,title:"另一约定"}],ctx),/冲突/);
  assert.throws(()=>changes.planCalendarChanges(state,[{...promise,participantIds:["c"]}],ctx),/参与者/);
  assert.throws(()=>changes.planCalendarChanges(state,[{op:"commitment.cancel",id:state.commitments[0].id}],{...ctx,userIdentityId:"other"}),/找不到/);
  assert.throws(()=>changes.planCalendarChanges(state,[{...schedule,date:"2026-10-18"}],ctx),/今天/);
  assert.throws(()=>changes.planCalendarChanges(state,[{...schedule,date:"2026-10-15"}],ctx),/今天/);
  assert.throws(()=>changes.planCalendarChanges(state,[{...schedule,date:"2026-10-16",startTime:"01:00",endTime:"02:00"}],ctx),/已结束/);
  assert.throws(()=>changes.planCalendarChanges(state,[{...schedule,date:"2026-02-30"}],ctx),/有效/);
  assert.throws(()=>changes.planCalendarChanges(state,[{...schedule,startTime:"25:00"}],ctx),/时段/);
  const before=JSON.stringify(state);
  assert.throws(()=>changes.planCalendarChanges(state,[schedule,{...schedule,characterId:"c"}],ctx));
  assert.equal(JSON.stringify(state),before,"failed batch doesn't partially change original");
  const scheduled=changes.planCalendarChanges(state,[schedule,schedule],ctx);
  assert.equal(scheduled.plans[0].items.length,1,"reroll schedule exact duplicates coalesce");
  state=changes.planCalendarChanges(state,[{...promise,date:"2027-02-01",title:"远期计划"},{...promise,date:null,startTime:null,endTime:null,title:"待定计划"}],ctx);
  assert.equal(state.commitments.length,3);
  assert.throws(()=>changes.planCalendarChanges(state,[{...promise,date:"2026-10-15",title:"过期"}],ctx),/尚未结束/);
  storage.saveCalendarStore(state);
  const week=utils.getWeekStartIso(new Clock());
  assert.ok(storage.loadCalendarWeekPlan("character","a",week,"user1").items.some(row=>row.commitmentId));
  assert.equal(storage.loadCalendarWeekPlan("character","a",week,"other"),null,"identity isolated");
  assert.equal(storage.loadCalendarWeekPlan("character","c",week,"user1"),null,"unrelated character cannot read");
  assert.ok(storage.formatCalendarCommitments("a",week,"user1").includes("待定计划"));
  assert.ok(!storage.formatCalendarCommitments("a",week,"user1").includes("远期计划"));
  storage.saveCalendarStore(changes.planCalendarChanges(state,[{...promise,title:"下周约定",date:"2026-10-22"}],ctx));
  assert.ok(storage.formatCalendarCommitments("a",week,"user1").includes("下周约定"),"target week + following week commitments included");
  storage.saveCalendarStore(state);
  const ordinary={id:"generated",date:"2026-10-17",startTime:"10:30",endTime:"11:30",title:"随机生活",location:"",source:"generated",createdAt:new Clock().toISOString(),updatedAt:new Clock().toISOString()};
  storage.replaceCalendarWeekItems("character","a",week,[ordinary]);
  assert.ok(!storage.loadCalendarWeekPlan("character","a",week,"user1").items.some(row=>row.id==="generated"),"promise takes precedence in view");
  assert.equal(storage.loadCalendarStore().plans[0].items.length,1,"projection does not delete underlying schedules");
  storage.upsertCalendarScheduleItem("character","a",week,{...ordinary,id:"manual-later",source:"manual",startTime:"17:00",endTime:"18:00"});
  assert.ok(storage.loadCalendarStore().plans[0].items.some(row=>row.id==="generated"),"ordinary editor preserves projection-hidden records");
  storage.deleteCalendarScheduleItem("character","a",week,"manual-later");
  assert.ok(storage.loadCalendarStore().plans[0].items.some(row=>row.id==="generated"),"ordinary deletion cannot drop hidden records");
  storage.cloneWeekPlanWithManualEdits("character","a",week,[ordinary,{...ordinary,id:"free",startTime:"12:00",endTime:"13:00"}]);
  assert.ok(storage.loadCalendarWeekPlan("character","a",week,"user1").items.some(row=>row.id==="free"));
  assert.ok(!storage.loadCalendarStore().plans.flatMap(row=>row.items).some(row=>row.commitmentId),"projection never duplicated into storage");
  assert.equal(storage.loadCalendarStore().commitments.length,3,"regeneration retains promises");

  let snapshot=sync.createCalendarSync(["a","b"],"story","page");
  assert.ok(sync.calendarSyncPrompt(snapshot).includes("2026-10-16"));
  assert.ok(sync.calendarSyncPrompt(snapshot).includes("2026-10-17"));
  const prose="<context>正文</context><summary>摘要</summary>";
  const parsed=sync.extractCalendarChanges(prose+"<calendar_changes>"+JSON.stringify([schedule])+"</calendar_changes>",snapshot);
  assert.equal(parsed.text,prose);
  assert.equal(storage.loadCalendarStore().appliedBatches.length,0,"extraction alone performs no changes");
  assert.equal(await sync.applyAcceptedCalendarChanges(parsed.pendingCalendarChanges,"msg1"),null);
  const revision=storage.loadCalendarStore().revision;
  assert.equal(await sync.applyAcceptedCalendarChanges(parsed.pendingCalendarChanges,"msg1"),null);
  assert.equal(storage.loadCalendarStore().revision,revision,"batch replay idempotent");
  snapshot=sync.createCalendarSync(["a"],"chat");
  storage.saveCalendarStore(storage.loadCalendarStore());
  assert.match(await sync.applyAcceptedCalendarChanges({...snapshot,changes:[schedule]},"msg2"),/已发生变化/);
  enabled=false;
  assert.equal(sync.createCalendarSync(["a"],"chat"),undefined);
  assert.match(await sync.applyAcceptedCalendarChanges(parsed.pendingCalendarChanges,"msg3"),/已关闭/);
  enabled=true;
  assert.equal(sync.createCalendarSync(["a"],"story","if",true),undefined);
  assert.equal(sync.createCalendarSync(["missing"],"chat"),undefined);
  assert.ok(sync.extractCalendarChanges(prose+"<calendar_changes>broken</calendar_changes>",snapshot).pendingCalendarChanges.error);
  assert.equal(sync.extractCalendarChanges(prose+"<calendar_changes>[",snapshot).text,prose);
  for(let n=1;n<"<calendar_changes>".length;n++) assert.equal(sync.hideCalendarChangeStream(prose+"<calendar_changes>".slice(0,n)),prose);
  assert.equal(sync.hideCalendarChangeStream(prose+"<calendar_changes>[{}]"),prose);
  identity="other";
  assert.match(await sync.applyAcceptedCalendarChanges(parsed.pendingCalendarChanges,"msg4"),/身份/);
  identity="user1";
  // A response crossing midnight revalidates against the real local day.
  const old=sync.createCalendarSync(["a"],"chat"); old.changes=[{...schedule,date:"2026-10-16",startTime:"22:00",endTime:"23:00"}];
  now=new Date("2026-10-17T00:01:00").getTime();
  assert.match(await sync.applyAcceptedCalendarChanges(old,"msg5"),/今天/);
  now=new Date("2026-11-01T00:30:00").getTime();
  const dst=sync.calendarSyncPrompt(sync.createCalendarSync(["a"],"chat"));
  assert.ok(dst.includes("今天 2026-11-01") && dst.includes("明天 2026-11-02"),"calendar tomorrow handles DST");
  now=new Date("2026-10-16T20:00:00").getTime();
  storage.saveCalendarStore(empty());
  const execute=onlineTools();
  const direct={appId:"chat",sourceEngine:"chat",sessionId:"direct",characterId:"a"};
  const group={appId:"group_chat",sourceEngine:"group_chat",sessionId:"group",characterId:"a"};
  assert.equal((await execute({name:"添加日程",args:schedule},direct)).success,true,"legacy online add uses shared validation");
  assert.equal((await execute({name:"添加日程",args:{...schedule,date:"2026-10-18"}},direct)).success,false,"online today/tomorrow guard");
  assert.equal((await execute({name:"更新日历安排",args:{changes:[promise]}},group)).success,true,"online group shared promise");
  assert.equal((await execute({name:"更新日历安排",args:{changes:[{...schedule,characterId:"b"}]}},group)).success,false,"speaker cannot change another ordinary schedule");
  const listed=await execute({name:"查看日程",args:{}},group);
  assert.ok(listed.data.includes("一起见面") && listed.data.includes("user1") === false);
  assert.equal((await execute({name:"取消日程",args:{itemId:"missing",keyword:"午饭"}},direct)).success,false,"bad explicit id never falls back to keyword deletion");
  const item=storage.loadCalendarStore().plans[0].items[0];
  assert.equal((await execute({name:"修改日程",args:{...schedule,itemId:item.id,startTime:"14:00",endTime:"15:00"}},direct)).success,true);
  assert.equal((await execute({name:"取消日程",args:{itemId:item.id}},direct)).success,true);
  enabled=false;
  assert.equal((await execute({name:"更新日历安排",args:{changes:[promise]}},group)).success,false,"disabled online calendar cannot write");
  console.log("calendar commitments: storage, identity, conflicts, replay, real dates, long-form acceptance passed");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
