// Offline integration checks; no API, WebView, device, or real user database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function compile(code) {
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
}
function extract(file, name, globals) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(fn, name);
  return vm.runInNewContext(`${compile(fn.getText(source))}\n${name}`, { exports: {}, ...globals });
}
async function testRouting() {
  let personal = true;
  const requests = [];
  const route = extract('lib/personal-push-cloud.ts', 'pushJobsFetch', {
    isPersonalPushCloudActive: () => personal,
    personalPushFetch: async (path, init) => requests.push(['personal', path, init]),
    fetch: async (path, init) => requests.push(['shared', path, init]),
  });
  await route({ method: 'DELETE' });
  personal = false; await route({ method: 'POST' });
  assert.equal(requests[0][0], 'personal'); assert.equal(requests[1][0], 'shared');
  assert.equal(requests[0][2].method, 'DELETE');
  assert.equal(requests[1][2].credentials, 'include');
  const outbox = fs.readFileSync('lib/push-outbox-client.ts', 'utf8');
  assert.ok(outbox.includes('isPersonalPushCloudActive() ? ["personal"] : ["shared"]'), 'outbox and jobs choose the same project');
  let native = true, shell = true;
  const enabled = extract('lib/push-bailout-client.ts', 'bailoutEnabled', {
    window: {}, isPersonalPushCloudActive: () => personal,
    isShellEnvironment: () => shell, getAndroidNative: () => native ? {} : null,
  });
  assert.equal(enabled(), false, 'managed APK without personal cloud must not route to shared site');
  native = false; assert.equal(enabled(), true, 'legacy shell retains site fallback');
  shell = false; assert.equal(enabled(), false);
  personal = true; assert.equal(enabled(), true);
}
function testCalls() {
  const exports = {}, events = [];
  vm.runInNewContext(compile(fs.readFileSync('lib/call-session-store.ts', 'utf8')), {
    exports, Date, Math, Set, window: { dispatchEvent: event => events.push(event) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  });
  exports.startCall({ sessionId: 'a', characterId: 'char', kind: 'voice', initiator: 'user' });
  const first = exports.getActiveCall();
  assert.equal(exports.getActiveCall(), first, 'stable React snapshot');
  exports.minimizeCall(); assert.equal(exports.isCallActiveForSession('a'), true);
  assert.equal(exports.isCallActiveForSession('b'), false);
  exports.restoreCall(); assert.equal(exports.getActiveCall().callId, first.callId);
  exports.endCall(); assert.equal(exports.getActiveCall(), null);
  assert.equal(events[0].detail.sessionId, 'a');
  const followup = fs.readFileSync('lib/follow-up-service.ts', 'utf8');
  assert.ok(/pollNewProactive\(now,[^\n]+isCallActiveForSession\(sessionId\)/.test(followup), 'new proactive scheduler honors call presence');
  const proactive = fs.readFileSync('lib/proactive-service.ts', 'utf8');
  assert.ok(proactive.includes('&& !isBusy(session.id)'), 'call started during generation invalidates pending output');
}
async function testServerWait() {
  let now, userAt, assistantCount, inCall, subscribed, bgCancelled, fresh;
  let afterDelay, onConsume;
  const context = {
    Date: { now: () => now },
    loadChatMessages: () => [{ role: 'user', createdAt: new Date(userAt).toISOString() }, ...Array.from({ length: assistantCount }, () => ({ role: 'assistant' }))],
    loadChatSessions: () => [{ id: 'a', proactiveDisabled: false }],
    loadProactive: () => fresh,
    isCallActiveForSession: () => inCall,
    isBackgroundGenerationCancelled: () => bgCancelled,
    hasAccountPushSubscription: async () => subscribed,
    bgDelay: async ms => { now += ms; afterDelay?.(); },
    require: () => ({ consumeServerOutbox: async () => { onConsume?.(); } }),
  };
  context.Date.parse = Date.parse;
  const wait = extract('lib/follow-up-service.ts', 'awaitServerGenerated', context);
  const reset = () => { now = 0; userAt = 1000; assistantCount = 0; inCall = false; subscribed = true; bgCancelled = false; fresh = null; afterDelay = null; onConsume = null; };
  reset(); onConsume = () => assistantCount++;
  assert.equal(await wait('a', 0, 10000, 1000), 'delivered');
  reset(); afterDelay = () => { userAt = 2000; };
  assert.equal(await wait('a', 0, 10000, 1000), 'cancelled', 'new user message is not a timeout/fallback');
  reset(); afterDelay = () => { inCall = true; };
  assert.equal(await wait('a', 0, 10000, 1000), 'cancelled');
  reset(); fresh = {};
  assert.equal(await wait('a', 0, 10000, 1000), 'cancelled', 'legacy scheduler cannot compete with new scheduler');
  reset(); subscribed = false;
  assert.equal(await wait('a', 0, 10000, 1000), 'timeout'); assert.equal(now, 0);
}
function testPrivacy() {
  const filter = extract('lib/perception/describe.ts', 'filterStatusBySwitches', { isCapabilityEnabled: (config, name) => config.capabilities[name] !== false });
  let config = { enabled: true, capabilities: { battery: false, foregroundApp: false, steps: false } };
  const build = extract('lib/perception/cloud-sync.ts', 'buildCloudPayload', {
    loadPerceptionConfig: () => config,
    loadPerceptionStatus: () => ({ at: '2026-10-11T00:00:00Z', batteryPercent: 99, charging: true, foregroundApp: 'private-app', steps: 789 }),
    filterStatusBySwitches: filter, describeStatus: () => 'remaining enabled signals',
  });
  const result = build();
  assert.equal(result.foregroundApp, ''); assert.equal(result.steps, -1); assert.equal(result.batteryPercent, -1); assert.equal(result.charging, false);
  config.enabled = false; assert.equal(build(), null);
}
async function testCheckInConcurrency() {
  let attempts = 0, release;
  const poll = extract('lib/screenshot/checkin-engine.ts', 'pollDueCheckIns', {
    pollingCheckIns: false,
    loadCheckInConfig: () => ({ a: {} }),
    shouldFireCheckIn: () => true,
    runCheckIn: async () => { attempts++; await new Promise(resolve => { release = resolve; }); return { ok: true }; },
  });
  const pending = poll();
  assert.equal(await poll(), 0, 'focus event cannot start another approval while one is pending');
  assert.equal(attempts, 1);
  release(); assert.equal(await pending, 1);
  const next = poll(); assert.equal(attempts, 2); release(); await next;
}
(async () => {
  await testRouting(); testCalls(); await testServerWait(); testPrivacy(); await testCheckInConcurrency();
  console.log('PASS: personal/shared routing, stable global calls, call/proactive exclusion, cloud-wait cancellation, perception field privacy and check-in concurrency');
})().catch(error => { console.error(error.message, error.stack); process.exitCode = 1; });
