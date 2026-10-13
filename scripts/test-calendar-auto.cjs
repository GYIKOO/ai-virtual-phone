const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
function load(file, dependencies, globals = {}, source = fs.readFileSync(file, 'utf8')) {
  const exports = {};
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  vm.runInNewContext(compiled.outputText, { exports, require: name => {
    if (!(name in dependencies)) throw new Error(`Unexpected import ${name}`);
    return dependencies[name];
  }, console, Event, AbortController, ...globals });
  return exports;
}
const utils = load('lib/calendar-utils.ts', {});
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
function fixture() {
  let now = Date.parse('2026-10-14T12:00:00Z');
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const store = new Map(), plans = new Map(), calls = [], timers = new Map(), navigator = {};
  let ids = ['a', 'b'], timerId = 0, active = 0, maxActive = 0;
  const window = new EventTarget(), document = new EventTarget(); document.hidden = false;
  const kv = { kvGet: key => store.get(key), kvSet: (key, value) => store.set(key, value), kvSetAsync: async (key, value) => store.set(key, value), kvRefresh: async () => {}, registerKvMigration() {} };
  const service = load('lib/calendar-auto-service.ts', {
    './kv-db': kv, './calendar-utils': utils,
    './calendar-storage': { refreshCalendarData: async () => {}, loadCalendarConfig: () => ({ autoGenerateCharacterIds: ids }), loadCalendarWeekPlan: (_, id, week) => plans.get(id + week) },
    './character-storage': { loadCharacters: () => ['a', 'b', 'c'].map(id => ({ id })) },
    './calendar-engine': { generateWeeklyCalendarSchedule: (_, id, week, options) => {
      active++; maxActive = Math.max(maxActive, active);
      return new Promise(resolve => calls.push({ id, week, options, finish: (success = true) => {
        active--;
        if (success && options.canSave()) plans.set(id + week, { items: [{ source: 'generated' }] });
        resolve({ success: success && options.canSave(), error: 'fixture failure' });
      } }));
    } },
  }, { window, document, Date: Clock, navigator, setInterval: () => ++timerId, clearInterval() {},
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) });
  return { service, calls, store, plans, timers, window, document, kv, navigator, setIds: value => { ids = value; },
    advance: ms => { now += ms; }, get now() { return now; }, get maxActive() { return maxActive; } };
}
async function scheduler() {
  const locked = fixture(); locked.setIds(['a']);
  locked.navigator.locks = { request: async (_, options, action) => {
    assert.equal(options.ifAvailable, true);
    await action(null);
  } };
  locked.service.startCalendarAutoService(); await flush();
  assert.equal(locked.calls.length, 0, 'another tab owns the generation lock');
  locked.navigator.locks.request = async (_, options, action) => action({});
  locked.kv.kvRefresh = async key => locked.store.set(key, JSON.stringify({ a: {
    week: utils.getWeekStartIso(new Date(locked.now)), done: true, attempts: 1, retryAt: 0,
  } }));
  locked.service.deferAutomaticForCalendar(); await flush();
  assert.equal(locked.calls.length, 0, 'refresh under lock sees another tab completed the week');
  locked.service.stopCalendarAutoService();

  const f = fixture(); f.service.startCalendarAutoService();
  assert.equal(f.service.deferAutomaticForCalendar(), true, 'priority reserved synchronously');
  await flush(); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].id, 'a');
  for (let i = 0; i < 5; i++) f.service.deferAutomaticForCalendar();
  assert.equal(f.calls.length, 1, 'polling never duplicates a request');
  f.calls[0].finish(); await flush(); assert.equal(f.calls[1].id, 'b');
  f.calls[1].finish(); await flush(); assert.equal(f.service.deferAutomaticForCalendar(), false);
  assert.equal(f.maxActive, 1);
  f.plans.clear(); assert.equal(f.service.deferAutomaticForCalendar(), false, 'completed week is not regenerated after deleting generated entries');
  f.service.stopCalendarAutoService();
  f.service.startCalendarAutoService(); await flush(); assert.equal(f.calls.length, 2, 'completion survives service restart');
  f.document.hidden = true; f.advance(21 * 86400000);
  assert.equal(f.service.deferAutomaticForCalendar(), false, 'no new automatic work while hidden');
  f.document.hidden = false; f.service.deferAutomaticForCalendar(); await flush();
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].week, utils.getWeekStartIso(new Date(f.now)), 'only current week, not missed weeks');
  f.setIds([]); assert.equal(f.calls[2].options.canSave(), false); f.calls[2].finish(); await flush();
  assert.equal(f.calls.length, 3, 'deselected queued character not called'); f.service.stopCalendarAutoService();

  const retry = fixture(); retry.setIds(['a']); retry.service.startCalendarAutoService(); await flush();
  for (let round = 0; round < 3; round++) {
    retry.calls[round].finish(false); await flush();
    assert.equal(retry.service.deferAutomaticForCalendar(), false, 'failure releases priority');
    retry.advance(16 * 60000); retry.service.deferAutomaticForCalendar(); await flush();
  }
  assert.equal(retry.calls.length, 3, 'bounded retries per week'); retry.service.stopCalendarAutoService();
  const timeout = fixture(); timeout.setIds(['a']); timeout.service.startCalendarAutoService(); await flush();
  [...timeout.timers.values()][0](); await flush();
  assert.ok(timeout.calls[0].options.signal.aborted);
  assert.equal(timeout.service.deferAutomaticForCalendar(), false, 'timeout unblocks automatic messages');
  assert.equal(timeout.calls[0].options.canSave(), false, 'late API result cannot save');
  timeout.calls[0].finish(); timeout.service.stopCalendarAutoService();

  const migration = fixture();
  const storage = load('lib/calendar-storage.ts', { './kv-db': migration.kv, './calendar-utils': utils, './character-time': { getSystemTimeZone: () => 'UTC' } }, { window: migration.window });
  migration.store.set('ai_phone_calendar_config_v1', JSON.stringify({ autoGenerateEnabled: true }));
  assert.equal(storage.loadCalendarConfig().autoGenerateCharacterIds.length, 0, 'legacy global switch never opts in every character');
  migration.store.set('ai_phone_calendar_config_v1', JSON.stringify({ autoGenerateCharacterIds: ['a', 'a', null, 7, ''] }));
  assert.deepEqual(Array.from(storage.loadCalendarConfig().autoGenerateCharacterIds), ['a']);
  const manual = { id: 'manual', source: 'manual', date: '2026-10-14', startTime: '15:00', endTime: '16:00', title: 'existing appointment', location: '' };
  storage.replaceCalendarWeekItems('character', 'a', '2026-10-12', [manual]);
  storage.cloneWeekPlanWithManualEdits('character', 'a', '2026-10-12', [{ ...manual, id: 'ai', source: 'generated', startTime: '17:00', endTime: '18:00' }]);
  assert.ok(storage.loadCalendarWeekPlan('character', 'a', '2026-10-12').items.some(item => item.id === 'manual'), 'existing manual events survive automatic plans');
}
async function generation() {
  const source = fs.readFileSync('lib/calendar-engine.ts', 'utf8');
  const ast = ts.createSourceFile('calendar-engine.ts', source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(n => n.name?.text === 'generateWeeklyCalendarSchedule');
  const fragment = 'const generatingWeeks = new Set();\n' + node.getText(ast);
  const at = new Date('2026-10-14T12:00:00').getTime();
  let saved, removed = 0, allowed = true, captured, pendingResolve;
  const items = [{ date: '2026-10-13', startTime: '18:00', source: 'generated' }, { date: '2026-10-14', startTime: '17:00', source: 'generated' }];
  const engine = load('fragment.ts', {}, {
    clearGeneratedWeekItems: () => { removed++; return []; }, restoreCalendarWeekItems() {},
    resolveCalendarAssemblerInput: async () => ({ llmMessages: [], ownerName: 'test' }),
    getWeekDates: utils.getWeekDates, buildCalendarTriggerInstruction: () => 'plan',
    sendLLMRequest: (...args) => { captured = args; return new Promise(resolve => { pendingResolve = resolve; }); },
    parseScheduleLines: () => items, loadCalendarWeekPlan: () => null,
    cloneWeekPlanWithManualEdits: (_, id, week, result) => { saved = result; },
  }, fragment);
  const options = { automatic: true, referenceTime: at, canSave: () => allowed };
  const p = engine.generateWeeklyCalendarSchedule('character', 'a', '2026-10-12', options); await flush();
  assert.equal((await engine.generateWeeklyCalendarSchedule('character', 'a', '2026-10-12')).success, false, 'manual/automatic share the same in-flight guard');
  assert.equal(removed, 0, 'automatic generation never clears existing data');
  assert.ok(captured[2].at(-1).content.includes('本次安排范围'));
  pendingResolve('valid'); assert.equal((await p).success, true);
  assert.equal(saved.length, 1); assert.equal(saved[0].date, '2026-10-14', 'new past plans excluded');
  saved = undefined; const cancelled = engine.generateWeeklyCalendarSchedule('character', 'a', '2026-10-12', options);
  await flush(); allowed = false; pendingResolve('valid'); assert.equal((await cancelled).success, false); assert.equal(saved, undefined);
}
(async () => {
  await scheduler(); await generation();
  for (const file of ['lib/follow-up-service.ts', 'lib/moments-engine.ts', 'lib/diary-entry-timer-service.ts']) {
    assert.ok(fs.readFileSync(file, 'utf8').includes('if (deferAutomaticForCalendar()) return;'), file);
  }
  const ui = fs.readFileSync('components/calendar-app.tsx', 'utf8');
  assert.ok(!ui.includes('autoAttemptedRef')); assert.ok(ui.includes('autoCharacterDraft'));
  console.log('PASS: explicit calendar opt-in, migration, priority/serial queue, current-week catch-up, retry limits/timeouts, cancellation, shared generation guard and future-only automatic plans.');
})().catch(error => { console.error(error); process.exitCode = 1; });
