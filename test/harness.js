'use strict';
/**
 * Minimal test harness. Zero dependencies — no Jest, no Mocha.
 *
 * Provides describe/it/assertions, collects failures, and reports a summary
 * with a non-zero exit code on failure so CI can gate on it.
 */

const results = { passed: 0, failed: 0, skipped: 0, failures: [] };
let currentSuite = '';

function describe(name, fn) {
  currentSuite = name;
  process.stdout.write(`\n${name}\n`);
  fn();
  currentSuite = '';
}

function it(name, fn) {
  try {
    const out = fn();
    if (out === 'skip') {
      results.skipped++;
      process.stdout.write(`  - ${name} (skipped)\n`);
      return;
    }
    results.passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    results.failed++;
    results.failures.push({ suite: currentSuite, name, error: err });
    process.stdout.write(`  ✗ ${name}\n      ${err.message}\n`);
  }
}

function fail(message) {
  throw new Error(message);
}

const assert = {
  ok(value, message) {
    if (!value) fail(message || `expected truthy, got ${JSON.stringify(value)}`);
  },
  notOk(value, message) {
    if (value) fail(message || `expected falsy, got ${JSON.stringify(value)}`);
  },
  equal(actual, expected, message) {
    if (actual !== expected) {
      fail(message || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
  notEqual(actual, expected, message) {
    if (actual === expected) fail(message || `expected value to differ from ${JSON.stringify(expected)}`);
  },
  deepEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) fail(message || `deep equality failed:\n      actual:   ${a}\n      expected: ${b}`);
  },
  closeTo(actual, expected, tolerance, message) {
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
      fail(message || `expected ${actual} to be within ${tolerance} of ${expected}`);
    }
  },
  greaterThan(actual, bound, message) {
    if (!(actual > bound)) fail(message || `expected ${actual} > ${bound}`);
  },
  atLeast(actual, bound, message) {
    if (!(actual >= bound)) fail(message || `expected ${actual} >= ${bound}`);
  },
  atMost(actual, bound, message) {
    if (!(actual <= bound)) fail(message || `expected ${actual} <= ${bound}`);
  },
  includes(haystack, needle, message) {
    const ok = Array.isArray(haystack) ? haystack.includes(needle) : String(haystack).includes(needle);
    if (!ok) fail(message || `expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`);
  },
  throws(fn, message) {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    if (!threw) fail(message || 'expected function to throw');
  },
};

function summary() {
  const total = results.passed + results.failed + results.skipped;
  process.stdout.write('\n' + '-'.repeat(58) + '\n');
  process.stdout.write(
    `${results.passed}/${total} passed` +
      (results.failed ? `, ${results.failed} FAILED` : '') +
      (results.skipped ? `, ${results.skipped} skipped` : '') +
      '\n'
  );
  if (results.failed) {
    process.stdout.write('\nFailures:\n');
    for (const f of results.failures) {
      process.stdout.write(`  ${f.suite} > ${f.name}\n    ${f.error.stack || f.error.message}\n`);
    }
  }
  return results.failed === 0;
}

module.exports = { assert, describe, it, results, summary };
