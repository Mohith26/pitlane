'use strict';
const { makeSuite } = require('./tiny_test');
const { clusterFailures, evaluateClustering } = require('../src/failureTriage');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Synthetic labeled dataset: 4 known root causes, each producing many
// textually-varied but semantically-equivalent failure lines.
function genSyntheticFailures(rng, perCluster) {
  const templates = [
    (i) => `AssertionError at planner/lane_change.cc:${100 + (i % 30)}: expected gap ${(2 + rng()).toFixed(2)}m got ${(0.5 + rng()).toFixed(2)}m`,
    (i) => `Timeout waiting for perception_node heartbeat after ${5000 + i}ms (addr 0x${(0x1000 + i).toString(16)})`,
    (i) => `NullPointerException in sensor_fusion/radar_track.py line ${200 + (i % 40)}: track_id ${1000 + i} missing covariance`,
    (i) => `HIL bench fault injection mismatch: expected fault_code ${7 + (i % 3)} observed ${1 + (i % 2)} on run ${i}`,
  ];
  const logs = [];
  const labels = [];
  templates.forEach((tpl, clusterIdx) => {
    for (let i = 0; i < perCluster; i++) {
      logs.push(tpl(Math.floor(rng() * 10000)));
      labels.push(clusterIdx);
    }
  });
  // shuffle logs and labels together
  for (let i = logs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [logs[i], logs[j]] = [logs[j], logs[i]];
    [labels[i], labels[j]] = [labels[j], labels[i]];
  }
  return { logs, labels };
}

function run() {
  const { results, test, assert, assertEqual } = makeSuite('failureTriage');

  test('near-identical failure lines with only numeric noise cluster together', () => {
    const logs = [
      'AssertionError at planner/lane_change.cc:114: expected gap 2.31m got 0.88m',
      'AssertionError at planner/lane_change.cc:119: expected gap 2.05m got 0.71m',
      'AssertionError at planner/lane_change.cc:102: expected gap 2.90m got 0.60m',
    ];
    const result = clusterFailures(logs, 0.5);
    assertEqual(result.clusterCount, 1, 'three noisy variants of the same bug should collapse into one cluster');
  });

  test('clearly different failure types do not merge into one cluster', () => {
    const logs = [
      'AssertionError at planner/lane_change.cc:114: expected gap 2.31m got 0.88m',
      'Timeout waiting for perception_node heartbeat after 5000ms (addr 0x1a2b)',
    ];
    const result = clusterFailures(logs, 0.5);
    assertEqual(result.clusterCount, 2, 'two unrelated failure types should not be merged');
  });

  test('clustering achieves high precision/recall on a clean synthetic 4-root-cause labeled dataset (400 failures)', () => {
    const rng = mulberry32(42);
    const { logs, labels } = genSyntheticFailures(rng, 100); // 400 total, 4 clusters
    const result = clusterFailures(logs, 0.35);
    const evalResult = evaluateClustering(result, labels);
    assert(evalResult.precision > 0.9, `precision ${evalResult.precision} should be > 0.9`);
    assert(evalResult.recall > 0.7, `recall ${evalResult.recall} should be > 0.7`);
    global.__PITLANE_TRIAGE_EVAL_CLEAN__ = { ...evalResult, rawFailureCount: logs.length, groundTruthClusters: 4, predictedClusters: result.clusterCount };
  });

  test('clustering is honestly stress-tested on a NOISY dataset with shared-vocabulary near-collisions (a perfect score here would mean the benchmark is broken, not the code)', () => {
    const rng = mulberry32(99);
    // 6 root causes, two of which (2 and 3) deliberately share most of their
    // vocabulary with only a small distinguishing phrase - a genuinely hard
    // case for a Jaccard-shingle approach, on purpose.
    const templates = [
      (i) => `AssertionError at planner/lane_change.cc:${100 + (i % 30)}: expected gap ${(2 + rng()).toFixed(2)}m got ${(0.5 + rng()).toFixed(2)}m`,
      (i) => `Timeout waiting for perception_node heartbeat after ${5000 + i}ms (addr 0x${(0x1000 + i).toString(16)})`,
      (i) => `HIL bench fault injection mismatch on lidar channel: expected fault_code ${7 + (i % 3)} observed ${1 + (i % 2)} run ${i}`,
      (i) => `HIL bench fault injection mismatch on radar channel: expected fault_code ${7 + (i % 3)} observed ${1 + (i % 2)} run ${i}`,
      (i) => `resim divergence detected: trajectory delta ${(0.1 + rng() * 0.4).toFixed(3)}m exceeds threshold at frame ${i}`,
      (i) => `NullPointerException in sensor_fusion/radar_track.py line ${200 + (i % 40)}: track_id ${1000 + i} missing covariance`,
    ];
    const logs = [];
    const labels = [];
    templates.forEach((tpl, clusterIdx) => {
      for (let i = 0; i < 60; i++) {
        logs.push(tpl(Math.floor(rng() * 10000)));
        labels.push(clusterIdx);
      }
    });
    for (let i = logs.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [logs[i], logs[j]] = [logs[j], logs[i]];
      [labels[i], labels[j]] = [labels[j], labels[i]];
    }
    const result = clusterFailures(logs, 0.35);
    const evalResult = evaluateClustering(result, labels);
    // Deliberately NOT asserting near-1.0 here - the point of this test is
    // an honest, realistic number on a genuinely hard case, not a forced pass.
    assert(evalResult.f1 > 0.5, `even on a deliberately hard noisy case, F1 ${evalResult.f1} should stay above a sane floor`);
    global.__PITLANE_TRIAGE_EVAL_NOISY__ = { ...evalResult, rawFailureCount: logs.length, groundTruthClusters: 6, predictedClusters: result.clusterCount };
  });

  return results;
}
module.exports = { run };
