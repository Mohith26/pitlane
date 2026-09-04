# Pitlane

Test-infrastructure tooling for the part of hardware-in-the-loop (HIL) testing that has nothing to do with the vehicle itself: scheduling scarce, heterogeneous bench time across a huge backlog of test jobs, turning thousands of noisy failure logs into a handful of actual root causes, telling a flaky test apart from a real regression with actual statistical rigor, automatically bisecting to a culprit commit even when the test itself isn't perfectly deterministic, and gating a release on confidence intervals instead of raw pass-rate numbers that can lie at small sample sizes.

I built this after reading into how AV companies structure validation between simulation and the road (Waymo's own Simulation City writeup, and the general HIL literature): a HIL bench (compute unit + sensor-data playback + vehicle dynamics model + fault injection) sits deliberately between pure software simulation and real road miles because it's the first point where the *actual* compute stack runs against injected faults in real time - and bench time is expensive and scarce, so the software that decides what runs where and what a result actually means becomes its own real engineering problem.

## What's in here

- **`src/benchScheduler.js`** - a priority-aware, capability-matching scheduler for a heterogeneous bench pool (each bench has different compute/sensor capabilities; each job needs a specific subset), with preemption for urgent jobs. Benchmarked against a naive FIFO baseline that blocks on head-of-line capability mismatches instead of skipping ahead.
- **`src/failureTriage.js`** - clusters raw failure log text into distinct root-cause groups using normalized token-shingle Jaccard similarity (a lightweight stand-in for a production MinHash/LSH near-duplicate pipeline), so a human doesn't have to read every one of thousands of failures that are really just N root causes with cosmetic differences (line numbers, timestamps, addresses).
- **`src/flakyDetect.js`** - Wilson score confidence intervals (much better small-sample behavior than a naive normal approximation) plus a two-proportion z-test to decide whether an observed pass-rate drop is a real regression or noise.
- **`src/bisect.js`** - culprit-commit bisection that's explicitly robust to flaky tests: instead of trusting one run per candidate commit, it samples N times and majority-votes, with the required sample count derived from how noisy the test actually is.
- **`src/qualify.js`** - a release-qualification report generator: gates GO/NO-GO per requirement on the *lower bound* of a Wilson confidence interval (not the raw observed rate), plus a quarantine-decision helper that flags genuinely flaky tests without hiding tests that are just consistently broken.

## Running it

Zero dependencies, plain CommonJS, runs on any real Node.js:

```
node test/benchScheduler.test.js
node test/failureTriage.test.js
node test/flakyDetect.test.js
node test/bisect.test.js
node test/qualify.test.js
```

## Results (measured, not estimated)

- **21/21 tests passing, 229 assertions, 0 failures.**
- **Capability-aware preemptive scheduling cuts makespan 13.3%** versus naive FIFO on the same 150-job/3-bench randomized workload (22,525ms vs 25,990ms), at 60.4% bench utilization.
- **Failure clustering on a clean synthetic 4-root-cause dataset (400 failures): precision 1.0, recall 1.0.** But rather than stop there - a perfect score is usually a sign the benchmark is too easy, not that the code is great - I built a deliberately harder 6-root-cause dataset with two templates sharing almost all their vocabulary on purpose. Honest result: **precision 0.747, recall 1.0, F1 0.855**, correctly (if a bit over-aggressively) merging the two near-duplicate templates into one cluster.
- **Bisection finds the exact culprit commit across a 2,000-commit range at every flake rate tested (0% to 40%)** - but only once the samples-per-commit budget is scaled to the noise level (1 sample at 0% flake, up to 401 samples at 40% flake, derived from a normal-approximation separation bound). A fixed small sample budget (7/commit) was confirmed, across 20 random seeds, to sometimes converge on the *wrong* culprit entirely once flake rate hit 35% - kept in the test suite as an honest negative result, since it's the actual reason the tool scales sample size adaptively instead of using one fixed number.
- **Release-qualification gating correctly refuses to certify a 3-for-3 perfect test run** (Wilson lower bound 0.44, below a 0.95 confidence threshold) while certifying the identical 100% observed rate at 300 trials (lower bound 0.987) - the whole point being that "100% pass rate" means very different things depending on sample size, which a raw pass-rate cutoff can't tell apart.

Full numbers in `results/results.json`.

## Honest limitations

- The scheduler and clustering are algorithmically real and independently benchmarked, but they operate on synthetic jobs/logs, not an actual HIL rig or real AV failure corpus (I don't have access to either).
- The failure-triage similarity metric is a lightweight Jaccard-on-shingles approach, not a production-grade embedding/LSH pipeline - it's a faithful, dependency-free demonstration of the same underlying idea, not a claim of matching a real large-scale triage system's accuracy.
- Bisection sample-size scaling is derived from a normal approximation, not a full sequential probability ratio test (SPRT) - a real implementation of this idea in production would likely reach for SPRT for better sample efficiency at high flake rates.
