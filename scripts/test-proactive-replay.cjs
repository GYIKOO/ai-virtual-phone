const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, deps = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, Date, require: name => { if (!(name in deps)) throw new Error(name); return deps[name]; } });
  return exports;
}
const replay = load('lib/proactive-replay.ts');
const time = h => Date.parse(`2026-10-05T${h}:00:00Z`);
const iso = h => new Date(time(h)).toISOString();
assert.equal(replay.replayTime({ personalityAt: time('08') }, 'personality', time('10')), time('08'));
assert.equal(replay.replayTime({ personalityAt: time('08'), deferred: { personality: true } }, 'personality', time('10')), undefined);
assert.equal(replay.replayTime({ personalityAt: time('11') }, 'personality', time('10')), undefined);
assert.equal(replay.knownAt('invalid', time('09')), false);
const memories = [
  { id: 'past', createdAt: iso('07'), updatedAt: iso('08'), content: 'past' },
  { id: 'future', createdAt: iso('10'), updatedAt: iso('10'), content: 'future' },
  { id: 'edited', createdAt: iso('07'), updatedAt: iso('10'), content: 'later edit' },
];
const service = load('lib/memory-service.ts', {
  './proactive-replay': replay,
  './memory-storage': { loadMemoryEntriesByType: async () => memories },
  './settings-storage': { resolveAuxiliaryApiConfig: () => null },
  './memory-embedding': {}, './token-counter': { estimateTokens: () => 1 },
});
(async () => {
  const config = { longTermTokenBudget: 100, coreMemoryTokenBudget: 100, vectorRecallEnabled: false };
  assert.equal((await service.retrieveMemoriesForPrompt('c', 'context', config, time('09'))).map(x => x.id).join(), 'past');
  assert.equal((await service.retrieveCoreMemoriesForPrompt('c', config, time('09'))).map(x => x.id).join(), 'past');
  assert.equal((await service.retrieveMemoriesForPrompt('c', 'context', config)).length, 3, 'normal generation unchanged');
  const parser = fs.readFileSync('lib/follow-up-service.ts', 'utf8');
  assert.ok(parser.indexOf('if (options?.historicalReplay && p.mediaType) continue;') < parser.indexOf('if (p.mediaType === "voice_call")'), 'replay media filtered before side effects');
  assert.ok(parser.includes('proactiveTiming: options?.proactiveTiming'));
  for (const file of ['lib/chat-engine.ts', 'lib/group-chat-engine.ts']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes('new Date(options?.historicalAt ?? Date.now())'));
    assert.ok(source.includes('historicalAt: options?.historicalAt'));
    assert.ok(source.includes('memConfig, options?.historicalAt)'));
  }
  console.log('PASS: replay deadlines, quiet exclusion, temporal memory filtering and historical builder/side-effect guards.');
})().catch(e => { console.error(e); process.exitCode = 1; });
