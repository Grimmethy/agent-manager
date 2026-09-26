'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  wireDecomposedBlueprints, importPathFor, buildBlock, spliceBlock, MARKER,
} = require('./wire-decomposed-blueprints.js');

const APP_WITH_GUARD = [
  'from flask import Flask',
  'app = Flask(__name__)',
  '',
  'def _is_loopback_host(host):',
  '    return host == "127.0.0.1"',
  '',
  'if __name__ == "__main__":',
  '    app.run(port=7420)',
  '',
].join('\n');

test('importPathFor: routes/x.py relative to the source dir -> routes.x', () => {
  assert.equal(importPathFor('python/dashboard/app.py', 'python/dashboard/routes/hardware.py'), 'routes.hardware');
  assert.equal(importPathFor('python/dashboard/app.py', 'python/dashboard/routes/admin/hw.py'), 'routes.admin.hw');
});

test('buildBlock: one contiguous marker + imports + register calls', () => {
  const block = buildBlock([
    { newFile: 'python/dashboard/routes/hardware.py', blueprint: 'hardware_bp' },
    { newFile: 'python/dashboard/routes/reports.py', blueprint: 'reports_bp' },
  ], 'python/dashboard/app.py');
  assert.match(block, /^# --- Decomposed route blueprints/);
  assert.match(block, /from routes\.hardware import hardware_bp {2}# noqa: E402/);
  assert.match(block, /from routes\.reports import reports_bp {2}# noqa: E402/);
  assert.match(block, /app\.register_blueprint\(hardware_bp\)/);
  assert.match(block, /app\.register_blueprint\(reports_bp\)/);
});

test('spliceBlock: inserts immediately before the __main__ guard', () => {
  const out = spliceBlock(APP_WITH_GUARD, 'BLOCK\n');
  assert.match(out, /return host == "127.0.0.1"\n\nBLOCK\nif __name__ == "__main__":/);
});

test('spliceBlock: appends at EOF when there is no __main__ guard', () => {
  const out = spliceBlock('a = 1\n', 'BLOCK\n');
  assert.equal(out, 'a = 1\n\nBLOCK\n');
});

test('spliceBlock: returns null when the marker is already present (idempotent)', () => {
  assert.equal(spliceBlock(`x=1\n${MARKER}\n`, 'BLOCK\n'), null);
});

// --- integration with a fake git exec -------------------------------------------------

function fakeGit(worktreeSeed) {
  const calls = [];
  const exec = (file, args, opts) => {
    calls.push(args.join(' '));
    if (args[0] === 'worktree' && args[1] === 'add') {
      const wt = args[2];
      for (const [rel, content] of Object.entries(worktreeSeed)) {
        fs.mkdirSync(path.join(wt, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(wt, rel), content);
      }
      return '';
    }
    if (args[0] === 'rev-parse') return 'abc1234567890def\n';
    return '';
  };
  return { exec, calls };
}

const MOVES = [
  { newFile: 'python/dashboard/routes/hardware.py', blueprint: 'hardware_bp', kind: 'flask-blueprint' },
  { newFile: 'python/dashboard/routes/reports.py', blueprint: 'reports_bp', kind: 'flask-blueprint' },
];

test('wireDecomposedBlueprints: splices, commits and pushes; reports the sha', () => {
  const { exec, calls } = fakeGit({
    'python/dashboard/app.py': APP_WITH_GUARD,
    'python/dashboard/routes/__init__.py': '',
  });
  let committed = '';
  const wrapExec = (f, a, o) => {
    if (a[0] === 'commit') {
      // capture the source file as it stands at commit time
      const wt = calls.find((c) => c.startsWith('worktree add')).split(' ')[2];
      committed = fs.readFileSync(path.join(wt, 'python/dashboard/app.py'), 'utf8');
    }
    return exec(f, a, o);
  };
  const res = wireDecomposedBlueprints({
    repoRoot: '/repo', branch: 'agent/decompose-x', sourceFile: 'python/dashboard/app.py',
    moves: MOVES, exec: wrapExec,
  });
  assert.equal(res.ok, true);
  assert.equal(res.registered, 2);
  assert.equal(res.sha, 'abc1234567890def');
  assert.match(committed, new RegExp(`${MARKER.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}[\\s\\S]*app\\.register_blueprint\\(reports_bp\\)\\n\\n\\nif __name__`));
  assert.ok(calls.some((c) => c === 'push origin agent/decompose-x'));
  assert.ok(calls.some((c) => c.startsWith('worktree remove --force')));
});

test('wireDecomposedBlueprints: idempotent -- a second run is a skipped no-op, no commit', () => {
  const wired = spliceBlock(APP_WITH_GUARD, buildBlock(MOVES, 'python/dashboard/app.py'));
  const { exec, calls } = fakeGit({
    'python/dashboard/app.py': wired,
    'python/dashboard/routes/__init__.py': '',
  });
  const res = wireDecomposedBlueprints({
    repoRoot: '/repo', branch: 'agent/decompose-x', sourceFile: 'python/dashboard/app.py',
    moves: MOVES, exec,
  });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
  assert.equal(res.registered, 0);
  assert.ok(!calls.some((c) => c.startsWith('commit')));
});

test('wireDecomposedBlueprints: creates routes/__init__.py when missing and stages it', () => {
  const { exec, calls } = fakeGit({ 'python/dashboard/app.py': APP_WITH_GUARD });
  const res = wireDecomposedBlueprints({
    repoRoot: '/repo', branch: 'agent/decompose-x', sourceFile: 'python/dashboard/app.py',
    moves: [MOVES[0]], exec,
  });
  assert.equal(res.ok, true);
  const addCall = calls.find((c) => c.startsWith('add -- '));
  assert.match(addCall, /routes\/__init__\.py/);
});

test('wireDecomposedBlueprints: a git failure is returned as { ok:false }, never thrown', () => {
  const exec = (file, args) => {
    if (args[0] === 'worktree' && args[1] === 'add') throw new Error('fatal: invalid reference');
    return '';
  };
  const res = wireDecomposedBlueprints({
    repoRoot: '/repo', branch: 'agent/decompose-x', sourceFile: 'python/dashboard/app.py',
    moves: MOVES, exec,
  });
  assert.equal(res.ok, false);
  assert.match(res.detail, /invalid reference/);
});

test('wireDecomposedBlueprints: no flask-blueprint moves -> skipped, no worktree', () => {
  let called = false;
  const res = wireDecomposedBlueprints({
    repoRoot: '/repo', branch: 'agent/decompose-x', sourceFile: 'x.html',
    moves: [{ newFile: 'a.js', kind: 'script-extract' }], exec: () => { called = true; return ''; },
  });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
  assert.equal(called, false);
});
