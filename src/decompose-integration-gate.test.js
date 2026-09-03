'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runIntegrationGate, diffRouteTables } = require('./decompose-integration-gate.js');

test('diffRouteTables: identical rule set passes even when endpoint modules differ', () => {
  const main = JSON.stringify([
    '/api/hardware/stats GET -> api_hardware_stats',
    '/api/reports GET -> api_reports',
  ]);
  const branch = JSON.stringify([
    '/api/hardware/stats GET -> hardware.api_hardware_stats', // re-homed
    '/api/reports GET -> reports.api_reports',
  ]);
  const r = diffRouteTables(main, branch);
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
});

test('diffRouteTables: a dropped route fails', () => {
  const main = JSON.stringify(['/a GET -> x', '/b GET -> y']);
  const branch = JSON.stringify(['/a GET -> x']);
  const r = diffRouteTables(main, branch);
  assert.equal(r.ok, false);
  assert.deepEqual(r.droppedRules, ['/b GET']);
});

test('diffRouteTables: a changed method set fails', () => {
  const main = JSON.stringify(['/a GET -> x']);
  const branch = JSON.stringify(['/a GET,POST -> x']);
  assert.equal(diffRouteTables(main, branch).ok, false);
});

function fakeExec(handlers) {
  const calls = [];
  return {
    calls,
    exec: (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      for (const [pattern, resp] of handlers) {
        if (`${file} ${args.join(' ')}`.includes(pattern)) {
          if (resp instanceof Error) throw resp;
          return resp;
        }
      }
      return '';
    },
  };
}

test('non-Python source: gate skips with a clear reason, never fails', () => {
  const f = fakeExec([['worktree add', '']]);
  const res = runIntegrationGate({
    repoRoot: '/repo', branch: 'agent/decompose-x', mainBranch: 'master',
    sourceFile: 'templates/index.html', exec: f.exec,
  });
  assert.equal(res.ok, true);
  assert.equal(res.checks.find((c) => c.name === 'language').status, 'skip');
});

test('import failure (the circular import) fails the gate', () => {
  const err = new Error('cmd failed');
  err.stderr = 'ImportError: cannot import name second_brain_dir from partially initialized module app (most likely due to a circular import)';
  const f = fakeExec([
    ['worktree add', ''],
    ['git diff --name-only', 'python/dashboard/app.py\npython/dashboard/routes/reports.py'],
    ['python3 -c import app', err],
  ]);
  const res = runIntegrationGate({
    repoRoot: '/repo', branch: 'agent/decompose-reports', mainBranch: 'master',
    sourceFile: 'python/dashboard/app.py', exec: f.exec,
  });
  assert.equal(res.ok, false);
  const imp = res.checks.find((c) => c.name === 'import');
  assert.equal(imp.status, 'fail');
  assert.match(imp.detail, /circular import/);
});

test('missing app dependencies -> import check skips, gate does not fail', () => {
  const err = new Error('cmd failed');
  err.stderr = "ModuleNotFoundError: No module named 'flask'";
  const f = fakeExec([
    ['worktree add', ''],
    ['git diff --name-only', ''],
    ['python3 -c import app', err],
  ]);
  const res = runIntegrationGate({
    repoRoot: '/repo', branch: 'agent/decompose-x', mainBranch: 'master',
    sourceFile: 'python/dashboard/app.py', exec: f.exec,
  });
  assert.equal(res.ok, true);
  assert.equal(res.checks.find((c) => c.name === 'import').status, 'skip');
});

test('worktree creation failure -> errored (caller retries), not a hard fail verdict', () => {
  const f = fakeExec([['worktree add', new Error('fatal: invalid reference')]]);
  const res = runIntegrationGate({
    repoRoot: '/repo', branch: 'agent/decompose-x', mainBranch: 'master',
    sourceFile: 'python/dashboard/app.py', exec: f.exec,
  });
  assert.equal(res.ok, false);
  assert.equal(res.errored, true);
});
