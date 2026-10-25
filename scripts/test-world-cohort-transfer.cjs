// Storage-level regression: production transfer functions with isolated persistence.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const text = fs.readFileSync(path.join(__dirname, '../lib/character-world-storage.ts'), 'utf8');
const source = ts.createSourceFile('storage.ts', text, ts.ScriptTarget.Latest, true);
const names = new Set(['generateId', 'moveCharacterToWorld', 'moveCharactersToWorld']);
const code = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(source)).join('\n');
const copy = v => JSON.parse(JSON.stringify(v));
const relation = (id, fromCharacterId, toCharacterId, label = '朋友') => ({ id, fromCharacterId, toCharacterId, label });
const group = (id, memberIds, relations) => ({ id, memberIds, relations, description: id, userIdentityIds: ['u'], userNodes: { u: { canvasX: 42 } }, updatedAt: 'old' });
let groups, saves;
function reset() {
  saves = 0;
  groups = [
    group('source', ['a', 'b', 'c', 'd'], [relation('ab', 'a', 'b'), relation('ba', 'b', 'a', '同事'), relation('ac', 'a', 'c'), relation('cd', 'c', 'd'), relation('bu', 'b', 'user:u')]),
    group('second', ['e', 'f'], [relation('ef', 'e', 'f'), relation('ef-copy', 'e', 'f')]),
    group('target', ['g', 'h'], [relation('ab', 'g', 'h')]),
    group('untouched', ['i'], []),
  ];
}
reset();
const context = vm.createContext({ exports: {},
  loadCharacters: () => 'abcdefghi'.split('').map(id => ({ id })),
  loadCharacterWorldGroups: () => groups,
  saveCharacterWorldGroups: value => { groups = copy(value); saves++; },
});
vm.runInContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, context);
const { moveCharacterToWorld: single, moveCharactersToWorld: batch } = context.exports;
let checks = 0;
function equal(a, b) { assert.deepEqual(copy(a), copy(b)); checks++; }
const before = copy(groups);
batch(['a', 'b', 'e', 'f', 'b'], 'target');
equal(saves, 1);
equal(groups.map(g => g.memberIds), [['c', 'd'], [], ['g', 'h', 'a', 'b', 'e', 'f'], ['i']]);
equal(groups[0].relations, [relation('cd', 'c', 'd')]);
equal(groups[1].relations, []);
equal(groups[3], before[3]);
equal(groups[2].relations[0], before[2].relations[0]);
equal(groups[2].relations.map(r => [r.fromCharacterId, r.toCharacterId, r.label]), [['g', 'h', '朋友'], ['a', 'b', '朋友'], ['b', 'a', '同事'], ['e', 'f', '朋友']]);
equal(new Set(groups[2].relations.map(r => r.id)).size, 4);
equal(groups.map(g => [g.description, g.userIdentityIds, g.userNodes]), before.map(g => [g.description, g.userIdentityIds, g.userNodes]));
const after = copy(groups);
batch(['a', 'b'], 'target');
equal(groups, after);
equal(saves, 1);
// An existing target member can be selected alongside newcomers without duplication.
batch(['g', 'c', 'd'], 'target');
equal(groups[2].memberIds.filter(id => id === 'g').length, 1);
equal(groups[2].relations.some(r => r.id === 'cd'), true);
for (const [ids, destination] of [[['a', 'missing'], 'target'], [['a'], 'missing'], [[], 'target'], [[null], 'target']]) {
  const snapshot = copy(groups), count = saves;
  assert.throws(() => batch(ids, destination));
  equal(groups, snapshot);
  equal(saves, count);
}
reset();
single('a', 'target');
equal(groups[0].relations.map(r => r.id), ['cd', 'bu']);
equal(groups[2].relations, [relation('ab', 'g', 'h')]);
equal(saves, 1);
// Single calls remain separate operations; only a cohort preserves its internal links.
single('b', 'target');
equal(groups[2].relations, [relation('ab', 'g', 'h')]);
console.log(`PASS: ${checks} assertions; cohort links, cross-boundary cleanup, direction/labels, duplicate/ID collision, no-op, validation and single compatibility.`);
