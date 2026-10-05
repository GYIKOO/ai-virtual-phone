/** Standalone mathematical prototype. Not imported by Float.
 * Times are civil minutes on a synthetic local calendar, not UTC timestamps.
 * Production must convert local quiet-hour boundaries with an IANA timezone.
 */
const assert = require('node:assert/strict');
const HOUR = 60;
const DAY = 24 * HOUR;
const TIERS = [4, 8, 12, 18, 24];
const QUIET = { start: 23 * HOUR, end: 8 * HOUR, spread: 45 };

function random(seed) {
  return () => {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function normal(rng) {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}
// Marsaglia-Tsang gamma sampler; all shapes used here exceed one.
function gamma(shape, rng) {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(rng);
    const root = 1 + c * x;
    if (root <= 0) continue;
    const v = root ** 3;
    const u = 1 - rng();
    if (Math.log(u) < x * x / 2 + d * (1 - v + Math.log(v))) return d * v;
  }
}
function parameters(meanHours, adjustment = 0) {
  if (![4, 6, 8, 9, 12, 16, 18, 24].includes(meanHours) || ![-40, -20, 0, 20, 40].includes(adjustment)) throw new Error('Invalid tier or adjustment');
  // Candidate UI mapping: +/-40 moves the target mean by a reciprocal factor
  // of 1.2, not +/-40% frequency (which would turn 24h into 40h).
  const mean = meanHours / (1.2 ** (adjustment / 40));
  const lower = .5;
  const upper = mean * 1.5;
  const alpha = 4;
  const beta = alpha * (upper - mean) / (mean - lower);
  return { mean, lower, upper, alpha, beta };
}
function sampleDelayHours(meanHours, rng, adjustment = 0) {
  const p = parameters(meanHours, adjustment);
  const a = gamma(p.alpha, rng), b = gamma(p.beta, rng);
  return p.lower + (p.upper - p.lower) * a / (a + b);
}
function validateQuiet(quiet) {
  if (!quiet) return;
  if (![quiet.start, quiet.end].every(n => Number.isInteger(n) && n >= 0 && n < DAY)
    || quiet.start === quiet.end || !Number.isFinite(quiet.spread) || quiet.spread < 0) {
    throw new Error('Quiet hours require distinct minute-of-day boundaries and a nonnegative spread');
  }
}
function quietEndAt(time, quiet) {
  if (!quiet) return null;
  const minute = ((time % DAY) + DAY) % DAY;
  const day = Math.floor(time / DAY) * DAY;
  const { start, end } = quiet;
  if (start < end) return minute >= start && minute < end ? day + end : null;
  if (minute >= start) return day + DAY + end;
  return minute < end ? day + end : null;
}
function applyQuiet(rawDue, quiet, rng) {
  validateQuiet(quiet);
  const end = quietEndAt(rawDue, quiet);
  if (end === null) return rawDue;
  const awakeLength = (quiet.start - quiet.end + DAY) % DAY;
  // Even a nearly-all-day quiet window must not spill the jitter into quiet time.
  const spread = Math.min(quiet.spread, awakeLength / 2);
  return end + rng() * spread;
}
function makeOpportunity(anchor, meanHours, sampleRng, quietRng, quiet = null, adjustment = 0) {
  const rawDue = anchor + sampleDelayHours(meanHours, sampleRng, adjustment) * HOUR;
  return { anchor, rawDue, due: applyQuiet(rawDue, quiet, quietRng) };
}
function clock(time) {
  const minute = Math.floor(time);
  const day = Math.floor(minute / DAY);
  const within = ((minute % DAY) + DAY) % DAY;
  return `D${day ? `+${day}` : '0'} ${String(Math.floor(within / HOUR)).padStart(2, '0')}:${String(within % HOUR).padStart(2, '0')}`;
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { mean: values.reduce((a, b) => a + b, 0) / values.length, p10: q(.1), p50: q(.5), p90: q(.9), p99: q(.99), max: sorted.at(-1),
    over24: values.filter(x => x > 24).length / values.length * 100,
    over36: values.filter(x => x > 36).length / values.length * 100 };
}
function tests() {
  for (const tier of TIERS) {
    for (const adjustment of [-40, -20, 0, 20, 40]) {
      const p = parameters(tier, adjustment), rng = random(921);
      let total = 0;
      for (let i = 0; i < 20000; i++) {
        const delay = sampleDelayHours(tier, rng, adjustment);
        assert.ok(delay > .5 && delay < p.upper);
        total += delay;
      }
      assert.ok(Math.abs(total / 20000 - p.mean) < .15, 'sample mean tracks target');
    }
  }
  assert.equal(quietEndAt(23 * HOUR, QUIET), DAY + 8 * HOUR);
  assert.equal(quietEndAt(8 * HOUR, QUIET), null);
  assert.equal(quietEndAt(7 * HOUR, QUIET), 8 * HOUR);
  assert.equal(quietEndAt(14 * HOUR, { start: 13 * HOUR, end: 15 * HOUR }), 15 * HOUR);
  assert.throws(() => applyQuiet(100, { start: 0, end: 0, spread: 45 }, random(1)));
  const rng = random(82);
  for (const quiet of [QUIET, { start: 13 * HOUR, end: 15 * HOUR, spread: 45 }, { start: 1, end: 0, spread: 45 }]) {
    for (let i = 0; i < 10000; i++) {
      const original = rng() * 5 * DAY, result = applyQuiet(original, quiet, rng);
      assert.ok(result >= original);
      assert.equal(quietEndAt(result, quiet), null);
    }
  }
  console.log('PASS: distribution bounds/means, 30-minute protection, quiet boundaries and narrow awake windows');
}
function simulate() {
  tests();
  const anchor = 12 * HOUR;
  console.log('\nIndependent trials: each restarts at D0 12:00; quiet hours 23:00–08:00, release spread 0–45 min.');
  for (const tier of TIERS) {
    const rng = random(20261005 + tier), quietRng = random(81005 + tier);
    const trials = Array.from({ length: 10 }, (_, i) => {
      const event = makeOpportunity(anchor, tier, rng, quietRng, QUIET);
      return { round: i + 1, raw: clock(event.rawDue), quiet: clock(event.due) };
    });
    console.log(JSON.stringify({ character: `char-${tier}h`, targetMeanHours: tier, trials }));
  }
  console.log('\n100000 independent trials per tier; hours since last real message:');
  for (const tier of TIERS) {
    const rng = random(9100 + tier), quietRng = random(9200 + tier);
    const raw = [], effective = []; let moved = 0;
    for (let i = 0; i < 100000; i++) {
      const event = makeOpportunity(anchor, tier, rng, quietRng, QUIET);
      raw.push((event.rawDue - anchor) / HOUR);
      effective.push((event.due - anchor) / HOUR);
      if (event.rawDue !== event.due) moved++;
    }
    console.log(JSON.stringify({ tier, raw: stats(raw), quiet: stats(effective), quietDelayedPercent: moved / 1000 }));
  }
  // Conditional hazard for the 24-hour character: probability of becoming due
  // in the next half hour, among trials that have survived to each boundary.
  const rng = random(2400);
  const draws = Array.from({ length: 500000 }, () => sampleDelayHours(24, rng));
  console.log('\n24h tier conditional probability in the next 30 minutes:');
  for (const hour of [.5, 4, 8, 12, 18, 24, 30, 34]) {
    const remaining = draws.filter(value => value >= hour);
    console.log(JSON.stringify({ hour, probabilityPercent: remaining.filter(value => value < hour + .5).length / remaining.length * 100 }));
  }
  console.log('\n24h tier adjustment targets (pre-quiet hours):');
  for (const adjustment of [-40, -20, 0, 20, 40]) console.log(JSON.stringify({ adjustment, ...parameters(24, adjustment) }));
}
module.exports = { parameters, sampleDelayHours, applyQuiet, quietEndAt, makeOpportunity, random, clock };
if (require.main === module) simulate();
