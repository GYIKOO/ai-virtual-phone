const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function nodeFrom(file, predicate) {
  const source = fs.readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function walk(node) { if (predicate(node)) found = node; ts.forEachChild(node, walk); }
  walk(tree); assert.ok(found, file);
  return found.getText(tree);
}
const openSource = nodeFrom('components/desktop-shell.tsx', n => ts.isFunctionDeclaration(n) && n.name?.text === 'openWorldBuilder');
const backSource = nodeFrom('components/world-builder/WorldBuilder.tsx', n => ts.isVariableDeclaration(n) && n.name.getText() === 'handleBack');
const detectSource = fs.readFileSync('lib/shell-detect.ts', 'utf8');
const componentSource = fs.readFileSync('components/world-builder/WorldBuilder.tsx', 'utf8');
assert.equal((componentSource.match(/onClick=\{handleBack\}/g) || []).length, 2, 'toolbar and loading screen share return handler');
function environment({shell=false, popup=true, closes=false, focusThrows=false, closeThrows=false, hasOpener=true} = {}) {
  const timers = new Map(), navigations = [];
  let timerId=0, opened=0, focused=0, closeCalls=0, html='';
  const setTimeout=(fn)=>{timers.set(++timerId,fn);return timerId;};
  const clearTimeout=id=>timers.delete(id);
  const window={closed:false, location:{origin:'https://fixture.invalid',href:'',replace:url=>navigations.push(url)},
    opener:hasOpener ? {closed:false,focus(){focused++;if(focusThrows)throw Error('opener blocked');}} : null,
    close(){closeCalls++;if(closeThrows)throw Error('close blocked');if(closes)window.closed=true;},
    open(){opened++;return popup ? {document:{open(){},write(value){html=value;},close(){}}} : null;},setTimeout};
  const context=vm.createContext({window,navigator:{userAgent:shell?'Android FloatShell/1':'Browser'},URL,setTimeout,clearTimeout,
    exports:{},useCallback:fn=>fn});
  const js=ts.transpileModule(`${detectSource}\n${openSource}\nconst ${backSource};`,
    {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInContext(js,context);
  return {window,navigations,run:code=>vm.runInContext(code,context),
    flush(){for(const [id,fn] of [...timers]){timers.delete(id);fn();}},
    get html(){return html;},get opened(){return opened;},get focused(){return focused;},get closeCalls(){return closeCalls;}};
}
const apk=environment({shell:true});
apk.run("openWorldBuilder('/world-builder')");
assert.equal(apk.opened,0);assert.equal(apk.window.location.href,'https://fixture.invalid/world-builder');
apk.run('handleBack()');assert.deepEqual(apk.navigations,['/']);assert.equal(apk.closeCalls,0,'APK never attempts to close its only view');
const web=environment({closes:true});web.run("openWorldBuilder('/world-builder')");
assert.equal(web.opened,1);assert.equal(web.window.location.href,'');assert.ok(web.html.includes('正在搭建筑境'));
web.run('handleBack()');web.flush();assert.equal(web.focused,1);assert.equal(web.window.closed,true);assert.deepEqual(web.navigations,[]);
const blocked=environment({popup:false,hasOpener:false});blocked.run("openWorldBuilder('/world-builder')");
assert.equal(blocked.window.location.href,'https://fixture.invalid/world-builder');blocked.run('handleBack()');blocked.flush();assert.deepEqual(blocked.navigations,['/']);
for (const opts of [{},{focusThrows:true},{closeThrows:true},{hasOpener:false},{focusThrows:true,closeThrows:true}]) {
  const e=environment(opts);e.run('handleBack()');e.flush();assert.deepEqual(e.navigations,['/'],'failed close returns home');
}
const bootScript=web.html.match(/<script>([\s\S]*?)<\/script>/)[1];
for (const opts of [{},{closes:true},{focusThrows:true,closeThrows:true},{hasOpener:false}]) {
  const e=environment(opts);e.run(bootScript);e.run('returnToPhone()');e.flush();
  assert.deepEqual(e.navigations,opts.closes?[]:['/'],'return cancels pending entry into builder');
}
const boot=environment();boot.run(bootScript);boot.flush();assert.deepEqual(boot.navigations,['https://fixture.invalid/world-builder']);
console.log('PASS: APK same-view entry/home return; browser popup/close and blocked-popup fallback; loading return cancels entry; opener/close failures remain escapable.');
