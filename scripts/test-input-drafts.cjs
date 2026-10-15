// Real React/DOM editing tests in an isolated browser; no Float data or model APIs.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const ts = require('typescript');

function avatarRegression() {
  const source = fs.readFileSync('components/chat/chat-message-list.tsx', 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('const groupAvatarItems =');
  const end = source.indexOf('\n\n    return (', start);
  assert.ok(start >= 0 && end > start);
  const compiled = ts.transpileModule(source.slice(start, end) + '\nresult = groupAvatarItems;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const chars = ['a','b','c','d','e'].map(id => ({ id, name: id, avatar: id + '.png' }));
  for (const spectator of [false, true]) {
    const context = { isGroup: true, session: { isSpectator: spectator, participantIds: ['missing', ...chars.map(c=>c.id)] }, chars,
      userIdentity: { name: 'User', avatarUrl: 'self.png' } };
    vm.runInNewContext(compiled, context);
    assert.equal(context.result.length, 4);
    assert.equal(context.result.some(c => c.id === 'self'), !spectator);
    assert.deepEqual(Array.from(context.result, c=>c.id), spectator ? ['a','b','c','d'] : ['self','a','b','c']);
  }
  console.log('PASS: actual group avatar expression excludes spectator user, retains normal membership, filters missing characters and caps at four.');
}

// A small CommonJS browser loader for the installed React packages; no downloaded dependencies.
function browserBundle() {
  const modules = new Map();
  function add(file, supplied) {
    if (modules.has(file)) return file;
    const source = supplied ?? fs.readFileSync(file, 'utf8');
    const dependencies = {};
    modules.set(file, { source, dependencies });
    for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const resolved = require.resolve(match[1], { paths: [path.dirname(file)] });
      dependencies[match[1]] = add(resolved);
    }
    return file;
  }
  const inputPath = path.resolve('components/ui/number-input.tsx');
  add(inputPath, ts.transpileModule(fs.readFileSync(inputPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  const react = add(require.resolve('react')), dom = add(require.resolve('react-dom/client'));
  const entries = [...modules].map(([file, m]) => `${JSON.stringify(file)}:[function(module,exports,require){\n${m.source}\n},${JSON.stringify(m.dependencies)}]`).join(',\n');
  return `(()=>{const process={env:{NODE_ENV:'production'}},modules={${entries}},cache={};
    function load(id){if(cache[id])return cache[id].exports;const module={exports:{}};cache[id]=module;const [factory,deps]=modules[id];factory(module,module.exports,name=>load(deps[name]));return module.exports;}
    const React=load(${JSON.stringify(react)}),{createRoot}=load(${JSON.stringify(dom)}),{NumberInput}=load(${JSON.stringify(inputPath)});
    const h=React.createElement,root=createRoot(document.getElementById('root'));
    let generation=0;
    window.setup=options=>{root.render(h(Fixture,{key:++generation,...options}));};
    function Fixture({initial=60,min=0,max=10080,step=1,normalize=x=>x}){
      const [value,setValue]=React.useState(initial),[saved,setSaved]=React.useState(null),[commits,setCommits]=React.useState(0);
      return h('div',null,h(NumberInput,{'aria-label':'Number',value,min,max,step,onValueChange:n=>{setValue(normalize(n));setCommits(c=>c+1);}}),
        h('output',{id:'value'},String(value)),h('output',{id:'commits'},String(commits)),h('output',{id:'saved'},saved===null?'':String(saved)),
        h('button',{id:'save',onClick:()=>setSaved(value)},'Save'),h('button',{id:'external',onClick:()=>setValue(25)},'External update'));
    }
    window.setup({});})();`;
}

async function main() {
  avatarRegression();
  const { chromium } = require(process.env.FLOAT_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true, channel: process.env.FLOAT_BROWSER_CHANNEL || 'msedge' });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e=>errors.push(e.message));
    await page.route('**/*', r=>r.abort());
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: browserBundle() });
    const input = page.getByRole('spinbutton', { name: 'Number' });
    const value = () => page.locator('#value').textContent();
    const setup = async opts => { await page.evaluate(opts=>window.setup(opts),opts); await page.waitForFunction(n=>document.querySelector('#value')?.textContent===String(n),opts.initial); };
    await input.fill(''); assert.equal(await input.inputValue(), ''); assert.equal(await value(),'60');
    await input.pressSequentially('15'); assert.equal(await input.inputValue(),'15'); assert.equal(await value(),'60');
    await page.locator('#save').click(); assert.equal(await value(),'15'); assert.equal(await page.locator('#saved').textContent(),'15');
    await input.fill(''); await input.blur(); assert.equal(await input.inputValue(),'15');
    await input.fill('0'); await input.press('Enter'); assert.equal(await value(),'0');
    await input.fill(''); await input.blur(); assert.equal(await input.inputValue(),'0');
    await input.fill('999999'); assert.equal(await input.inputValue(),'999999'); await input.blur(); assert.equal(await value(),'10080');
    await setup({initial:60,min:20,max:600});
    await input.fill(''); await input.pressSequentially('300'); assert.equal(await input.inputValue(),'300'); assert.equal(await value(),'60');
    await input.press('Enter'); assert.equal(await value(),'300');
    await input.fill('1'); assert.equal(await input.inputValue(),'1'); await input.blur(); assert.equal(await value(),'20');
    await setup({initial:6,min:1,max:30,step:0.1});
    await input.fill(''); await input.pressSequentially('1.5'); assert.equal(await input.inputValue(),'1.5'); await input.blur(); assert.equal(await value(),'1.5');
    await input.fill('10'); await input.press('Escape'); assert.equal(await value(),'1.5'); assert.equal(await input.inputValue(),'1.5');
    await page.locator('#external').click(); assert.equal(await input.inputValue(),'25');
    await setup({initial:5,min:-10,max:100,step:'any'});
    await input.fill(''); await input.pressSequentially('-2.5'); await input.blur(); assert.equal(await value(),'-2.5');
    await input.fill(''); await input.pressSequentially('1e'); await input.blur(); assert.equal(await value(),'-2.5');
    assert.deepEqual(errors, []);
    console.log('PASS: real React input clearing/retyping, one-shot save after blur, zero, bounds only on commit, decimals, negatives, invalid draft, Enter/Escape and external updates.');
  } finally { await browser.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
