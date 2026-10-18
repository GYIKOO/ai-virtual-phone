const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const { indexedDB } = require(path.join(process.env.FLOAT_TEST_DEPS || '.', 'node_modules/fake-indexeddb'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function compile(file, require, extras = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText, {exports, require, console, setTimeout, clearTimeout, ...extras}, {filename:file});
  return exports;
}
class CustomEvent extends Event { constructor(type, options) { super(type); this.detail = options?.detail; } }
class BroadcastChannel extends EventTarget {
  static channels = [];
  constructor(name) { super();this.name=name;BroadcastChannel.channels.push(this); }
  postMessage(data) { for(const channel of BroadcastChannel.channels) if(channel!==this && channel.name===this.name) channel.dispatchEvent(new MessageEvent('message',{data})); }
}
const window = new EventTarget();
window.localStorage = {};
const types = compile('lib/theme-types.ts', () => { throw Error('unexpected import'); });
let opens = 0, transactions = 0, closes = 0, broken = false;
const dbOpen = {
  openIndexedDbAtLeast(name, version, upgrade) {
    opens++;
    return new Promise((resolve, reject) => {
      if (broken) return reject(Error('synthetic unavailable database'));
      const req = indexedDB.open(name, version);
      req.onupgradeneeded = e => upgrade(req.result, e.oldVersion, req.transaction);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result, original = db.transaction.bind(db), close = db.close.bind(db);
        db.transaction = (...args) => { transactions++; return original(...args); };
        db.close = () => { closes++; close(); };
        resolve(db);
      };
    });
  },
};
const storage = compile('lib/theme-storage.ts', name => {
  if (name === '@/lib/theme-types') return types;
  if (name === './idb-open') return dbOpen;
  if (name === './kv-db') return {registerKvMigration() {}};
  if (name === './theme-preset-storage') return {themePresetUsesAsset: () => false};
  throw Error(name);
}, {window, indexedDB, CustomEvent, BroadcastChannel});

async function testStorage() {
  const events = [];
  window.addEventListener(storage.THEME_ASSETS_UPDATED_EVENT, e => events.push(...e.detail.ids));
  const records = Array.from({length:100}, (_,i) => ({id:`asset-${i}`,type:'wallpaper',mimeType:'image/png',dataUrl:`data:image/png;base64,${i}`,updatedAt:'now'}));
  await storage.writeThemeAssetRecords(records);
  assert.equal(events.length,100);
  opens = transactions = closes = 0;
  const ids = records.map(r => r.id);
  const map = await storage.getThemeAssetMap([...ids,...ids,'missing','https://example.invalid/a.png']);
  assert.equal(Object.keys(map).length,101);
  assert.deepEqual([opens,transactions,closes],[1,1,1], '100 assets use one connection and transaction');
  assert.equal(map[ids[0]],records[0].dataUrl);
  opens = transactions = closes = 0;
  await storage.getThemeAssetMap(['data:image/png;base64,a','blob:local']);
  await storage.readThemeAssetRecords([]);
  assert.equal(opens,0,'direct URLs and empty batches do not open IDB');
  await storage.writeThemeAssetRecords([{...records[0],dataUrl:'replacement'}]);
  assert.equal(await storage.getThemeAssetDataUrl(ids[0]),'replacement');
  await storage.deleteThemeAsset(ids[0]);
  assert.equal(await storage.getThemeAssetDataUrl(ids[0]),null);
  broken = true;
  assert.equal(Object.keys(await storage.getThemeAssetMap(ids)).length,0);
  await assert.rejects(storage.getThemeAssetMap(ids,{requireDatabase:true}),/database unavailable/);
  broken = false;
  assert.equal(Object.keys(await storage.getThemeAssetMap(ids)).length,99,'failure remains retryable');
  const profile = {...types.DEFAULT_THEME_PROFILE,wallpaperAssetId:'active',fontAssetId:'font',wallpaperLibrary:['unused'],iconSkins:{chat:'legacy'},activeIconSchemeId:'a',iconSchemes:[{id:'a',iconSkins:{chat:'active-icon'}},{id:'b',iconSkins:{chat:'unused-icon'}}]};
  assert.deepEqual([...storage.collectDesktopThemeAssetIds(profile)].sort(),['active','active-icon','font']);
  const remoteChanges = [], stop = storage.subscribeThemeAssetChanges(ids=>remoteChanges.push([...ids]));
  const peer = new BroadcastChannel(storage.THEME_ASSETS_UPDATED_EVENT);
  peer.postMessage({ids:['replaced-in-another-tab']});
  peer.postMessage({ids:'malformed'});
  assert.deepEqual(remoteChanges,[['replaced-in-another-tab']]);
  stop();peer.postMessage({ids:['after-unsubscribe']});assert.equal(remoteChanges.length,1);
  console.log('PASS batch reads, missing/direct URLs, writes/deletes, failures and active-only selection');
}

async function testHook() {
  // Deterministic effect lifecycle harness, including StrictMode cleanup/replay.
  let slots = [], cursor = 0, effects = [], pending = [], rejects = [], requests = [], rerender = false;
  const react = {
    useState(initial) { const i=cursor++; if (!slots[i]) slots[i]={value:typeof initial==='function'?initial():initial}; return [slots[i].value, value => {slots[i].value=typeof value==='function'?value(slots[i].value):value; rerender=true;}]; },
    useRef(initial) { const i=cursor++; return slots[i] ??= {current:initial}; },
    useEffect(fn,deps) { const i=cursor++; const old=slots[i]; if (!old || deps.some((v,j)=>v!==old.deps[j])) { old?.cleanup?.(); slots[i]={deps,fn}; effects.push(()=>{slots[i].cleanup=fn();}); } },
  };
  const hook = compile('components/use-desktop-theme-assets.ts', name => {
    if (name === 'react') return react;
    if (name === '@/lib/theme-storage') return {...storage,getThemeAssetMap(ids, options) { assert.equal(options.requireDatabase,true); requests.push([...ids]); return new Promise((resolve,reject) => {pending.push(resolve);rejects.push(reject);}); }};
    throw Error(name);
  }, {window});
  const profile = {...types.DEFAULT_THEME_PROFILE, wallpaperAssetId:'one'};
  let current = profile, value;
  const render = () => { cursor=0;rerender=false; value=hook.useDesktopThemeAssets(current,{one:'seed'});const run=effects;effects=[];run.forEach(fn=>fn()); };
  const flush = async () => { await tick(); if(rerender) render(); };
  render();
  assert.equal(requests.length,0,'first-paint assets reused');
  current={...profile,wallpaperBlur:20};render();
  assert.equal(requests.length,0,'non-asset edits never reread');
  current={...profile,wallpaperAssetId:'two'};render();
  assert.deepEqual(requests,[['two']]);
  // StrictMode replay before the first request completes.
  for (const slot of slots) if(slot?.fn) {slot.cleanup?.();slot.cleanup=slot.fn();}
  assert.equal(requests.length,2);
  pending.shift()({two:'cancelled'});await flush();assert.equal(value.two,undefined);
  pending.shift()({two:'fresh'});await flush();assert.equal(value.two,'fresh');
  window.dispatchEvent(new CustomEvent(storage.THEME_ASSETS_UPDATED_EVENT,{detail:{ids:['two']}}));
  await flush();assert.equal(value.two,'fresh','revalidation does not flash blank');
  pending.shift()({two:'replacement'});await flush();assert.equal(value.two,'replacement');
  current={...profile,wallpaperAssetId:'slow'};render();
  current={...profile,wallpaperAssetId:'fast'};render();
  pending.shift()({slow:'stale'});await flush();assert.equal(value.slow,undefined,'obsolete response ignored');
  pending.shift()({fast:'current'});await flush();assert.equal(value.fast,'current');
  window.dispatchEvent(new Event('focus'));await flush();assert.equal(value.fast,'current');
  pending.shift()({});await flush();assert.equal(value.fast,undefined,'removed resource cleared after revalidation');
  window.dispatchEvent(new Event('focus'));await flush();pending.shift()({fast:'restored'});await flush();assert.equal(value.fast,'restored');
  const count = requests.length;
  window.dispatchEvent(new CustomEvent(storage.THEME_ASSETS_UPDATED_EVENT,{detail:{ids:['unrelated-sticker']}}));await flush();assert.equal(requests.length,count);
  window.dispatchEvent(new Event('focus'));await flush();pending.shift();rejects.at(-1)(Error('synthetic unavailable database'));await flush();assert.equal(value.fast,'restored','read failure preserves the displayed wallpaper');
  window.dispatchEvent(new Event('focus'));await flush();pending.shift()({fast:'retried'});await flush();assert.equal(value.fast,'retried');
  slots.forEach(slot=>slot?.cleanup?.());
  console.log('PASS seed reuse, style edits, StrictMode replay, same-ID replacement, stale reads, refocus and retry');
}

async function testFonts() {
  let node = null, calls = [], timeout;
  const document = {getElementById:()=>node,createElement:()=>({textContent:''}),head:{append:n=>{node=n;}},fonts:{load:(...args)=>{calls.push(args);return Promise.resolve([]);}}};
  const fonts = compile('lib/desktop-theme-preload.ts',()=>{}, {document,setTimeout:fn=>{timeout=fn;return 1;},clearTimeout(){}});
  await fonts.warmDesktopBuiltinFonts();assert.equal(calls.length,3);
  await fonts.prepareDesktopFont('data:font/woff2;base64,foo');
  assert.ok(node.textContent.includes('AIVirtualPhoneUserFont'));
  assert.ok(calls.at(-1)[0].includes('AIVirtualPhoneUserFont'));
  document.fonts.load=()=>new Promise(()=>{});
  const stalled = fonts.prepareDesktopFont('font');await tick();timeout();await stalled;
  fonts.installDesktopFont(null);assert.equal(node.textContent,'');
  document.fonts.load=()=>{throw Error('font unavailable');};await fonts.warmDesktopBuiltinFonts();
  console.log('PASS limited builtin warmup, shared font declaration, bounded wait and font errors');
}
(async()=>{await testStorage();await testHook();await testFonts();})().catch(error=>{console.error(error);process.exitCode=1;});
