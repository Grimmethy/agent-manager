'use strict';

// Unit tests for sandbox.js -- bwrap-backed filesystem containment for adhoc-agentic-
// draft.js's real Bash-capable Claude CLI call. See that file's own header for the
// design rationale (single real backend, no vtable yet).
//
// Run: node --test src/sandbox.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { wrapWithSandbox, buildBwrapArgs, clearBwrapPathCache } = require('./sandbox.js');

function withPath(pathValue, fn) {
  const prior = process.env.PATH;
  process.env.PATH = pathValue;
  clearBwrapPathCache();
  try {
    return fn();
  } finally {
    process.env.PATH = prior;
    clearBwrapPathCache();
  }
}

test('buildBwrapArgs binds read-only paths before writable paths, in the given order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
  const ro = path.join(dir, 'ro');
  const rw = path.join(dir, 'rw');
  fs.mkdirSync(ro);
  fs.mkdirSync(rw);

  const args = buildBwrapArgs({ workDir: rw, readOnlyBinds: [ro], writableBinds: [rw] });

  const roIndex = args.indexOf('--ro-bind');
  const rwIndex = args.indexOf('--bind');
  assert.ok(roIndex !== -1 && rwIndex !== -1, 'both bind flags must be present');
  assert.ok(roIndex < rwIndex, 'read-only binds must be applied before writable binds');
  assert.deepEqual(args.slice(roIndex, roIndex + 3), ['--ro-bind', ro, ro]);
  assert.deepEqual(args.slice(rwIndex, rwIndex + 3), ['--bind', rw, rw]);
});

test('buildBwrapArgs silently skips a bind path that does not exist on disk', () => {
  const missing = '/this/path/definitely/does/not/exist/on/this/host';
  const args = buildBwrapArgs({ workDir: os.tmpdir(), readOnlyBinds: [missing], writableBinds: [] });
  assert.equal(args.includes(missing), false);
  assert.equal(args.includes('--ro-bind'), false);
});

test('buildBwrapArgs clears the environment before setting explicit env entries -- no inherited secrets', () => {
  const args = buildBwrapArgs({ workDir: os.tmpdir(), env: { FOO: 'bar' } });
  const clearIndex = args.indexOf('--clearenv');
  const fooIndex = args.indexOf('FOO');
  assert.ok(clearIndex !== -1, '--clearenv must be present');
  assert.ok(clearIndex < fooIndex, '--clearenv must come before the explicit --setenv entries');
  assert.deepEqual(args.slice(fooIndex - 1, fooIndex + 1), ['--setenv', 'FOO']);
  assert.equal(args[fooIndex + 1], 'bar');
});

test('buildBwrapArgs omits an env entry whose value is null/undefined', () => {
  const args = buildBwrapArgs({ workDir: os.tmpdir(), env: { FOO: null, BAR: undefined, BAZ: 'x' } });
  assert.equal(args.includes('FOO'), false);
  assert.equal(args.includes('BAR'), false);
  assert.ok(args.includes('BAZ'));
});

test('wrapWithSandbox reports available:false when bwrap is not on PATH', () => {
  withPath('/nonexistent-bin-dir-for-testing', () => {
    const result = wrapWithSandbox('echo', ['hi'], { workDir: os.tmpdir() });
    assert.deepEqual(result, { available: false });
  });
});

// The remaining tests need a real bwrap on this host -- skipped (not failed) elsewhere,
// same "environment-dependent, degrade gracefully" treatment other real-git/real-process
// tests in this codebase already use (see adhoc-agentic-draft.test.js's own real-git
// fixtures, which assume git is present the same unconditional way).
let hasBwrap = false;
try { execFileSync('which', ['bwrap'], { stdio: 'pipe' }); hasBwrap = true; } catch (e) { /* skip below */ }

test('wrapWithSandbox returns a real bwrap invocation that actually runs the wrapped command', { skip: !hasBwrap && 'bwrap not installed on this host' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-real-'));
  fs.writeFileSync(path.join(dir, 'visible.txt'), 'hello\n');

  const result = wrapWithSandbox('cat', [path.join(dir, 'visible.txt')], {
    workDir: dir,
    readOnlyBinds: ['/usr', '/bin', '/lib', '/lib64', dir],
  });

  assert.equal(result.available, true);
  assert.match(result.command, /bwrap/);
  const output = execFileSync(result.command, result.args, { encoding: 'utf8' });
  assert.equal(output, 'hello\n');
});

test('wrapWithSandbox actually contains the filesystem -- a real, unbound file is genuinely unreachable', { skip: !hasBwrap && 'bwrap not installed on this host' }, () => {
  const boundDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-bound-'));
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-secret-'));
  fs.writeFileSync(path.join(secretDir, 'credentials.json'), '{"token":"real-secret-value"}\n');

  const result = wrapWithSandbox('cat', [path.join(secretDir, 'credentials.json')], {
    workDir: boundDir,
    readOnlyBinds: ['/usr', '/bin', '/lib', '/lib64', boundDir],
  });

  assert.throws(() => execFileSync(result.command, result.args, { encoding: 'utf8', stdio: 'pipe' }));
});
