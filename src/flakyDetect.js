'use strict';

/**
 * Statistically distinguishes "flaky test" from "real regression" and
 * computes confidence-interval-backed release qualification gates -
 * the actual hard part of release qualification isn't running the
 * tests, it's deciding what a pass rate ACTUALLY MEANS given finite,
 * noisy sample sizes.
 */

/** Wilson score interval for a binomial proportion - much better
 * coverage than the naive normal approximation at small n or extreme
 * p, which is exactly the regime release-qualification tests live in
 * (you often only have 10-50 runs of a given qualification test). */
function wilsonInterval(successes, trials, z = 1.96) {
  if (trials === 0) return { lower: 0, upper: 1, phat: 0 };
  const phat = successes / trials;
  const denom = 1 + (z * z) / trials;
  const center = phat + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((phat * (1 - phat)) / trials + (z * z) / (4 * trials * trials));
  return {
    phat,
    lower: Math.max(0, (center - margin) / denom),
    upper: Math.min(1, (center + margin) / denom),
  };
}

/**
 * Two-proportion z-test comparing a test's pre-change and post-change
 * pass rate, to decide whether an observed pass-rate drop is
 * statistically distinguishable from noise (flaky) or a real
 * regression. Returns a z-score and an approximate two-sided p-value
 * (via a numerically stable erf-based normal CDF - no external stats
 * library).
 */
function erf(x) {
  // Abramowitz & Stegun 7.1.26 approximation, max error ~1.5e-7
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function twoProportionTest(successesA, trialsA, successesB, trialsB) {
  const pA = successesA / trialsA;
  const pB = successesB / trialsB;
  const pPool = (successesA + successesB) / (trialsA + trialsB);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / trialsA + 1 / trialsB));
  if (se === 0) return { z: 0, pValue: 1, pA, pB };
  const z = (pA - pB) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, pValue, pA, pB };
}

/**
 * Classifies a test as FLAKY, REGRESSION, or INSUFFICIENT_DATA given
 * its pass/fail history split into a "before" window and an "after"
 * (candidate-regression) window.
 */
function classifyFlakyVsRegression({ beforePasses, beforeTrials, afterPasses, afterTrials }, opts = {}) {
  const minTrials = opts.minTrials ?? 5;
  const alpha = opts.alpha ?? 0.05;
  if (beforeTrials < minTrials || afterTrials < minTrials) {
    return { verdict: 'INSUFFICIENT_DATA', beforeTrials, afterTrials };
  }
  const { z, pValue, pA, pB } = twoProportionTest(beforePasses, beforeTrials, afterPasses, afterTrials);
  const afterCi = wilsonInterval(afterPasses, afterTrials);
  const significant = pValue < alpha && pB < pA;
  return {
    verdict: significant ? 'REGRESSION' : 'FLAKY_OR_NO_CHANGE',
    beforePassRate: pA,
    afterPassRate: pB,
    afterConfidenceInterval: afterCi,
    pValue,
    zScore: z,
  };
}

module.exports = { wilsonInterval, twoProportionTest, classifyFlakyVsRegression, erf, normalCdf };
