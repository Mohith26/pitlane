'use strict';
const { makeSuite } = require('./tiny_test');
const { qualifyRelease, quarantineDecision } = require('../src/qualify');

function run() {
  const { results, test, assert, assertEqual } = makeSuite('qualify');

  test('a requirement with few trials at 100% is correctly NO_GO despite a perfect observed rate', () => {
    const report = qualifyRelease([{ name: 'emergency_brake_latency', passes: 3, trials: 3 }], { requiredLowerBound: 0.95 });
    assertEqual(report.requirements[0].goNoGo, 'NO_GO', '3/3 is not enough samples to be 95%-confident above a 0.95 lower bound');
  });

  test('the same 100% rate with a large sample size is correctly GO', () => {
    const report = qualifyRelease([{ name: 'emergency_brake_latency', passes: 300, trials: 300 }], { requiredLowerBound: 0.95 });
    assertEqual(report.requirements[0].goNoGo, 'GO');
  });

  test('overall release gate is NO_GO if any single requirement fails, even if others pass', () => {
    const report = qualifyRelease([
      { name: 'req_a', passes: 500, trials: 500 },
      { name: 'req_b', passes: 40, trials: 50 }, // clearly below 0.95 lower bound
    ], { requiredLowerBound: 0.95 });
    assertEqual(report.overallGoNoGo, 'NO_GO');
  });

  test('a genuinely flaky test (alternating pass/fail) is flagged for quarantine', () => {
    const history = [true, false, true, false, true, false, true, false, true, false];
    const d = quarantineDecision('flaky_test_1', history);
    assert(d.quarantine, 'a test flipping every single run should be flagged flaky/quarantine');
  });

  test('a consistently-failing test is NOT quarantined (it is a real regression signal, not flakiness)', () => {
    const history = [false, false, false, false, false, false];
    const d = quarantineDecision('broken_test_1', history);
    assert(!d.quarantine, 'a test that always fails should not be hidden by quarantine logic');
    assert(d.allFail);
  });

  return results;
}
module.exports = { run };
