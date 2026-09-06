#!/usr/bin/env node
'use strict';
/**
 * Test runner. `npm test` / `node test/run.js`
 *
 * Runs entirely offline against the cached data in data/raw/, so the suite is
 * reproducible and works with no network access.
 *
 * Exit codes: 0 all passed, 1 one or more failures.
 */

const { summary } = require('./harness');

const SUITES = [
  ['core', require('./core.test')],
  ['sources', require('./sources.test')],
  ['pipeline & CLI', require('./pipeline.test')],
  ['cross-surface equivalence', require('./equivalence.test')],
];

(async () => {
  const started = Date.now();
  process.stdout.write('ev-charge-map-au test suite\n');
  process.stdout.write('='.repeat(58) + '\n');

  for (const [name, suite] of SUITES) {
    try {
      await suite();
    } catch (err) {
      process.stdout.write(`\n!! suite "${name}" threw outside a test: ${err.message}\n`);
      process.stdout.write(String(err.stack) + '\n');
      process.exitCode = 1;
    }
  }

  const ok = summary();
  process.stdout.write(`\nCompleted in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  process.exit(ok && !process.exitCode ? 0 : 1);
})();
