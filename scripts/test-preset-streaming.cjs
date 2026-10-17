// Real transport + provider serialization with synthetic HTTP/SSE. No model/network calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const quiet = {log(){},warn(){},error(){}};
const empty = new Proxy({}, {get:()=>()=>[]});
const modules = new Map();
const requests = [], logs = [];
let scenario = 'success';
function frame(provider, text, reasoning = false) {
  if(provider==='anthropic') return {type:'content_block_delta',delta: reasoning ? {type:'thinking_delta',thinking:text}:{type:'text_delta',text}};
  if(provider==='gemini') return {candidates:[{content:{parts:[{text,...(reasoning?{thought:true}:{})}]}}]};
  return {choices:[{delta:reasoning?{reasoning_content:text}:{content:text}}]};
}
function jsonResponse(provider) {
  if(scenario==='tools') {
    if(provider==='anthropic')return {content:[{type:'tool_use',id:'call1',name:'inspect',input:{value:7}}]};
    if(provider==='gemini')return {candidates:[{content:{parts:[{functionCall:{name:'inspect',args:{value:7}},thoughtSignature:'signature'}]}}]};
    return {choices:[{message:{content:'',tool_calls:[{id:'call1',type:'function',function:{name:'inspect',arguments:'{"value":7}'}}]}}]};
  }
  if(provider==='anthropic') return {content:[{type:'thinking',thinking:'reason'},{type:'text',text:'complete'}]};
  if(provider==='gemini') return {candidates:[{content:{parts:[{thought:true,text:'reason'},{text:'complete'}]}}]};
  return {choices:[{message:{content:'complete',reasoning_content:'reason'}}]};
}
function streamResponse(provider, broken=false) {
  let frames=[frame(provider,'reason',true),frame(provider,'hello '.repeat(20))];
  if(scenario==='tools') {
    frames=provider==='anthropic' ? [
      {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'call1',name:'inspect',input:{}}},
      {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"value":7}'}},
    ] : provider==='gemini' ? [jsonResponse(provider)] : [
      {choices:[{delta:{tool_calls:[{index:0,id:'call1',function:{name:'inspect',arguments:'{"value":'}}]}}]},
      {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'7}'}}]}}]},
    ];
  }
  const text = frames.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('');
  const bytes=new TextEncoder().encode(text); let i=0;
  return {ok:true,body:{getReader:()=>({async read(){
    if(i<bytes.length){const value=bytes.slice(i,i+13);i+=13;return {value,done:false};}
    if(broken) throw new Error('synthetic disconnect');
    return {done:true};
  }})}};
}
const stubs = {
  './llm-http': {fetchLlmPayload:async request=>{
    requests.push(request);
    const stream=request.body.stream===true || request.url.includes('streamGenerateContent');
    if(stream && scenario==='unsupported') return {ok:false,status:400,text:async()=> 'stream is not supported'};
    if(stream && scenario==='auth') return {ok:false,status:401,text:async()=> 'unauthorized'};
    if(scenario==='network') throw new Error('network disconnected');
    if(stream && scenario==='empty') return streamResponseEmpty();
    return stream ? streamResponse(request.providerKind,scenario==='partial') : {ok:true,json:async()=>jsonResponse(request.providerKind)};
  }},
  './api-log-store': {pushApiLog:entry=>logs.push(entry)},
  './chat-avatar-intent': {applyWithProtectedAvatarDecisionMarkers:(text,fn)=>fn(text)},
  './llm-prompt-assembler': {applyOutputRegex:text=>text},
  './macro-engine': {MacroEngine:class{}},
};
function streamResponseEmpty(){return {ok:true,body:{getReader:()=>({read:async()=>({done:true})})}};}
function load(name) {
  if(stubs[name]) return stubs[name];
  if(modules.has(name)) return modules.get(name);
  if(!['./chat-engine','./api-helpers','./llm-provider-adapter','./generation-parameters','./preset-streaming','./sse-json'].includes(name)) return empty;
  const file='lib/'+name.slice(2)+'.ts';
  const exports={};modules.set(name,exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports,require:load,console:quiet,Error,DOMException,AbortController,TextDecoder,TextEncoder,setTimeout,clearTimeout},{filename:file});
  return exports;
}
async function main(){
  const policy=load('./preset-streaming'), engine=load('./chat-engine');
  const settings={}; let cached=[];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/settings-storage.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports:settings,console:quiet,window:{dispatchEvent(){}},CustomEvent:class{},require:name=>{
      if(name==='./settings-db')return {readPresetsCache:()=>cached,writePresetsCache:value=>{cached=value;}};
      if(name==='./story-default-prompt')return {migrateBuiltinStoryNarration:p=>p};
      if(name==='./moments-default-prompt')return {migrateBuiltinMomentsActions:p=>p};
      if(name==='./generation-parameters')return load(name);
      return empty;
    }});
  assert.equal(settings.createPreset('new').streaming_mode,'auto');
  for(const mode of [undefined,'auto','stream','non-stream','invalid']){
    const imported=settings.parsePresetFromJson(JSON.stringify({name:'test',temperature:.85,streaming_mode:mode,prompts:[]}));
    const expected=mode==='invalid'?undefined:mode;
    assert.ok(imported); assert.equal(imported.streaming_mode,expected); assert.equal(imported.temperature,.85);
    settings.savePresets([imported]);
    const roundTrip=settings.parsePresetFromJson(JSON.stringify(cached[0]));
    assert.equal(roundTrip.streaming_mode,expected,'save/export/import preserves transport selection');
  }
  const messages=[{role:'user',content:'test'}];
  for(const mode of [undefined,'auto','stream','non-stream']) for(const app of [false,true]) {
    assert.equal(policy.usePresetStreaming({streaming_mode:mode},app),mode===undefined?app:mode!=='non-stream');
  }
  let count=0;
  for(const provider of ['OpenAI','Anthropic','Google']) for(const mode of [undefined,'auto','stream','non-stream']) for(const entry of ['sendLLMRequest','sendLLMStreamRequest','sendLLMRequestPreferStream','sendLLMToolRequest','sendLLMToolStreamRequest']) {
    const config={provider,defaultModel:'test',apiKey:'fake-test-key'};
    const preset={streaming_mode:mode,temperature:.9,top_p:1,top_k:0,openai_max_tokens:500,prompts:[]};
    const streamingEntry=entry.includes('Stream');
    const native=entry.includes('Tool');
    let visible='', reasoning='';
    requests.length=0;logs.length=0;scenario='success';
    const options={includeReasoning:!native,skipOutputRegex:true,onReasoning:text=>reasoning+=text};
    const args=[config,preset,messages,...(native?[[]]:[]),[],{},options];
    if(entry==='sendLLMStreamRequest'||entry==='sendLLMToolStreamRequest')args.push({onDelta:t=>visible+=t,onReasoningDelta:t=>reasoning+=t});
    const result=await engine[entry](...args);
    const expected=mode===undefined?streamingEntry:mode!=='non-stream';
    assert.equal(requests.length,1,`${entry}/${provider}/${mode}`);
    assert.equal(requests[0].body.stream===true||requests[0].url.includes('streamGenerateContent'),expected);
    const content=typeof result==='string'?result:result.content;
    assert.ok(content.includes(expected?'hello':'complete'));
    assert.equal(logs.length,1,'one generation/log per request');
    if(!streamingEntry||mode==='non-stream')assert.equal(visible,'','buffered/disabled output cannot emit text deltas');
    if(!native)assert.ok(reasoning.includes('reason'));
    count++;
  }
  for(const entry of ['sendLLMRequest','sendLLMStreamRequest','sendLLMRequestPreferStream','sendLLMToolRequest','sendLLMToolStreamRequest']) {
    for(const mode of ['auto','stream','non-stream']) for(const failure of ['unsupported','partial','network','auth','empty']){
      requests.length=0;scenario=failure;
      const args=[{provider:'OpenAI',defaultModel:'test',apiKey:'fake'}, {streaming_mode:mode},messages,...(entry.includes('Tool')?[[]]:[]),[],{},{skipOutputRegex:true}];
      const run=()=>engine[entry](...args);
      if(mode==='non-stream'&&failure!=='network'||mode==='auto'&&failure==='unsupported') await run();
      else await assert.rejects(run);
      assert.equal(requests.length,mode==='auto'&&failure==='unsupported'?2:1,`${entry}/${mode}/${failure} must not double-generate`);
      count++;
    }
  }
  let retried=0; const controller=new AbortController();controller.abort();
  await assert.rejects(()=>policy.requestWithPresetStreaming({streaming_mode:'auto'},true,async()=>{throw new Error('API Stream Error 400: stream unsupported');},async()=>{retried++;},controller.signal));
  assert.equal(retried,0);
  scenario='tools';
  for(const provider of ['OpenAI','Anthropic','Google'])for(const mode of ['auto','stream','non-stream'])for(const entry of ['sendLLMToolRequest','sendLLMToolStreamRequest']){
    requests.length=0;
    const result=await engine[entry]({provider,defaultModel:'test',apiKey:'fake'},{streaming_mode:mode},messages,[{name:'inspect',description:'test',parameters:{type:'object'}}],[],{},{maxTokens:777});
    assert.equal(result.toolCalls.length,1); assert.equal(result.toolCalls[0].name,'inspect'); assert.equal(result.toolCalls[0].args.value,7);
    if(provider==='Google')assert.equal(result.toolCalls[0].thoughtSignature,'signature');
    assert.equal(requests.length,1);count++;
  }
  for(const file of ['lib/chat-engine.ts','lib/group-chat-engine.ts']){
    const source=fs.readFileSync(file,'utf8');
    assert.equal((source.match(/!preset\?\.streaming_mode && isSessionStreamingEnabled\(session, true\)/g)||[]).length,3,'online display stays buffered for preset modes');
    assert.ok(source.includes('usePresetStreaming(preset, isSessionStreamingEnabled(session, false))'),'offline display follows preset');
  }
  const story=fs.readFileSync('lib/story-engine.ts','utf8'), storyUI=fs.readFileSync('components/story/story-app-base.tsx','utf8');
  assert.ok(story.includes('usePresetStreaming(preset, options?.globalSettings?.streamingEnabled === true)'));
  assert.equal((storyUI.match(/onDelta: \(delta\) => appendStoryStreamDelta/g)||[]).length,3);
  const cocreate=fs.readFileSync('lib/cocreate-engine.ts','utf8');
  assert.ok(cocreate.includes('if (!streamedRaw) streamedRaw = streamResult.content'));
  assert.ok(!cocreate.includes('onStreamFallback?.(formatErrorMessage(streamError))'));
  for(const file of ['lib/memory-summarizer.ts','lib/core-memory-builder.ts','lib/memory-rebuild.ts']) assert.ok(/temperature:\s*(?:0)?\.3/.test(fs.readFileSync(file,'utf8')),'summary temperature unchanged');
  console.log(`PASS ${count} real transport cases: three providers, all preset modes, normal/native tools, buffered online, narrative wiring, strict fallback, partial/empty/auth/network no duplicate, summary temperature unchanged.`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
