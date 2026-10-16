// Offline native JSON contract checks; never calls a device or a model API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');
const compile = (source, fileName) => ts.transpileModule(source, {
  fileName,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, removeComments: true,
  },
}).outputText;
const window = {};
function load(file) {
  const exports = {};
  vm.runInNewContext(compile(fs.readFileSync(file, 'utf8'), file), {
    exports, window,
    require: name => {
      assert.equal(name, '../kv-db');
      return { registerKvMigration() {}, kvGet() { return null; } };
    },
  }, { filename: file });
  return exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const device = load('lib/device-action/bridge.ts');
const calendar = load('lib/system-calendar/bridge.ts');
const perception = load('lib/perception/bridge.ts');
const ball = load('lib/screenshot/ball.ts');
const storage = load('lib/device-action/storage.ts');
const insert = () => calendar.insertSystemCalendarEvent({ title: 'test', allDay: true });

assert.equal(device.setTorch(true).ok, false);
assert.equal(insert().ok, false);
assert.equal(perception.readSleep(), null);
assert.equal(ball.readBallHasImage(), false);

let raw;
window.AndroidShell = {
  setTorch: () => raw, insertCalendarEvent: () => raw,
  readSleep: () => raw, getScreenshotBallStyle: () => raw,
};
for (const invoke of [() => device.setTorch(true), insert]) {
  const success = { ok: true, eventId: 42, on: true, confirmed: false, extra: 'preserve' };
  raw = JSON.stringify(success);
  assert.deepEqual(plain(invoke()), success);
  raw = JSON.stringify({ ok: false, reason: 'permission denied', needPermission: 'calendar' });
  assert.deepEqual(plain(invoke()), { ok: false, reason: 'permission denied', needPermission: 'calendar' });
  for (raw of ['', 'not json', 'null', '[]', '7', '{}', '{"ok":false,"reason":9,"needPermission":true}']) {
    const result = invoke();
    assert.equal(result.ok, false);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
    assert.equal(result.needPermission, undefined);
  }
}
raw = JSON.stringify({ sleepMinutes: 420, sleepStartAt: 1000, sleepEndAt: 25201000 });
assert.deepEqual(plain(perception.readSleep()), { minutes: 420, startAt: 1000, endAt: 25201000 });
raw = JSON.stringify({ sleepMinutes: '420', sleepEndAt: '25201000' });
assert.deepEqual(plain(perception.readSleep()), { minutes: 420, startAt: 0, endAt: 25201000 });
for (raw of ['', 'null', '{', '{}', '{"sleepMinutes":0,"sleepEndAt":1}', '{"sleepMinutes":5,"sleepEndAt":0}']) {
  assert.equal(perception.readSleep(), null);
}
raw = '{"hasImage":true}'; assert.equal(ball.readBallHasImage(), true);
raw = '{"hasImage":false}'; assert.equal(ball.readBallHasImage(), false);
raw = '{}'; assert.equal(ball.readBallHasImage(), false);
raw = '{'; assert.equal(ball.readBallHasImage(), null);
window.AndroidShell = new Proxy({}, { get: () => () => { throw Error('bridge unavailable'); } });
assert.equal(device.setTorch(true).ok, false);
assert.equal(insert().ok, false);
assert.equal(perception.readSleep(), null);
assert.equal(ball.readBallHasImage(), null);

for (const id of ['brightnessAuto', 'mediaSessionGranted']) {
  assert.ok(storage.DEVICE_ACTION_LABEL[id]);
  assert.ok(storage.DEVICE_ACTION_DESC[id]);
  assert.equal(storage.TOGGLEABLE_ACTIONS.includes(id), false);
  assert.equal(storage.isActionEnabled(storage.loadDeviceActionConfig(), id), false);
}
assert.equal(storage.loadDeviceActionConfig().enabled, false);

// Optional audit against a known pre-fix revision: emitted JS must be identical
// for every type-only change, and storage may only gain the two display entries.
if (process.env.FLOAT_BRIDGE_BASE_REF) {
  const files = [
    'components/chat/call-auto-chat-control.tsx', 'lib/device-action/bridge.ts',
    'lib/system-calendar/bridge.ts', 'lib/perception/bridge.ts', 'lib/perception/engine.ts',
    'lib/screenshot/ball.ts', 'lib/screenshot/checkin-engine.ts', 'lib/screenshot/types.ts', 'lib/shell-call-overlay.ts',
    'lib/device-action/storage.ts',
  ];
  for (const file of files) {
    const before = cp.execFileSync('git', ['show', `${process.env.FLOAT_BRIDGE_BASE_REF}:${file}`], { encoding: 'utf8' });
    let after = fs.readFileSync(file, 'utf8');
    if (file.endsWith('/storage.ts')) after = after.replace(/^  (?:brightnessAuto|mediaSessionGranted):.*\r?\n/gm, '');
    assert.equal(compile(after, file), compile(before, file), `runtime unchanged: ${file}`);
  }
  console.log('PASS: emitted JavaScript unchanged apart from two capability labels/descriptions');
}
console.log('PASS: native success/failure/permission, sleep, screenshot and default-permission contracts');
