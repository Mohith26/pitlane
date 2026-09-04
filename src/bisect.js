'use strict';

/**
 * Automated culprit bisection over a commit range, robust to flaky
 * tests - a plain binary search assumes a deterministic test outcome
 * per commit, which is false for any test with a nonzero flake rate.
 * This implements a repeated-sampling bisection: at each candidate
 * commit, run the test `samplesPerCommit` times and classify the
 * commit as "good" or "bad" via a majority vote (or a configurable
 * confidence threshold), rather than trusting a single noisy run.
 *
 * `oracle(commitIndex)` is caller-supplied and returns a single
 * pass/fail Boolean for one run of the test at that commit - in tests
 * we supply a synthetic oracle with a real bug injected at a known
 * commit plus a configurable background flake rate, so we can measure
 * how many total test-runs bisection actually costs at various flake
 * rates, and confirm it still finds the true culprit commit.
 */
function sampleCommit(oracle, commitIndex, samplesPerCommit, rng) {
  let passes = 0;
  for (let i = 0; i < samplesPerCommit; i++) {
    if (oracle(commitIndex, rng)) passes += 1;
  }
  return passes;
}

/**
 * @param {number} goodCommit known-good commit index (test passes)
 * @param {number} badCommit known-bad commit index (test currently fails)
 * @param {(idx:number, rng:Function)=>boolean} oracle
 * @param {object} opts { samplesPerCommit, majorityThreshold, rng }
 * @returns {{culprit:number, totalRuns:number, stepsChecked:number}}
 */
function bisectFlaky(goodCommit, badCommit, oracle, opts = {}) {
  const samplesPerCommit = opts.samplesPerCommit ?? 7;
  const majorityThreshold = opts.majorityThreshold ?? 0.5;
  const rng = opts.rng ?? Math.random;
  let lo = goodCommit; // last known good
  let hi = badCommit; // known bad
  let totalRuns = 0;
  let stepsChecked = 0;

  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const passes = sampleCommit(oracle, mid, samplesPerCommit, rng);
    totalRuns += samplesPerCommit;
    stepsChecked += 1;
    const passRate = passes / samplesPerCommit;
    if (passRate >= majorityThreshold) {
      lo = mid; // mid behaves "good" -> culprit is after mid
    } else {
      hi = mid; // mid behaves "bad" -> culprit is at or before mid
    }
  }
  return { culprit: hi, totalRuns, stepsChecked };
}

module.exports = { bisectFlaky, sampleCommit };
