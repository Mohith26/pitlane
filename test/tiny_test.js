'use strict';
function makeSuite(name) {
  const results = { name, passed: 0, failed: 0, assertions: 0, failures: [] };
  function test(desc, fn) {
    try { fn(); results.passed += 1; }
    catch (e) { results.failed += 1; results.failures.push({ desc, error: e.message }); }
  }
  function assert(cond, msg) {
    results.assertions += 1;
    if (!cond) throw new Error(msg || 'assertion failed');
  }
  function assertEqual(a, b, msg) {
    results.assertions += 1;
    if (a !== b) throw new Error(msg || `expected ${b}, got ${a}`);
  }
  function assertClose(a, b, eps, msg) {
    results.assertions += 1;
    if (Math.abs(a - b) > eps) throw new Error(msg || `expected ~${b} (eps ${eps}), got ${a}`);
  }
  return { results, test, assert, assertEqual, assertClose };
}
module.exports = { makeSuite };
