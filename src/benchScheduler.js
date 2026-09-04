'use strict';

/**
 * Schedules a queue of test jobs onto a scarce, heterogeneous pool of
 * hardware-in-the-loop benches. This models the real resource-
 * allocation problem behind "scale test execution on HIL benches": you
 * have far more test jobs than benches, each job needs a bench with
 * specific capabilities (a given compute/ECU variant, a given sensor
 * suite, a given fault-injection harness), jobs have different
 * priorities (a release-qualification job should preempt a routine
 * regression job), and bench time is the bottleneck resource the whole
 * system exists to use efficiently.
 *
 * Algorithm: a priority-aware list scheduler with capability matching.
 * At each scheduling tick:
 *   1. Free any benches whose running job just finished.
 *   2. For each free bench, find the highest-priority *waiting* job
 *      whose capability requirements are a subset of that bench's
 *      capabilities (bin-packing-style "does this bench qualify" check).
 *   3. If a strictly higher-priority job is waiting and no bench is
 *      free, and preemption is enabled, preempt the lowest-priority
 *      *running* job on a bench that could serve the new job (its
 *      progress is checkpointed and it re-queues, modeling how a real
 *      HIL run can be checkpointed/resumed rather than losing all work).
 *
 * Baseline comparison: a naive FIFO-no-capability-awareness scheduler
 * (assigns jobs to any free bench in arrival order, blocking on
 * capability mismatch instead of skipping to a servable job) is
 * implemented alongside for a fair before/after throughput comparison.
 */

function capabilitiesSatisfied(benchCaps, jobReqs) {
  return jobReqs.every((req) => benchCaps.includes(req));
}

class Bench {
  constructor(id, capabilities) {
    this.id = id;
    this.capabilities = capabilities;
    this.busyUntil = 0;
    this.runningJob = null;
  }
}

/**
 * Priority + capability-aware scheduler. Returns per-job completion
 * times and per-bench utilization, run over a discrete tick loop.
 */
function scheduleCapabilityAware(benches, jobs, opts = {}) {
  const allowPreemption = opts.allowPreemption ?? true;
  const benchList = benches.map((b) => new Bench(b.id, b.capabilities));
  const waiting = jobs
    .map((j, i) => ({ ...j, arrivalOrder: i, remainingMs: j.durationMs, startedAt: null, completedAt: null, preemptions: 0 }))
    .sort((a, b) => a.arrivalMs - b.arrivalMs);
  const notYetArrived = [...waiting];
  const queue = [];
  const completed = [];
  let now = 0;
  const tick = opts.tickMs ?? 1;
  const horizon = opts.horizonMs ?? 10_000_000;
  let totalBenchBusyMs = 0;

  while ((queue.length > 0 || notYetArrived.length > 0 || benchList.some((b) => b.runningJob)) && now < horizon) {
    // admit arrivals
    while (notYetArrived.length > 0 && notYetArrived[0].arrivalMs <= now) {
      queue.push(notYetArrived.shift());
    }
    // free finished benches
    for (const bench of benchList) {
      if (bench.runningJob && bench.busyUntil <= now) {
        bench.runningJob.completedAt = now;
        completed.push(bench.runningJob);
        bench.runningJob = null;
      }
    }
    // sort waiting queue by priority (higher number = higher priority), then FIFO
    queue.sort((a, b) => (b.priority - a.priority) || (a.arrivalOrder - b.arrivalOrder));

    for (let qi = 0; qi < queue.length; qi++) {
      const job = queue[qi];
      const freeBench = benchList.find((b) => !b.runningJob && capabilitiesSatisfied(b.capabilities, job.requiredCapabilities));
      if (freeBench) {
        freeBench.runningJob = job;
        job.startedAt = job.startedAt ?? now;
        freeBench.busyUntil = now + job.remainingMs;
        totalBenchBusyMs += job.remainingMs;
        queue.splice(qi, 1);
        qi -= 1;
        continue;
      }
      if (allowPreemption) {
        // find a running job with strictly lower priority on a bench that could serve this job
        const preemptTarget = benchList
          .filter((b) => b.runningJob && capabilitiesSatisfied(b.capabilities, job.requiredCapabilities) && b.runningJob.priority < job.priority)
          .sort((a, b) => a.runningJob.priority - b.runningJob.priority)[0];
        if (preemptTarget) {
          const victim = preemptTarget.runningJob;
          victim.remainingMs = preemptTarget.busyUntil - now;
          victim.preemptions += 1;
          victim.startedAt = null; // will restart later, checkpointed
          queue.push(victim);
          preemptTarget.runningJob = job;
          job.startedAt = job.startedAt ?? now;
          preemptTarget.busyUntil = now + job.remainingMs;
          totalBenchBusyMs += job.remainingMs;
          queue.splice(qi, 1);
          qi -= 1;
        }
      }
    }
    now += tick;
  }

  const makespan = completed.length > 0 ? Math.max(...completed.map((j) => j.completedAt)) : 0;
  const totalBenchCapacityMs = benchList.length * makespan;
  return {
    completed,
    makespanMs: makespan,
    benchUtilization: totalBenchCapacityMs > 0 ? totalBenchBusyMs / totalBenchCapacityMs : 0,
    totalJobs: jobs.length,
    completedCount: completed.length,
  };
}

/** Naive baseline: FIFO order, blocks on the head-of-line job if no capable bench is free (no skip-ahead, no preemption). */
function scheduleNaiveFifo(benches, jobs, opts = {}) {
  const benchList = benches.map((b) => new Bench(b.id, b.capabilities));
  const arrivalsSorted = jobs.map((j, i) => ({ ...j, arrivalOrder: i })).sort((a, b) => a.arrivalMs - b.arrivalMs);
  const completed = [];
  let now = 0;
  const tick = opts.tickMs ?? 1;
  const horizon = opts.horizonMs ?? 10_000_000;
  const remaining = [...arrivalsSorted];

  while ((remaining.length > 0 || benchList.some((b) => b.runningJob)) && now < horizon) {
    for (const bench of benchList) {
      if (bench.runningJob && bench.busyUntil <= now) {
        bench.runningJob.completedAt = now;
        completed.push(bench.runningJob);
        bench.runningJob = null;
      }
    }
    if (remaining.length > 0 && remaining[0].arrivalMs <= now) {
      const headJob = remaining[0];
      const freeBench = benchList.find((b) => !b.runningJob && capabilitiesSatisfied(b.capabilities, headJob.requiredCapabilities));
      if (freeBench) {
        freeBench.runningJob = headJob;
        headJob.startedAt = now;
        freeBench.busyUntil = now + headJob.durationMs;
        remaining.shift();
      }
      // if no capable free bench, naive FIFO just waits (head-of-line blocking) - this is the point of the comparison
    }
    now += tick;
  }
  const makespan = completed.length > 0 ? Math.max(...completed.map((j) => j.completedAt)) : 0;
  return { completed, makespanMs: makespan, totalJobs: jobs.length, completedCount: completed.length };
}

module.exports = { scheduleCapabilityAware, scheduleNaiveFifo, capabilitiesSatisfied };
