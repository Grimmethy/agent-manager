'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { restartActions } = require('./live-checkout-restart-rule');

test('src-only sets units and pipeline', () => {
  const r = restartActions(['src/a.js', 'src/lib/b.js']);
  assert.equal(r.units, true);
  assert.equal(r.pipeline, true);
  assert.deepEqual(r.matched.units, ['src/a.js', 'src/lib/b.js']);
  assert.deepEqual(r.matched.pipeline, ['src/a.js', 'src/lib/b.js']);
});

test('scripts-only sets pipeline only', () => {
  const r = restartActions(['scripts/run.sh']);
  assert.equal(r.units, false);
  assert.equal(r.pipeline, true);
  assert.deepEqual(r.matched.units, []);
  assert.deepEqual(r.matched.pipeline, ['scripts/run.sh']);
});

test('python/dashboard-only sets nothing', () => {
  const r = restartActions(['python/dashboard/app.py', 'python/dashboard/templates/i.html']);
  assert.equal(r.units, false);
  assert.equal(r.pipeline, false);
  assert.deepEqual(r.matched, { units: [], pipeline: [] });
});

test('python/ outside dashboard sets pipeline', () => {
  const r = restartActions(['python/lib/x.py']);
  assert.equal(r.units, false);
  assert.equal(r.pipeline, true);
  assert.deepEqual(r.matched.pipeline, ['python/lib/x.py']);
});

test('docs-only sets nothing', () => {
  const r = restartActions(['docs/a.md', 'Docs/b.txt', 'README.md']);
  assert.equal(r.units, false);
  assert.equal(r.pipeline, false);
  assert.deepEqual(r.matched, { units: [], pipeline: [] });
});

test('mixed diff names exactly the paths that caused each action', () => {
  const r = restartActions(['docs/a.md', 'src/x.js', 'python/dashboard/app.py', 'scripts/s.sh', 'python/lib/y.py', 'README.md']);
  assert.equal(r.units, true);
  assert.equal(r.pipeline, true);
  assert.deepEqual(r.matched.units, ['src/x.js']);
  assert.deepEqual(r.matched.pipeline, ['src/x.js', 'scripts/s.sh', 'python/lib/y.py']);
});

test('empty list sets nothing', () => {
  assert.deepEqual(restartActions([]), { units: false, pipeline: false, matched: { units: [], pipeline: [] } });
});

test('scripts/x.md matches the scripts rule and sets pipeline', () => {
  const r = restartActions(['scripts/x.md']);
  assert.equal(r.units, false);
  assert.equal(r.pipeline, true);
  assert.deepEqual(r.matched.pipeline, ['scripts/x.md']);
});

test('duplicate input paths are reported once', () => {
  const r = restartActions(['src/a.js', 'src/a.js']);
  assert.deepEqual(r.matched.units, ['src/a.js']);
});
