const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const cache = new Map();
const code = ts.transpileModule(fs.readFileSync('lib/proactive-presence.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function tab(storage = { getItem: k => cache.get(k), setItem: (k, v) => cache.set(k, v) }) {
  const exports = {};
  vm.runInNewContext(code, { exports, localStorage: storage });
  return exports;
}
let a = tab();
a.updateProactivePresence(true, 100000, true);
assert.equal(a.getProactiveAbsence(), undefined, 'first install has no invented history');
a.updateProactivePresence(true, 1100000, true);
assert.equal(a.getProactiveAbsence(), undefined, 'foreground timer stall is not an absence');
cache.clear(); a = tab();
a.updateProactivePresence(true, 100000, true);
a.updateProactivePresence(false, 120000, true);
a.updateProactivePresence(true, 240000, true);
assert.equal(a.getProactiveAbsence().leftAt, 120000);
assert.equal(a.getProactiveAbsence().returnedAt, 240000);
a.updateProactivePresence(true, 260000);
assert.equal(a.getProactiveAbsence().returnedAt, 240000, 'queued missed tasks retain the resume boundary');
a.updateProactivePresence(false, 280000, true);
a.updateProactivePresence(true, 400000, true);
assert.equal(a.getProactiveAbsence().leftAt, 280000, 'new absence replaces old one');
// A process killed without any pagehide: use persisted heartbeat conservatively.
const b = tab();
b.updateProactivePresence(true, 600000, true);
assert.equal(b.getProactiveAbsence().leftAt, 430000);
assert.equal(b.getProactiveAbsence().returnedAt, 600000);
// Another visible tab prevents a hidden tab from declaring the app absent.
cache.clear(); a = tab(); const c = tab();
a.updateProactivePresence(true, 700000, true);
c.updateProactivePresence(true, 705000, true);
a.updateProactivePresence(false, 710000, true);
c.updateProactivePresence(true, 720000);
a.updateProactivePresence(true, 725000, true);
assert.equal(a.getProactiveAbsence(), undefined);
// Clock rollback / unavailable storage never creates historical context.
cache.clear(); a = tab();
a.updateProactivePresence(true, 800000, true);
a.updateProactivePresence(false, 810000, true);
a.updateProactivePresence(true, 790000, true);
assert.equal(a.getProactiveAbsence(), undefined);
const blocked = tab({ getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } });
blocked.updateProactivePresence(true, 900000, true);
assert.equal(blocked.getProactiveAbsence(), undefined);
console.log('PASS: absence boundaries, restart, OS kill, multiple tabs, clock rollback and unavailable storage.');
