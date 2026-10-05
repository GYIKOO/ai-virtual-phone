// Standalone experiment, not app scheduling code. Synthetic local days, no DST.
// Every opportunity succeeds instantly; no follow-ups, silence, failures or app downtime.
// Scheduled conversations denote their LAST saved message, not their start.
const assert = require('node:assert/strict');
const { random, sampleDelayHours, applyQuiet, quietEndAt } = require('./simulate-proactive-timing.cjs');
const { dueAfter } = require('./simulate-proactive-quiet-clock.cjs');
const DAY = 1440, HOUR = 60;
const QUIET = { start: 23 * HOUR, end: 8 * HOUR, spread: 45 };
const SETS = [[4, 8, 12, 18, 24], [4, 6, 9, 12, 16]];

function simulate(mean, hours, seed, draw = sampleDelayHours) {
  const rng = random(seed), spread = random(seed ^ 0x12345678);
  const start = 7 * DAY, end = 14 * DAY; // Seven warm-up days, then one measured week.
  const conversations = [];
  for (let day = 0; day < 14; day++) for (const hour of hours) conversations.push(day * DAY + hour * HOUR);
  let index = 0, anchor = 0, count = 0, cancelled = 0;
  const days = new Set();
  function schedule() {
    const raw = dueAfter(anchor, draw(mean, rng) * HOUR, .5, QUIET);
    return applyQuiet(raw, QUIET, spread);
  }
  let due = schedule();
  while (Math.min(due, conversations[index] ?? Infinity) < end) {
    const conversation = conversations[index] ?? Infinity;
    if (conversation <= due) {
      // A real saved message cancels the old task, including its quiet-release jitter.
      anchor = conversation;
      index++;
      cancelled++;
    } else {
      assert.equal(quietEndAt(due, QUIET), null);
      assert.ok(due > anchor);
      if (due >= start) { count++; days.add(Math.floor((due - start) / DAY)); }
      anchor = due; // Only a successfully saved message resets the clock.
    }
    due = schedule();
  }
  return { count, activeDays: days.size, cancelled };
}

function run() {
  // Daily saved messages always cancel a 40h effective budget, including deferred tasks.
  assert.equal(simulate(24, [9, 20], 1, () => 40).count, 0);
  assert.equal(simulate(24, [9, 20], 1, () => 40).cancelled, 28);
  for (const mean of new Set(SETS.flat())) {
    const rng = random(921);
    let sum = 0;
    for (let i = 0; i < 20000; i++) sum += sampleDelayHours(mean, rng);
    assert.ok(Math.abs(sum / 20000 - mean) < .15);
  }
  console.log('PASS: candidate means and saved-message cancellation.');
  console.log('10000 independent character-weeks per row; 7-day warm-up; quiet 23-08 at half speed.');
  console.log('Ideal successful opportunities, not predicted real message counts. No follow-ups or immediate user responses.');
  for (const hours of [[20], [9, 20]]) {
    for (const mean of [...new Set(SETS.flat())].sort((a, b) => a - b)) {
      const rows = Array.from({ length: 10000 }, (_, i) => simulate(mean, hours, 65000 + i));
      const counts = rows.map(r => r.count).sort((a, b) => a - b);
      console.log(JSON.stringify({ conversations: hours, meanHours: mean,
        weeklyMean: rows.reduce((s, r) => s + r.count, 0) / rows.length,
        daysPerWeek: rows.reduce((s, r) => s + r.activeDays, 0) / rows.length,
        zeroWeekPercent: rows.filter(r => !r.count).length / rows.length * 100,
        p10: counts[1000], p90: counts[9000] }));
    }
  }
}
if (require.main === module) run();
module.exports = { simulate };
