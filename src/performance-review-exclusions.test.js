'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PERFORMANCE_REVIEW_EXCLUDE_PATTERNS, matchExclusion } = require('./performance-review-exclusions.js');

test('matchExclusion: matching paths return a pattern name', () => {
  for (const p of ['webpack.config.js', 'dist/app.min.js', 'scripts/one-shot/x.js']) {
    assert.notEqual(matchExclusion(p), null, p);
  }
});

test('matchExclusion: non-matching paths return null', () => {
  const inputs = ['bin/worker.js', 'src/server.js', 'myvendor/x.js', 'undefined', '', undefined, null, 42];
  for (const p of inputs) {
    assert.equal(matchExclusion(p), null, String(p));
  }
});

test('matchExclusion: each pattern name is returned for its own example', () => {
  const examples = {
    'webpack.config.*': 'webpack.config.js',
    'rollup.config.*': 'rollup.config.mjs',
    'vite.config.*': 'vite.config.ts',
    'gulpfile.*': 'gulpfile.js',
    'Gruntfile.*': 'Gruntfile.js',
    '*.min.*': 'dist/app.min.js',
    '*.bundle.*': 'out/main.bundle.js',
    'node_modules': 'node_modules/lib/index.js',
    'vendor': 'vendor/lib.js',
    'scripts/one-shot': 'scripts/one-shot/x.js',
  };
  for (const [name, p] of Object.entries(examples)) {
    assert.equal(matchExclusion(p), name, p);
  }
  assert.deepEqual(
    PERFORMANCE_REVIEW_EXCLUDE_PATTERNS.map((x) => x.name).sort(),
    Object.keys(examples).sort(),
  );
});

test('matchExclusion: bin/, dist/, build/ and Makefile are not excluded on their own', () => {
  for (const p of ['bin/', 'dist/', 'build/', 'Makefile', 'bin/tool', 'dist/index.js', 'build/out.js']) {
    assert.equal(matchExclusion(p), null, p);
  }
});

test('matchExclusion: normalizes backslashes and leading ./', () => {
  assert.equal(matchExclusion('.\\scripts\\one-shot\\x.js'), 'scripts/one-shot');
  assert.equal(matchExclusion('./webpack.config.js'), 'webpack.config.*');
});
