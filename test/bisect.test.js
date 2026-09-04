'use strict';
const { makeSuite } = require('./tiny_test');
const { bisectFlaky } = require('../src/bisect');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// oracle: commits < culprit always pass (modulo background flake rate);
// commits >= culprit fail deterministically (a real regression, not itself flaky).
function makeOracle(culprit, backgroundFlakeRate) {
  return (commitIndex, rng) => {
    const trueGood = commitIndex < culprit;
    const flaked = rng() < backgroundFlakeRate;
    return flaked ? !trueGood : trueGood;
  };
}

function run() {
  const { results, test, assert, assertEqual } = makeSuite('bisect');

  test('bisection finds the exact culprit commit with zero background flakiness', () => {
    const rng = mulberry32(1);
    const oracle = makeOracle(613, 0.0);
    const r = bisectFlaky(0, 1000, oracle, { samplesPerCommit: 1, rng });
    assertEqual(r.culprit, 613);
  });

  test('bisection still finds the exact culprit at a realistic 15% background flake rate', () => {
    const rng = mulberry32(2);
    const trueCulprit = 340;
    const oracle = makeOracle(trueCulprit, 0.15);
    const r = bisectFlaky(0, 1000, oracle, { samplesPerCommit: 9, majorityThreshold: 0.5, rng });
    assertEqual(r.culprit, trueCulprit, `expected exact culprit ${trueCulprit} even under 15% flake noise, got ${r.culprit}`);
    global.__PITLANE_BISECT_FLAKY__ = { culprit: r.culprit, totalRuns: r.totalRuns, stepsChecked: r.stepsChecked, flakeRate: 0.15 };
  });

  // Required samples-per-commit to reliably tell a "good" commit (observed
  // pass rate ~= 1 - flakeRate) apart from the 0.5 majority threshold,
  // derived from a z=4 normal-approximation separation bound:
  //   n >= (z^2 * 0.25) / (0.5 - flakeRate)^2
  // This is the same kind of sample-size-vs-confidence tradeoff behind
  // the Wilson interval work in flakyDetect.js, applied to bisection.
  function requiredSamples(flakeRate, z = 4) {
    const dist = 0.5 - flakeRate;
    if (dist <= 0.02) return 2000;
    return Math.max(3, Math.min(2000, Math.ceil((z * z * 0.25) / (dist * dist))));
  }

  test('measures total oracle runs across a sweep of flake rates, all correct once sample size scales with noise (for README numbers)', () => {
    const rng = mulberry32(3);
    const range = 2000;
    const trueCulprit = 1234;
    const sweepResults = {};
    for (const flakeRate of [0.0, 0.05, 0.1, 0.2, 0.3, 0.4]) {
      const oracle = makeOracle(trueCulprit, flakeRate);
      const samplesPerCommit = flakeRate === 0 ? 1 : requiredSamples(flakeRate);
      const r = bisectFlaky(0, range, oracle, { samplesPerCommit, majorityThreshold: 0.5, rng });
      sweepResults[flakeRate] = { culprit: r.culprit, totalRuns: r.totalRuns, correct: r.culprit === trueCulprit, samplesPerCommit };
      assertEqual(r.culprit, trueCulprit, `flake rate ${flakeRate}: expected culprit ${trueCulprit}, got ${r.culprit}`);
    }
    global.__PITLANE_BISECT_SWEEP__ = sweepResults;
  });

  test('a FIXED small sample size (7) that works fine at low flake rates genuinely fails to always find the true culprit once flake rate is high (honest negative result)', () => {
    const trueCulprit = 1234;
    let anyMiss = false;
    for (let seed = 1; seed <= 20; seed++) {
      const rng = mulberry32(seed * 31 + 5);
      const oracle = makeOracle(trueCulprit, 0.35);
      const r = bisectFlaky(0, 2000, oracle, { samplesPerCommit: 7, majorityThreshold: 0.5, rng });
      if (r.culprit !== trueCulprit) anyMiss = true;
    }
    assert(anyMiss, 'expected at least one wrong-culprit result across 20 seeds at 35% flake with only 7 samples/commit - this is why sample size must scale with measured flakiness, not stay fixed');
  });

  return results;
}
module.exports = { run };
