'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkBundle, CHECKED_FILES } = require('./node-code-gate.js');

const SHA = 'a'.repeat(40);
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });

// A fake world: records every call, a set of files "in the clone", and the files whose check fails.
function world({ headSha = SHA, cloneStatus = 0, missing = [], bad = {} } = {}) {
  const w = { calls: [], made: [], removed: [] };
  w.fs = {
    mkdtempSync: (prefix) => { const d = `${prefix}1`; w.made.push(d); return d; },
    existsSync: (p) => !missing.some((m) => p.endsWith(m)),
    rmSync: (d, opts) => { w.removed.push([d, opts]); },
  };
  w.run = (cmd, args) => {
    w.calls.push([cmd, ...args]);
    if (cmd === 'git' && args[0] === 'clone') return { status: cloneStatus, stdout: '', stderr: cloneStatus ? 'bad bundle' : '' };
    if (cmd === 'git' && args.includes('rev-parse')) return ok(`${headSha}\n`);
    const file = CHECKED_FILES.find((f) => args[1].endsWith(f));
    return bad[file] ? { status: 1, stdout: '', stderr: bad[file] } : ok();
  };
  return w;
}
const input = (w, extra = {}) => ({ bundlePath: '/pub/x.bundle', branch: 'master', sha: SHA, run: w.run, fs: w.fs, tmpRoot: '/scratch', ...extra });

test('all three files parse: ok, the clone names the branch, and the scratch directory is removed', () => {
  const w = world();
  assert.deepEqual(checkBundle(input(w)), { ok: true });
  assert.deepEqual(w.calls[0], ['git', 'clone', '--quiet', '--branch', 'master', '/pub/x.bundle', '/scratch/node-code-gate-1']);
  const checks = w.calls.filter((c) => c[1] === '--check').map((c) => c[2]);
  assert.deepEqual(checks, CHECKED_FILES.map((f) => `/scratch/node-code-gate-1/${f}`));
  assert.deepEqual(w.removed, [['/scratch/node-code-gate-1', { recursive: true, force: true }]]);
});

test('a syntax error names that file and carries the message, later files are not checked, the directory is removed', () => {
  const w = world({ bad: { 'src/node-code-apply.js': 'SyntaxError: Unexpected token' } });
  const r = checkBundle(input(w));
  assert.deepEqual(r, { ok: false, file: 'src/node-code-apply.js', error: 'SyntaxError: Unexpected token' });
  assert.equal(w.calls.filter((c) => c[1] === '--check').length, 2);
  assert.equal(w.removed.length, 1);
});

test('a missing file fails and names the file', () => {
  const w = world({ missing: ['src/node-code-pull.js'] });
  const r = checkBundle(input(w));
  assert.equal(r.ok, false);
  assert.equal(r.file, 'src/node-code-pull.js');
  assert.match(r.error, /missing/);
  assert.equal(w.removed.length, 1);
});

test('a HEAD that is not the published sha fails before any file is checked', () => {
  const w = world({ headSha: 'b'.repeat(40) });
  const r = checkBundle(input(w));
  assert.equal(r.ok, false);
  assert.equal(r.file, null);
  assert.match(r.error, /bbbbbbbb.*not the published sha/);
  assert.equal(w.calls.filter((c) => c[1] === '--check').length, 0);
  assert.equal(w.removed.length, 1);
});

test('a failed clone fails with its message and still removes the directory', () => {
  const w = world({ cloneStatus: 128 });
  const r = checkBundle(input(w));
  assert.equal(r.ok, false);
  assert.match(r.error, /clone failed: bad bundle/);
  assert.equal(w.removed.length, 1);
});

test('a runner that throws is a failure, not an exception, and the directory is removed', () => {
  const w = world();
  w.run = () => { throw new Error('boom'); };
  const r = checkBundle(input(w));
  assert.deepEqual(r, { ok: false, file: null, error: 'boom' });
  assert.equal(w.removed.length, 1);
});

test('bad input fails without creating a directory: no bundle path, a branch that looks like an option, a short sha', () => {
  const w = world();
  assert.equal(checkBundle(input(w, { bundlePath: '' })).ok, false);
  assert.equal(checkBundle(input(w, { branch: '--upload-pack=x' })).ok, false);
  assert.equal(checkBundle(input(w, { sha: 'abc' })).ok, false);
  assert.equal(checkBundle(input(w, { sha: SHA.toUpperCase() })).ok, false);
  assert.equal(checkBundle().ok, false);
  assert.equal(w.made.length, 0);
});

test('a long error message is cut to 500 characters', () => {
  const w = world({ bad: { 'src/node-heartbeat.js': 'x'.repeat(2000) } });
  assert.equal(checkBundle(input(w)).error.length, 500);
});

test('with the real git and node: a good bundle passes, a broken file fails, and no scratch directory is left behind', () => {
  const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'gate-real-'));
  const git = (...a) => spawnSync('git', ['-C', path.join(root, 'src-repo'), ...a], { encoding: 'utf8' });
  nodeFs.mkdirSync(path.join(root, 'src-repo', 'src'), { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'master', path.join(root, 'src-repo')]);
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const write = (body) => CHECKED_FILES.forEach((f, i) => nodeFs.writeFileSync(path.join(root, 'src-repo', f), i === 1 ? body : "'use strict';\n"));
  const bundle = (name) => {
    git('add', '-A'); git('commit', '-q', '-m', name);
    const sha = git('rev-parse', 'HEAD').stdout.trim();
    git('bundle', 'create', path.join(root, `${name}.bundle`), 'master');
    return sha;
  };
  write("'use strict';\nmodule.exports = 1;\n");
  const good = bundle('good');
  write("'use strict';\nmodule.exports = = 1;\n");
  const broken = bundle('broken');
  const tmpRoot = path.join(root, 'tmp');
  nodeFs.mkdirSync(tmpRoot);
  assert.deepEqual(checkBundle({ bundlePath: path.join(root, 'good.bundle'), branch: 'master', sha: good, tmpRoot }), { ok: true });
  assert.equal(checkBundle({ bundlePath: path.join(root, 'good.bundle'), branch: 'master', sha: broken, tmpRoot }).ok, false);
  const r = checkBundle({ bundlePath: path.join(root, 'broken.bundle'), branch: 'master', sha: broken, tmpRoot });
  assert.equal(r.ok, false);
  assert.equal(r.file, 'src/node-code-apply.js');
  assert.match(r.error, /SyntaxError/);
  assert.deepEqual(nodeFs.readdirSync(tmpRoot), []);
  nodeFs.rmSync(root, { recursive: true, force: true });
});
