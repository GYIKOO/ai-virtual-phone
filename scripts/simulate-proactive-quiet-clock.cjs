// Independent mathematical experiment. No app storage or API access.
// Synthetic local civil minutes, without DST transitions (same convention as v1).
const assert = require('node:assert/strict');
const { random, sampleDelayHours, applyQuiet, quietEndAt, clock } = require('./simulate-proactive-timing.cjs');
const HOUR = 60, DAY = 1440;
const QUIET = { start: 23 * HOUR, end: 8 * HOUR, spread: 45 };
const RATES = [1, .5, 1 / 3];
const TIERS = [4, 8, 12, 18, 24];

function boundary(time, quiet) {
  const end = quietEndAt(time, quiet);
  if (end !== null) return { end, quiet: true };
  const day = Math.floor(time / DAY) * DAY;
  const start = day + quiet.start;
  return { end: start > time ? start : start + DAY, quiet: false };
}
function effectiveMinutes(start, end, rate, quiet = QUIET) {
  assert.ok(end >= start && rate > 0 && rate <= 1);
  let total = 0, time = start;
  while (time < end) {
    const segment = boundary(time, quiet);
    const until = Math.min(end, segment.end);
    total += (until - time) * (segment.quiet ? rate : 1);
    time = until;
  }
  return total;
}
function dueAfter(anchor, budgetMinutes, rate, quiet = QUIET) {
  assert.ok(budgetMinutes >= 0 && Number.isFinite(budgetMinutes) && rate > 0 && rate <= 1);
  let remaining = budgetMinutes, time = anchor;
  for (;;) {
    const segment = boundary(time, quiet);
    const speed = segment.quiet ? rate : 1;
    const capacity = (segment.end - time) * speed;
    if (remaining <= capacity) return time + remaining / speed;
    remaining -= capacity;
    time = segment.end;
  }
}
function stats(rows) {
  const sorted = rows.map(r => r.wait).sort((a, b) => a - b);
  const n = rows.length;
  return {
    mean: sorted.reduce((sum, x) => sum + x, 0) / n,
    p90: sorted[Math.floor(n * .9)], p99: sorted[Math.floor(n * .99)],
    over36: sorted.filter(x => x > 36).length / n * 100,
    over48: sorted.filter(x => x > 48).length / n * 100,
    morning: rows.filter(r => r.due % DAY >= 8 * HOUR && r.due % DAY < 9 * HOUR).length / n * 100,
    shifted: rows.filter(r => r.shifted).length / n * 100,
  };
}
function tests() {
  for (const rate of RATES) {
    const rng = random(430);
    for (let i = 0; i < 1000; i++) {
      const anchor = rng() * DAY * 3, budget = rng() * 36 * HOUR;
      const raw = dueAfter(anchor, budget, rate);
      assert.ok(Math.abs(effectiveMinutes(anchor, raw, rate) - budget) < 1e-7);
      const due = applyQuiet(raw, QUIET, rng);
      assert.ok(due >= raw && quietEndAt(due, QUIET) === null);
    }
  }
  assert.equal(dueAfter(12 * HOUR, 12 * HOUR, 1), DAY);
  assert.equal(dueAfter(12 * HOUR, 12 * HOUR, .5), DAY + HOUR);
  assert.equal(dueAfter(12 * HOUR, 12 * HOUR, 1 / 3), DAY + 2 * HOUR);
  // Saving new quiet hours settles past time under the old rule; it does not redraw.
  const anchor = 12 * HOUR, changedAt = DAY + 2 * HOUR, budget = 18 * HOUR;
  const accrued = effectiveMinutes(anchor, changedAt, .5);
  assert.equal(accrued, 12.5 * HOUR);
  const remaining = budget - accrued;
  const changedDue = dueAfter(changedAt, remaining, .5, { start: 23 * HOUR, end: 9 * HOUR, spread: 45 });
  assert.equal(changedDue, DAY + 11 * HOUR);
  console.log('PASS: clock inversion, quiet boundaries, persisted-budget calculation and settings-change settlement');
}
function run() {
  tests();
  const N = 100000;
  console.log('Each row: 100000 independent draws; matched anchors/budgets/release jitter across rates.');
  console.log('Staggered anchors are uniformly distributed 08:00–23:00; illustrative, not measured user behavior.');
  for (const scenario of ['noon', 'staggered']) {
    for (const tier of TIERS) {
      const sampleRng = random(99100 + tier), anchorRng = random(87100 + tier), spreadRng = random(82100 + tier);
      const result = RATES.map(() => []);
      for (let i = 0; i < N; i++) {
        const anchor = scenario === 'noon' ? 12 * HOUR : (8 + 15 * anchorRng()) * HOUR;
        const budget = sampleDelayHours(tier, sampleRng) * HOUR;
        const spread = spreadRng();
        RATES.forEach((rate, index) => {
          const raw = dueAfter(anchor, budget, rate);
          const due = applyQuiet(raw, QUIET, () => spread);
          result[index].push({ wait: (due - anchor) / HOUR, due, shifted: due !== raw });
        });
      }
      RATES.forEach((rate, index) => console.log(JSON.stringify({ scenario, tier, rate, ...stats(result[index]) })));
    }
  }
  console.log('Matched illustrative characters, one draw each:');
  [9.25, 12, 15.5, 18.25, 21.75].forEach((hour, i) => {
    const anchor = hour * HOUR;
    const budget = sampleDelayHours(TIERS[i], random(3200 + i)) * HOUR;
    console.log(JSON.stringify({ tier: TIERS[i], lastMessage: clock(anchor), budgetHours: budget / HOUR,
      schedules: RATES.map(rate => {
        const raw = dueAfter(anchor, budget, rate);
        const due = applyQuiet(raw, QUIET, random(4200 + i));
        return { rate, raw: clock(raw), due: clock(due) };
      }) }));
  });
}
module.exports = { effectiveMinutes, dueAfter };
if (require.main === module) run();
