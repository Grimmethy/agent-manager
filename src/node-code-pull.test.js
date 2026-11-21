'use strict';

const test = require('node:test');
const assert = require('node:assert');

// pullCode destructures applyCode and planRestart when its module loads, so
// stubs replace those two dependency modules in require.cache first, then the
// cache entries are removed again. Every run, fs and now value is an injected
// fake, so nothing outside this file is touched.
const applyPath = require.resolve('./node-code-apply.js');
const restartPath = require.resolve('./node-code-restart.js');

const counts = { apply: 0, plan: 0, run: 0 };
let applyResult = null;

require.cache[applyPath] = {
  id: applyPath, filename: applyPath, loaded: true,
  exports: { applyCode: () => { counts.apply += 1; return applyResult; } },
};
require.cache[restartPath] = {
  id: restartPath, filename: restartPath, loaded: true,
  exports: { planRestart: () => { counts.plan += 1; return null; } },
};

const { pullCode } = require('./node-code-pull.js');

delete require.cache[applyPath];
delete require.cache[restartPath];

const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);

function reset() { counts.apply = 0; counts.plan = 0; counts.run = 0; }

function fakeRun() { counts.run += 1; return OLD_SHA + '\n'; }

function fakeFs() {
  const refuse = () => { throw new Error('fake fs must not be used: planRestart is stubbed'); };
  return { readFileSync: refuse, writeFileSync: refuse, renameSync: refuse, mkdirSync: refuse, appendFileSync: refuse };
}

function fakeNow() { return Date.parse('2026-11-17T00:00:00Z'); }

function deps(mode) {
  return { env: { AGENT_MANAGER_CODE_PULL: mode }, run: fakeRun, fs: fakeFs(), now: fakeNow, pipelineDir: '/fake/pipeline' };
}

test('applied true in on mode calls planRestart exactly once', () => {
  reset();
  applyResult = { applied: true, sha: NEW_SHA };
  const result = pullCode('/fake/in', '/fake/repo', deps('on'));
  assert.strictEqual(counts.apply, 1);
  assert.strictEqual(counts.plan, 1);
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.planned, true);
});

test('applied false calls planRestart zero times', () => {
  reset();
  applyResult = { applied: false, reason: 'current', sha: OLD_SHA };
  const result = pullCode('/fake/in', '/fake/repo', deps('on'));
  assert.strictEqual(counts.apply, 1);
  assert.strictEqual(counts.plan, 0);
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.planned, false);
});

test('mode off calls neither applyCode nor planRestart', () => {
  reset();
  applyResult = { applied: true, sha: NEW_SHA };
  const result = pullCode('/fake/in', '/fake/repo', deps('off'));
  assert.strictEqual(counts.apply, 0);
  assert.strictEqual(counts.plan, 0);
  assert.strictEqual(counts.run, 0);
  assert.deepStrictEqual(result, { mode: 'off', applied: false });
});
