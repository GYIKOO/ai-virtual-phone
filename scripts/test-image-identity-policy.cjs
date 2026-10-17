// Exercise real storage normalization, UI mount/update callbacks and final image
// request assembly. Network, canvas and media storage are substituted locally.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function pick(file,names){
 const source=fs.readFileSync(file,'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 return tree.statements.filter(n=>ts.isFunctionDeclaration(n)?names.includes(n.name?.text):
  ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>names.includes(d.name.getText(tree)))).map(n=>n.getText(tree)).join('\n');
}
function evaluate(source,globals={}){
 const context=vm.createContext({exports:{},console,Date,Map,Set,AbortController,setTimeout,clearTimeout,...globals});
 vm.runInContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 return context;
}
const nai=evaluate(fs.readFileSync('lib/novelai-image-config.ts','utf8')).exports;
const kv=new Map();
const storage=evaluate(pick('lib/settings-storage.ts',['IMAGE_GENERATION_SETTINGS_KEY','DEFAULT_NOVELAI_PRESET','DEFAULT_IMAGE_GENERATION_SETTINGS',
 'normalizeNovelAiPreset','normalizeOpenAiPreset','normalizeImageGenerationSettings','loadImageGenerationSettings','saveImageGenerationSettings']),
 {...nai,window:{dispatchEvent(){}},CustomEvent:class{},kvGet:k=>kv.get(k),kvSet:(k,v)=>kv.set(k,v)}).exports;
let settings=storage.DEFAULT_IMAGE_GENERATION_SETTINGS;
function roundtrip(value){storage.saveImageGenerationSettings(value);return storage.loadImageGenerationSettings();}
const ratios=evaluate(pick('components/settings/image-generation-settings.tsx',['RATIO_HINT_MARKER','SIZE_RATIO_HINTS','stripRatioHint','withRatioHint']));
const uiSource=fs.readFileSync('components/settings/image-generation-settings.tsx','utf8');
const uiTree=ts.createSourceFile('ui.tsx',uiSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let mount;
function visit(node){if(!mount&&ts.isCallExpression(node)&&node.expression.getText(uiTree)==='useEffect')mount=node.arguments[0].getText(uiTree);ts.forEachChild(node,visit);} visit(uiTree);
const hint=vm.runInContext("withRatioHint('', '1024x1024')",ratios);
for(const prompt of ['',hint+' 自定义尾巴',hint+'\n自定义另一行','【画面比例】我自己改的构图','纯自定义']){
 settings=roundtrip({...settings,openaiPresets:[{id:'p',name:'',extraPrompt:prompt}],activeOpenAiPresetId:'p',
  userReferences:{u:{updatedAt:1,featurePrompt:'USER_FEATURE',enabled:false}}});
 assert.equal(settings.extraPrompt,prompt);assert.equal(settings.userReferences.u.featurePrompt,'USER_FEATURE');
 const before=JSON.stringify(settings);let mounted;
 evaluate(`(${mount})()`,{loadImageGenerationSettings:storage.loadImageGenerationSettings,setSettings:s=>mounted=s,
  saveImageGenerationSettings:()=>assert.fail('mount must not overwrite saved prompt'),loadCharacters:()=>[],loadUserIdentities:()=>[],
  setUserIdentities(){},setCharacters(){},setSelectedCharacterId(){}});
 assert.equal(JSON.stringify(mounted),before);
 ratios.prompt=prompt;
 const resized=vm.runInContext("withRatioHint(prompt,'1536x1024')",ratios);
 if(prompt.includes('自定义'))assert.ok(resized.includes(prompt.startsWith('纯')?prompt:prompt.includes('另一行')?'自定义另一行':'自定义尾巴'));
 if(prompt.includes('我自己'))assert.equal(resized,prompt);
}
const binding=evaluate(fs.readFileSync('lib/image-generation-binding.ts','utf8')).exports;
const selection=evaluate(fs.readFileSync('lib/image-reference-selection.ts','utf8')).exports;
let bound='u',requests=[],assetReads=[];
const request=async p=>{requests.push(p);return {b64:'ZmFrZQ==',mimeType:'image/png'};};
const globals={...binding,...selection,DEFAULT_NOVELAI_PRESET:storage.DEFAULT_NOVELAI_PRESET,
 loadImageGenerationSettings:()=>settings,loadBindingConfig:()=>({}),resolveBinding:()=>({userIdentityId:bound}),
 loadUserIdentities:()=>[{id:'u',name:'测试用户'},{id:'v',name:'另一用户'}],
 generateNovelAiDirect:request,generateNovelAiViaServer:request,generateImageDirect:request,generateImageViaServerOrProxy:request,
 getChatImageFromIndexedDB:async id=>{assetReads.push(id);return 'data:'+id;},normalizeReferenceImageForEdit:async x=>x,
 combineReferenceImagesForEdit:async refs=>refs.length?JSON.stringify(refs):undefined,
 base64ToBlob:()=>({}),storeMediaBlob:async()=> 'media:test',throwIfAborted:signal=>{if(signal?.aborted)throw Error('aborted');}};
const service=evaluate(pick('lib/image-generation-service.ts',['mergePrompt','resolveGenerationUserIdentityId','generateImageFromConfiguredApi',
 'hasCharacterImageIdentity','hasUserImageIdentity']),globals).exports;
const dwelling=evaluate(fs.readFileSync('lib/dwelling-image.ts','utf8'),{require:name=>({
 './dwelling-storage':{loadDwellingImageEnabled:()=>true},'./settings-storage':globals,
 './image-generation-binding':binding,'./image-generation-service':service})[name]||{}}).exports;
function setup(provider,mode){
 settings=roundtrip({...storage.DEFAULT_IMAGE_GENERATION_SETTINGS,enabled:true,provider,requestMode:mode,apiKey:'fixture',baseUrl:'https://fixture.invalid',model:'fixture',
  extraPrompt:'STYLE_ONLY',novelai:{apiKey:'fixture',requestMode:mode,presets:[{...storage.DEFAULT_NOVELAI_PRESET,positivePrompt:'STYLE_ONLY'}]},
  characterReferences:{c:{updatedAt:1,featurePrompt:'CHAR_FEATURE',assetId:'char-image',anchors:[{id:'anchor',name:'服装',category:'clothing',enabled:true,description:'CHAR_ANCHOR',assetId:'anchor-image',updatedAt:1}]}},
  userReferences:{u:{updatedAt:1,featurePrompt:'USER_FEATURE',assetId:'user-image'},v:{updatedAt:1,featurePrompt:'OTHER_USER'}}});
 requests=[];assetReads=[];bound='u';
}
(async()=>{
 for(const provider of ['openai','novelai'])for(const mode of ['direct','server']){
  setup(provider,mode);
  for(const appId of ['chat','moments','custom_app']){
   assetReads=[];
   const scene=await service.generateImageFromConfiguredApi({characterId:'c',appId,description:'窗边的一杯咖啡',useReferenceImage:false});
   assert.ok(!/CHAR_FEATURE|CHAR_ANCHOR|USER_FEATURE/.test(scene.prompt));assert.equal(assetReads.length,0);
   const portrait=await service.generateImageFromConfiguredApi({characterId:'c',appId,description:'角色自拍',useReferenceImage:true});
   assert.ok(portrait.prompt.includes('CHAR_FEATURE')&&portrait.prompt.includes('CHAR_ANCHOR'));
   assert.ok(!portrait.prompt.includes('USER_FEATURE'));
   const both=await service.generateImageFromConfiguredApi({characterId:'c',appId,description:'角色和测试用户合影',useReferenceImage:true});
   assert.ok(both.prompt.includes('USER_FEATURE')&&both.prompt.includes('CHAR_FEATURE'));
  }
  assetReads=[];
  const room=await dwelling.generateDwellingRoomImage('c',{id:'room',name:'测试用户曾到访的客厅',furniture:[]});
  assert.equal(room.assetId,'media:test');assert.ok(requests.at(-1).prompt.includes('没有任何人物'));
  assert.ok(!/CHAR_FEATURE|CHAR_ANCHOR|USER_FEATURE/.test(requests.at(-1).prompt));assert.equal(assetReads.length,0);
  settings.characterReferences.c.assetId=undefined;settings.characterReferences.c.anchors=[];settings.userReferences.u.assetId=undefined;
  assert.equal(service.hasCharacterImageIdentity('c'),true);assert.equal(service.hasUserImageIdentity('c'),true);
  const userOnly=await service.generateImageFromConfiguredApi({characterId:'c',description:'测试用户的肖像',useReferenceImage:false});
  assert.ok(userOnly.prompt.includes('USER_FEATURE')&&!userOnly.prompt.includes('CHAR_FEATURE'));
  bound='v';const other=await service.generateImageFromConfiguredApi({characterId:'c',description:'另一用户的肖像',useReferenceImage:false});
  assert.ok(other.prompt.includes('OTHER_USER')&&!other.prompt.includes('USER_FEATURE'));
  bound='u';const blocked=await service.generateImageFromConfiguredApi({characterId:'c',description:'测试用户的肖像',includeUserReferenceImage:false});
  assert.ok(!blocked.prompt.includes('USER_FEATURE'));
 }
 console.log('PASS: exact prompt persistence/reopening/clearing/ratio edits; both providers and transports; scenery excludes identities/anchors/images; portraits retain appearance; dwelling remains unoccupied; user text-only identity bindings and permission gates.');
})().catch(error=>{console.error(error);process.exitCode=1;});
