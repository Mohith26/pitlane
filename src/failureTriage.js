'use strict';

/**
 * Clusters raw test-failure log lines into distinct root-cause groups.
 * Real HIL/CI systems generate thousands of failure logs where the
 * SAME underlying bug produces slightly different text each time
 * (different line numbers, different variable values, different stack
 * addresses) - so exact string matching under-clusters massively and
 * a human triager would otherwise have to read every single failure.
 *
 * Approach: normalize each log line (strip numeric tokens, hex
 * addresses, and known-volatile substrings), then cluster by Jaccard
 * similarity of shingled tokens (this is a lightweight, dependency-
 * free stand-in for a production near-duplicate-detection pipeline
 * like MinHash/LSH - the same idea, just without the sketching
 * approximation since our N here is small enough for exact pairwise
 * comparison to be fast). Two failures are the same cluster if their
 * normalized-token Jaccard similarity exceeds a threshold.
 */

function normalize(line) {
  return line
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\b\d+\.\d+\b/g, '<float>')
    .replace(/\b\d+\b/g, '<num>')
    .replace(/[^a-z<>_\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function shingles(tokens, k = 2) {
  const s = new Set();
  for (let i = 0; i + k <= tokens.length; i++) {
    s.add(tokens.slice(i, i + k).join('_'));
  }
  if (s.size === 0 && tokens.length > 0) tokens.forEach((t) => s.add(t));
  return s;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * @param {string[]} failureLogs raw failure text lines
 * @param {number} threshold Jaccard similarity threshold to join a cluster
 * @returns {{clusters: Array<{representative:string, members:number[]}>, clusterCount:number}}
 */
function clusterFailures(failureLogs, threshold = 0.5) {
  const shingleSets = failureLogs.map((l) => shingles(normalize(l)));
  const clusters = []; // {repShingles, members:[]}
  for (let i = 0; i < failureLogs.length; i++) {
    let bestCluster = null;
    let bestSim = 0;
    for (const c of clusters) {
      const sim = jaccard(shingleSets[i], c.repShingles);
      if (sim > bestSim) { bestSim = sim; bestCluster = c; }
    }
    if (bestCluster && bestSim >= threshold) {
      bestCluster.members.push(i);
    } else {
      clusters.push({ repShingles: shingleSets[i], repIndex: i, members: [i] });
    }
  }
  return {
    clusters: clusters.map((c) => ({ representative: failureLogs[c.repIndex], members: c.members })),
    clusterCount: clusters.length,
  };
}

/**
 * Evaluates clustering quality against a ground-truth labeling (used
 * only in tests/benchmarks with synthetic labeled data - real triage
 * has no ground truth, which is exactly why this evaluation only runs
 * against synthetic data with a known-planted cluster assignment).
 * Uses pairwise precision/recall: for every pair of failures, did the
 * clustering agree with the ground truth on same-cluster vs
 * different-cluster?
 */
function evaluateClustering(predictedClusters, groundTruthLabels) {
  const predictedLabel = new Array(groundTruthLabels.length);
  predictedClusters.clusters.forEach((c, ci) => {
    for (const m of c.members) predictedLabel[m] = ci;
  });
  let truePositive = 0, falsePositive = 0, falseNegative = 0;
  const n = groundTruthLabels.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sameGT = groundTruthLabels[i] === groundTruthLabels[j];
      const samePred = predictedLabel[i] === predictedLabel[j];
      if (samePred && sameGT) truePositive += 1;
      else if (samePred && !sameGT) falsePositive += 1;
      else if (!samePred && sameGT) falseNegative += 1;
    }
  }
  const precision = truePositive + falsePositive === 0 ? 1 : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? 1 : truePositive / (truePositive + falseNegative);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, truePositive, falsePositive, falseNegative };
}

module.exports = { normalize, shingles, jaccard, clusterFailures, evaluateClustering };
