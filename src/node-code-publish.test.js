'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildBundle } = require('./node-code-publish');

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER = 'ffffffffffffffffffffffffffffffffffffffff';

function cmdOf(args) {
  return args[0] === 'bundle' ? `bundle ${args[1]}` : args[0];
}

function setup(t, { failVerify = false, lsSha = SHA } = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncp-test-out-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const calls = [];
  const state = { scratch: null };
  t.after(() => { if (state.scratch) fs.rmSync(state.scratch, { recursive: true, force: true }); });
  const run = (args, cwd) => {
    calls.push({ args, cwd });
    const cmd = cmdOf(args);
    if (cmd === 'rev-parse') return SHA + '\n';
    if (cmd === 'init') { state.scratch = args[args.length - 1]; return ''; }
    if (cmd === 'bundle create') { fs.writeFileSync(args[2], 'data'); return ''; }
    if (cmd === 'bundle verify') { if (failVerify) throw new Error('verify failed'); return ''; }
    if (cmd === 'ls-remote') return `${lsSha}\t${args[2]}\n`;
    return '';
  };
  return { outDir, calls, state, run, repoDir: '/some/live/copy' };
}

test('happy path builds and publishes the bundle', (t) => {
  const s = setup(t);
  const res = buildBundle({ repoDir: s.repoDir, outDir: s.outDir, run: s.run });
  assert.deepEqual(res, { sha: SHA, bundle: `agent-manager-${SHA.slice(0, 8)}.bundle`, branch: 'master' });
  assert.deepEqual(fs.readdirSync(s.outDir), [res.bundle]);
  assert.equal(fs.existsSync(s.state.scratch), false);
  assert.deepEqual(s.calls.map((c) => cmdOf(c.args)),
    ['rev-parse', 'init', 'fetch', 'bundle create', 'bundle verify', 'ls-remote']);
  const fetch = s.calls.find((c) => c.args[0] === 'fetch');
  assert.ok(fetch.args.includes('refs/remotes/origin/master:refs/heads/master'));
  assert.ok(fetch.args.includes(s.repoDir));
  assert.equal(fetch.cwd, s.state.scratch);
  const onLive = s.calls.filter((c) => c.cwd === s.repoDir);
  assert.equal(onLive.length, 1);
  assert.deepEqual(onLive[0].args, ['rev-parse', '--verify', 'refs/remotes/origin/master']);
});

test('custom repo and branch are used in names and refspec', (t) => {
  const s = setup(t);
  const res = buildBundle({ repoDir: s.repoDir, outDir: s.outDir, run: s.run, repo: 'x', branch: 'main' });
  assert.equal(res.bundle, `x-${SHA.slice(0, 8)}.bundle`);
  assert.equal(res.branch, 'main');
  assert.ok(s.calls.find((c) => c.args[0] === 'fetch').args.includes('refs/remotes/origin/main:refs/heads/main'));
});

test('failed verify throws and leaves no bundle', (t) => {
  const s = setup(t, { failVerify: true });
  assert.throws(() => buildBundle({ repoDir: s.repoDir, outDir: s.outDir, run: s.run }), /verify failed/);
  assert.deepEqual(fs.readdirSync(s.outDir), []);
});

test('ls-remote mismatch refuses and leaves no bundle', (t) => {
  const s = setup(t, { lsSha: OTHER });
  assert.throws(() => buildBundle({ repoDir: s.repoDir, outDir: s.outDir, run: s.run }), /refusing/);
  assert.deepEqual(fs.readdirSync(s.outDir), []);
});

test('scratch dir is removed on failure', (t) => {
  const s = setup(t, { failVerify: true });
  assert.throws(() => buildBundle({ repoDir: s.repoDir, outDir: s.outDir, run: s.run }));
  assert.ok(s.state.scratch);
  assert.equal(fs.existsSync(s.state.scratch), false);
});

test('source avoids history-changing git verbs, the force flag and timers', () => {
  const src = fs.readFileSync(path.join(__dirname, 'node-code-publish.js'), 'utf8');
  const banned = [/\breset\b/, /\bcheckout\b/, /\bstash\b/, /\bmerge\b/, /\bpush\b/, /--force/, /\s-f\b/, new RegExp('set' + 'Interval'), new RegExp('set' + 'Timeout')];
  for (const re of banned) {
    assert.equal(re.test(src), false, `source matches ${re}`);
  }
});
