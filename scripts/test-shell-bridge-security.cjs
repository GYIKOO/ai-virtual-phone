const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const base = 'android-shell/app/src/main/';
const kt = base + 'java/app/floatphone/shell/';
const script = fs.readFileSync(base + 'assets/secure-shell.js', 'utf8');

function page({ child = false, transport = true } = {}) {
  const sent = [], calls = [], events = [];
  let valid = true;
  const win = { dispatchEvent: event => events.push(event.type) };
  win.top = child ? {} : win;
  if (transport) {
    win.FloatShellHandshake = { postMessage: value => sent.push(value) };
    win.FloatShellRpc = { invoke: (token, namespace, method, args) => {
      calls.push({ token, namespace, method, args: JSON.parse(args) });
      return JSON.stringify(valid ? { ok: true, value: method === 'getVersion' ? '1.0.12' : true } : { ok: false, error: 'expired' });
    } };
  }
  const context = vm.createContext({ window: win, Event: class { constructor(type) { this.type = type; } } });
  const run = () => vm.runInContext(script, context);
  run();
  const ready = () => win.FloatShellHandshake.onmessage({ data: JSON.stringify({ token: 'secret-test-capability',
    methods: { AndroidShell: ['getVersion', 'setVolume'], PhoneWidget: ['isSupported'] } }) });
  return { win, sent, calls, events, run, ready, expire: () => { valid = false; } };
}

const child = page({ child: true });
assert.equal(child.sent.length, 0, 'even a same-origin subframe does not bootstrap public wrappers');
assert.equal(child.win.AndroidShell, undefined);
assert.equal(page({ transport: false }).win.AndroidShell, undefined, 'unsupported WebView fails closed');
const main = page();
assert.equal(main.win.AndroidShell, undefined, 'no API before authorized handshake');
main.ready();
assert.equal(main.win.AndroidShell.getVersion(), '1.0.12', 'upstream synchronous API preserved');
assert.equal(main.win.PhoneWidget.isSupported(), true);
main.win.AndroidShell.setVolume('media', 'set', 25);
assert.deepEqual(main.calls.at(-1).args, ['media', 'set', 25]);
assert.equal(main.win.AndroidShell.invoke, undefined, 'no wildcard operation exposed on public facade');
assert.equal(main.win.token, undefined);
assert.equal(JSON.stringify(main.win.AndroidShell), '{}', 'capability is not on facade');
assert.ok(Object.isFrozen(main.win.AndroidShell));
main.win.FloatShellSecurity.configure({ screenshot: false });
assert.equal(main.calls.at(-1).namespace, 'Policy');
main.run(); assert.equal(main.sent.length, 1, 'page-finished fallback is idempotent');
main.expire(); assert.throws(() => main.win.AndroidShell.getVersion(), /expired/);
assert.deepEqual(main.events, ['float-shell-ready']);

// Execute the actual settings adapter with mock stores (never the user's database).
let hydrated = false;
const stores = {
  './kv-db': { isKvHydrated: () => hydrated },
  './device-action/storage': { TOGGLEABLE_ACTIONS: ['volume', 'torch'], loadDeviceActionConfig: () => ({ enabled: true, actions: { volume: true } }) },
  './perception/storage': { loadPerceptionConfig: () => ({ enabled: true, capabilities: { location: false } }) },
  './screenshot/config': { loadScreenshotConfig: () => ({ enabled: false, ballEnabled: true }) },
  './screenshot/checkin-config': { loadCheckInConfig: () => ({ a: { enabled: true }, b: { enabled: false } }) },
  './system-calendar/config': { loadSystemCalendarConfig: () => ({ readEnabled: true, writeEnabled: false }) },
  './widget/storage': { loadWidgetConfig: () => ({ enabled: false }) },
};
const exportsObj = {}, listeners = new Map();
main.win.addEventListener = (name, listener) => listeners.set(name, listener);
main.win.removeEventListener = name => listeners.delete(name);
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/shell-bridge-security.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, { exports: exportsObj, require: name => stores[name], window: main.win, console: { warn() {} } });
assert.equal(Object.keys(exportsObj.buildNativeBridgePolicy()).length, 0, 'unhydrated settings grant nothing');
hydrated = true;
const policy = exportsObj.buildNativeBridgePolicy();
assert.equal(policy.actions.volume, true); assert.equal(policy.actions.torch, false);
assert.equal(policy.perception.battery, true); assert.equal(policy.perception.location, false);
assert.equal(policy.screenshotBall, false); assert.equal(policy.checkIns.a, true); assert.equal(policy.checkIns.b, false);
assert.equal(policy.calendarRead, true); assert.equal(policy.calendarWrite, false);
const cleanup = exportsObj.installNativeBridgePolicySync();
assert.ok(listeners.has('phone-widget-updated')); assert.ok(listeners.has('check-in-config-changed'));
cleanup(); assert.equal(listeners.size, 0);

// Source contract checks supplement, but do not replace, native compilation / device tests.
const activity = fs.readFileSync(kt + 'MainActivity.kt', 'utf8');
assert.ok(!/^\s*@JavascriptInterface\s*$/m.test(activity), 'raw feature objects must never be exposed');
assert.ok(!activity.includes('addJavascriptInterface('));
assert.equal((activity.match(/@ShellMethod/g) || []).length, 87, 'every upstream method retains explicit registration');
const bridge = fs.readFileSync(kt + 'SecureShellBridge.kt', 'utf8');
assert.ok(bridge.includes('if (!mainFrame || !isTrustedOrigin(source.toString())'));
assert.ok(bridge.includes('check(token != null && secret == token)'));
assert.ok(bridge.includes('isAnnotationPresent(ShellMethod::class.java)'));
assert.ok(bridge.indexOf('NativeBridgePolicy.requireAllowed') < bridge.indexOf('method.invoke('));
assert.ok(bridge.includes('fun reset() { token = null; NativeBridgePolicy.reset() }'));
const bus = fs.readFileSync(kt + 'ShellBus.kt', 'utf8');
assert.ok(bus.includes('!SecureShellBridge.isTrustedOrigin(target.url)'));
assert.ok(bus.includes('NativeBridgePolicy.document != document'));
assert.ok(bus.includes('requiredRevision != NativeBridgePolicy.revision'));
const checkIn = fs.readFileSync(kt + 'CheckInService.kt', 'utf8');
assert.match(checkIn, /private fun acceptCheckIn\(\) \{\s*if \(!pendingAccessAllowed\(\)\)/);
assert.ok(checkIn.includes('pendingUserShotRevision == NativeBridgePolicy.revision'));
console.log('PASS: trusted handshake facade, iframe exclusion, fail-closed startup, sync return compatibility, token expiry, settings hydration/toggles and native authorization/lifecycle contracts.');
