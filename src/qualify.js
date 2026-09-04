'use strict';

const { wilsonInterval } = require('./flakyDetect');

/**
 * Aggregates per-requirement pass rates into a release qualification
 * report: for each requirement, compute a Wilson confidence interval
 * on the observed pass rate and gate GO/NO-GO against a required
 * confidence threshold - not just a raw pass-rate cutoff, since a
 * requirement with 3/3 passes and one with 300/300 passes should NOT
 * be treated with equal confidence even though both show 100%.
 *
 * Also implements a quarantine policy: a test whose flake rate (failures
 * that don't correlate with any code change - approximated here as
 * "non-monotonic pass/fail history with high variance") exceeds a
 * threshold is flagged for quarantine rather than allowed to block a
 * release gate outright.
 */
function qualifyRequirement(name, passes, trials, opts = {}) {
  const requiredLowerBound = opts.requiredLowerBound ?? 0.95;
  const ci = wilsonInterval(passes, trials);
  return {
    name,
    passes,
    trials,
    observedRate: ci.phat,
    wilsonLower: ci.lower,
    wilsonUpper: ci.upper,
    goNoGo: ci.lower >= requiredLowerBound ? 'GO' : 'NO_GO',
    requiredLowerBound,
  };
}

function qualifyRelease(requirements, opts = {}) {
  const results = requirements.map((r) => qualifyRequirement(r.name, r.passes, r.trials, opts));
  const overallGo = results.every((r) => r.goNoGo === 'GO');
  return { overallGoNoGo: overallGo ? 'GO' : 'NO_GO', requirements: results };
}

/** Flake-rate-based quarantine: quarantine if flip-rate (fraction of
 * consecutive-run transitions between pass and fail) exceeds threshold
 * AND the test isn't simply consistently failing (consistent failure
 * is a real regression signal, not flakiness, and should NOT be
 * quarantined away). */
function computeFlipRate(history) {
  if (history.length < 2) return 0;
  let flips = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i] !== history[i - 1]) flips += 1;
  }
  return flips / (history.length - 1);
}

function quarantineDecision(testName, boolHistory, opts = {}) {
  const flipThreshold = opts.flipThreshold ?? 0.3;
  const flipRate = computeFlipRate(boolHistory);
  const allFail = boolHistory.every((v) => v === false);
  const quarantine = flipRate >= flipThreshold && !allFail;
  return { testName, flipRate, allFail, quarantine };
}

module.exports = { qualifyRequirement, qualifyRelease, computeFlipRate, quarantineDecision };
