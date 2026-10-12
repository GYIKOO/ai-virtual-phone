// Offline checks: actual macro expansion and single/group prompt assembly, no API calls.
const assert = require('node:assert/strict');
const { load, assembler, time, character } = require('./test-proactive-request-history.cjs');
const { MacroEngine } = load('lib/macro-engine.ts', { './character-time': time });
const engine = new MacroEngine('角色', '用户');
const at = Date.parse('2024-03-10T09:30:15Z');
engine.referenceTime = at;
assert.equal(engine.expand('{{timestamp}}'), new Date(at).toISOString());
const local = new Date(at), pad = n => String(n).padStart(2, '0');
const expected = `${local.getFullYear()}-${pad(local.getMonth()+1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;
assert.equal(engine.expand('{{timestamp:YYYY-MM-DD HH:mm:ss}}'), expected, 'formatted macro keeps its existing device-local timezone');
assert.equal(engine.expand('{{timeContext}}'), time.buildCharacterTimeContext(undefined, new Date(at)).timeContext);
engine.referenceTime = 0;
assert.equal(engine.expand('{{timestamp}}'), '1970-01-01T00:00:00.000Z');
for (const value of [undefined, NaN, Infinity, 1e20]) {
  engine.referenceTime = value;
  const before = Date.now();
  const result = Date.parse(engine.expand('{{timestamp}}'));
  assert.ok(result >= before && result <= Date.now(), 'absent/invalid reference uses wall clock');
}
const preset = { prompts: [
  { identifier: 'time-test', enabled: true, role: 'system', content: 'CLOCK={{timestamp}}\nFORMATTED={{timestamp:YYYY-MM-DD HH:mm:ss}}\n{{timeContext}}', injection_position: 0 },
  { identifier: 'shortTermMemory', marker: true, enabled: true, role: 'system' },
] };
const history = [{ id: 'u', role: 'user', content: 'MIDNIGHT_INPUT', createdAt: '2024-03-10T00:00:00Z' }];
for (const group of [false, true]) for (const reference of [Date.parse('2024-03-10T09:00:00Z'), Date.parse('2024-03-10T08:30:00Z')]) {
  const context = group ? time.buildGroupTimeContext([{ name: character.name, timeZone: 'Asia/Shanghai' }], new Date(reference))
    : time.buildCharacterTimeContext('Asia/Shanghai', new Date(reference));
  const common = { history, preset, regexes: [], timeAware: true, timeContext: context };
  const payload = group
    ? assembler.assembleGroupPromptPayload({ ...common, groupName: '测试群', userName: '测试用户', members: [{ character, worldBooks: [] }], memberTimeContexts: { [character.id]: context } })
    : assembler.assemblePromptPayload({ ...common, character, worldBooks: [] });
  const text = payload.map(m => m.content).join('\n');
  assert.ok(text.includes(`CLOCK=${new Date(reference).toISOString()}`), text);
  assert.ok(text.includes(context.timeContext), text);
  assert.ok(text.includes(reference === Date.parse('2024-03-10T09:00:00Z') ? '0天9小时0分钟' : '0天8小时30分钟'));
  assert.ok(text.includes('MIDNIGHT_INPUT'));
}
console.log('PASS: timestamp/timeContext macros share the single/group generation reference; midnight history remains distinct from morning generation or replay.');
