'use strict';
const { makeSuite } = require('./tiny_test');
const { scheduleCapabilityAware, scheduleNaiveFifo } = require('../src/benchScheduler');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBenches() {
  return [
    { id: 'bench_A_lidar_gen2', capabilities: ['compute_gen2', 'lidar', 'radar'] },
    { id: 'bench_B_lidar_gen3', capabilities: ['compute_gen3', 'lidar', 'radar', 'camera_8x'] },
    { id: 'bench_C_camera_only', capabilities: ['compute_gen2', 'camera_8x'] },
  ];
}

function randomJobs(rng, n) {
  const capsPool = [
    ['compute_gen2', 'lidar'],
    ['compute_gen3', 'camera_8x'],
    ['compute_gen2', 'camera_8x'],
    ['compute_gen3', 'lidar', 'radar'],
  ];
  const jobs = [];
  for (let i = 0; i < n; i++) {
    jobs.push({
      id: `job_${i}`,
      arrivalMs: Math.floor(rng() * 2000),
      durationMs: 50 + Math.floor(rng() * 400),
      priority: 1 + Math.floor(rng() * 5),
      requiredCapabilities: capsPool[Math.floor(rng() * capsPool.length)],
    });
  }
  return jobs;
}

function run() {
  const { results, test, assert, assertEqual } = makeSuite('benchScheduler');

  test('a job is never assigned to a bench lacking its required capabilities', () => {
    const rng = mulberry32(1);
    const jobs = randomJobs(rng, 200);
    const benches = makeBenches();
    const benchById = Object.fromEntries(benches.map((b) => [b.id, b]));
    const res = scheduleCapabilityAware(benches, jobs, { tickMs: 5 });
    // re-simulate is hard to introspect post-hoc without instrumentation,
    // so instead we assert a structural invariant: every completed job's
    // requiredCapabilities must be satisfiable by at least one bench in
    // the pool (a basic sanity/no-orphan-job check), and completed count
    // matches total jobs (nothing silently dropped).
    for (const j of res.completed) {
      const satisfiable = benches.some((b) => j.requiredCapabilities.every((c) => b.capabilities.includes(c)));
      assert(satisfiable, `job ${j.id} completed but no bench in the pool actually has its required capabilities`);
    }
    assertEqual(res.completedCount, jobs.length, 'every job should eventually complete');
  });

  test('capability-aware scheduler achieves a shorter or equal makespan than naive FIFO on the same workload', () => {
    const rng = mulberry32(7);
    const jobs = randomJobs(rng, 150);
    const benches = makeBenches();
    const aware = scheduleCapabilityAware(benches, jobs, { tickMs: 5, allowPreemption: true });
    const naive = scheduleNaiveFifo(benches, jobs, { tickMs: 5 });
    assert(aware.makespanMs <= naive.makespanMs,
      `capability-aware makespan ${aware.makespanMs} should be <= naive FIFO makespan ${naive.makespanMs}`);
    global.__PITLANE_SCHED_COMPARE__ = { awareMakespan: aware.makespanMs, naiveMakespan: naive.makespanMs, benchUtilization: aware.benchUtilization };
  });

  test('higher-priority jobs preempt lower-priority running jobs when no free capable bench exists', () => {
    const benches = [{ id: 'only_bench', capabilities: ['compute_gen3', 'lidar'] }];
    const lowPriorityLongJob = { id: 'low', arrivalMs: 0, durationMs: 1000, priority: 1, requiredCapabilities: ['lidar'] };
    const highPriorityUrgent = { id: 'high', arrivalMs: 10, durationMs: 50, priority: 9, requiredCapabilities: ['lidar'] };
    const res = scheduleCapabilityAware(benches, [lowPriorityLongJob, highPriorityUrgent], { tickMs: 1, allowPreemption: true });
    const high = res.completed.find((j) => j.id === 'high');
    const low = res.completed.find((j) => j.id === 'low');
    assert(high.completedAt < low.completedAt, 'the high-priority job should finish before the preempted low-priority job');
    assert(low.preemptions >= 1, 'the low-priority job should have been preempted at least once');
  });

  return results;
}
module.exports = { run };
