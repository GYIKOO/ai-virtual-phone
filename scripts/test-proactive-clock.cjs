const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, { exports, require: name => { if (!dependencies[name]) throw new Error(name); return dependencies[name]; }, Date, Math });
  return exports;
}
const p = load('lib/proactive-policy.ts');
const c = load('lib/proactive-clock.ts', { './proactive-policy': p });
const { random } = require('./simulate-proactive-timing.cjs');
const H = 3600000, quiet = '23:00-08:00';
assert.equal(p.intervalMs({ ...p.defaultProactiveConfig(), initiativeTier: 0, adjustment: -40 }, 'personality'), 20 * H);
assert.equal(p.intervalMs({ ...p.defaultProactiveConfig(), initiativeTier: 4, adjustment: 40 }, 'personality'), (4 / 1.4) * H);
for (let tier = 0; tier < 5; tier++) for (const adjustment of [-40, -20, 0, 20, 40]) {
  const cfg = { ...p.defaultProactiveConfig(), initiativeTier: tier, adjustment };
  const target = p.intervalMs(cfg, 'personality');
  assert.ok(target >= 2 * H && target <= 20 * H);
  const rng = random(720 + tier);
  const samples = Array.from({ length: 10000 }, () => p.samplePersonalityMs(cfg, rng));
  assert.ok(samples.every(x => x > .5 * H && x < 1.5 * target), 'no probability mass clamped to 30min');
  assert.ok(Math.abs(samples.reduce((s, x) => s + x, 0) / samples.length - target) < .2 * H);
}
const at = (day, hour) => new Date(2026, 9, day, hour).getTime();
assert.equal(c.effectiveElapsed(at(5, 12), at(6, 8), quiet), 15.5 * H);
assert.equal(c.effectiveDue(at(5, 12), 18 * H, quiet), at(6, 10) + .5 * H);
for (let tier = 0; tier < 5; tier++) {
  const cfg = { ...p.defaultProactiveConfig(), enabled: true, personalityEnabled: true, initiativeTier: tier };
  const rng = random(192), draws = Array.from({ length: 20000 }, () => p.samplePersonalityMs(cfg, rng));
  const mean = draws.reduce((s, x) => s + x, 0) / draws.length / H;
  assert.ok(Math.abs(mean - p.INITIATIVE_HOURS[tier]) < .15);
  assert.ok(draws.every(x => x > .5 * H && x < p.INITIATIVE_HOURS[tier] * 1.5 * H));
}
const base = { revision: 1, followupCount: 0, personalityAt: at(6, 1) };
let deferred = c.releaseQuiet(base, at(5, 20), quiet, () => .5);
assert.equal(deferred.personalityAt, at(6, 8) + 22.5 * 60000);
const same = c.releaseQuiet(deferred, at(6, 8), quiet, () => .9);
assert.equal(same.personalityAt, deferred.personalityAt, 'refresh does not redraw pending release');
const late = c.releaseQuiet(deferred, at(6, 10), quiet, () => .5);
assert.equal(late.personalityAt, at(6, 10) + 22.5 * 60000, 'quiet task never backfills on late reopen');
assert.equal(c.releaseQuiet(late, at(6, 11), quiet, () => .9).personalityAt, late.personalityAt, 'late-release draw is persisted');
const cfg = { ...p.defaultProactiveConfig(), enabled: true, personalityEnabled: true };
const reset = c.anchorPlan(cfg, 1, false, 'new-message', at(6, 9), '23:00-10:00', at(6, 9), random(7));
assert.equal(reset.anchorAt, at(6, 9));
assert.notEqual(reset.personalityAt, deferred.personalityAt);
assert.equal(reset.deferred.personality, undefined, 'old deferred task does not survive new message');
const changed = c.changeQuiet({ ...base, quietSetting: quiet, settledAt: at(5, 12), remainingMs: 18 * H }, '23:00-09:00', at(6, 2));
assert.equal(changed.remainingMs, 5.5 * H);
assert.equal(changed.personalityAt, at(6, 11));
assert.equal(c.quietBounds('25:00-08:00'), null);
assert.equal(c.quietBounds('08:00-08:00'), null);
console.log('PASS: production sampling, half-speed clock, quiet-release persistence, new-message invalidation, settings settlement.');
