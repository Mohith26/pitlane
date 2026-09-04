'use strict';
const { makeSuite } = require('./tiny_test');
const { wilsonInterval, classifyFlakyVsRegression } = require('../src/flakyDetect');

function run() {
  const { results, test, assert, assertEqual } = makeSuite('flakyDetect');

  test('Wilson interval for 100/100 passes is a tight interval near 1.0, not a false [1,1]', () => {
    const ci = wilsonInterval(100, 100);
    assert(ci.upper <= 1 && ci.lower < 1 && ci.lower > 0.95, `expected lower bound in (0.95,1), got ${ci.lower}`);
  });

  test('Wilson interval correctly widens for small trial counts vs large ones at the same observed rate', () => {
    const small = wilsonInterval(9, 10); // 90% on 10 trials
    const large = wilsonInterval(900, 1000); // 90% on 1000 trials
    const smallWidth = small.upper - small.lower;
    const largeWidth = large.upper - large.lower;
    assert(smallWidth > largeWidth, `small-n interval (${smallWidth.toFixed(4)}) should be wider than large-n interval (${largeWidth.toFixed(4)})`);
  });

  test('a stable ~90% pass rate before and after is classified FLAKY_OR_NO_CHANGE, not REGRESSION', () => {
    const r = classifyFlakyVsRegression({ beforePasses: 90, beforeTrials: 100, afterPasses: 88, afterTrials: 100 });
    assertEqual(r.verdict, 'FLAKY_OR_NO_CHANGE');
  });

  test('a real drop from 98% to 60% pass rate is classified REGRESSION', () => {
    const r = classifyFlakyVsRegression({ beforePasses: 98, beforeTrials: 100, afterPasses: 60, afterTrials: 100 });
    assertEqual(r.verdict, 'REGRESSION');
  });

  test('insufficient sample size is reported explicitly rather than guessed', () => {
    const r = classifyFlakyVsRegression({ beforePasses: 2, beforeTrials: 2, afterPasses: 0, afterTrials: 1 });
    assertEqual(r.verdict, 'INSUFFICIENT_DATA');
  });

  return results;
}
module.exports = { run };
