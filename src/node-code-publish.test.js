'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildBundle, publishCode, readPublished } = require('./node-code-publish');

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

function shaRun(s, sha) {
  return (args, cwd) => {
    if (cmdOf(args) === 'rev-parse') return sha + '\n';
    if (cmdOf(args) === 'ls-remote') return `${sha}\t${args[2]}\n`;
    return s.run(args, cwd);
  };
}

test('publishCode builds the bundle before writing latest.json', (t) => {
  const s = setup(t);
  let latestExistedAtBuild = null;
  const run = (args, cwd) => {
    if (cmdOf(args) === 'bundle verify') latestExistedAtBuild = fs.existsSync(path.join(s.outDir, 'latest.json'));
    return s.run(args, cwd);
  };
  const res = publishCode({ repoDir: s.repoDir, outDir: s.outDir, run });
  assert.equal(res.reason, 'published');
  assert.equal(latestExistedAtBuild, false);
  const list = JSON.parse(fs.readFileSync(path.join(s.outDir, 'latest.json'), 'utf8'));
  assert.deepEqual(list, [{ repo: 'agent-manager', sha: SHA, bundle: `agent-manager-${SHA.slice(0, 8)}.bundle`, branch: 'master' }]);
});

test('same sha with bundle present writes nothing', (t) => {
  const s = setup(t);
  publishCode({ repoDir: s.repoDir, outDir: s.outDir, run: s.run });
  const latest = path.join(s.outDir, 'latest.json');
  const bytes = fs.readFileSync(latest);
  const before = s.calls.length;
  const res = publishCode({ repoDir: s.repoDir, outDir: s.outDir, run: s.run });
  assert.equal(res.reason, 'current');
  assert.deepEqual(s.calls.slice(before).map((c) => cmdOf(c.args)), ['rev-parse']);
  assert.deepEqual(fs.readFileSync(latest), bytes);
});

test('same sha with bundle missing rebuilds', (t) => {
  const s = setup(t);
  const first = publishCode({ repoDir: s.repoDir, outDir: s.outDir, run: s.run });
  fs.rmSync(path.join(s.outDir, first.bundle));
  const res = publishCode({ repoDir: s.repoDir, outDir: s.outDir, run: s.run });
  assert.equal(res.reason, 'published');
  assert.ok(fs.existsSync(path.join(s.outDir, first.bundle)));
});

test('two repos keep both entries', (t) => {
  const s = setup(t);
  publishCode({ repoDir: s.repoDir, outDir: s.outDir, run: s.run });
  publishCode({ repoDir: s.repoDir, outDir: s.outDir, run: s.run, repo: 'x', branch: 'main' });
  const list = JSON.parse(fs.readFileSync(path.join(s.outDir, 'latest.json'), 'utf8'));
  assert.deepEqual(list.map((e) => e.repo).sort(), ['agent-manager', 'x']);
  assert.equal(readPublished(s.outDir, 'agent-manager').sha, SHA);
  assert.equal(readPublished(s.outDir, 'x').branch, 'main');
});

test('pruning keeps the 3 newest bundles for this repo only', (t) => {
  const s = setup(t);
  const sha = (i) => String(i).repeat(40);
  publishCode({ repoDir: s.repoDir, outDir: s.outDir, run: shaRun(s, sha(9)), repo: 'x', branch: 'main' });
  for (let i = 1; i <= 4; i++) {
    const res = publishCode({ repoDir: s.repoDir, outDir: s.outDir, run: shaRun(s, sha(i)) });
    const when = 1000000 + i * 1000;
    fs.utimesSync(path.join(s.outDir, res.bundle), when, when);
  }
  const bundles = fs.readdirSync(s.outDir).filter((n) => n.startsWith('agent-manager-')).sort();
  assert.equal(bundles.length, 3);
  assert.ok(bundles.includes(`agent-manager-${'4'.repeat(8)}.bundle`));
  assert.ok(!bundles.includes(`agent-manager-${'1'.repeat(8)}.bundle`));
  assert.ok(fs.existsSync(path.join(s.outDir, `x-${'9'.repeat(8)}.bundle`)));
});

test('a failed build leaves the old latest.json byte-identical', (t) => {
  const s = setup(t);
  publishCode({ repoDir: s.repoDir, outDir: s.outDir, run: s.run });
  const latest = path.join(s.outDir, 'latest.json');
  const bytes = fs.readFileSync(latest);
  const failing = (args, cwd) => {
    if (cmdOf(args) === 'rev-parse') return OTHER + '\n';
    if (cmdOf(args) === 'bundle verify') throw new Error('verify failed');
    return s.run(args, cwd);
  };
  assert.throws(() => publishCode({ repoDir: s.repoDir, outDir: s.outDir, run: failing }), /verify failed/);
  assert.deepEqual(fs.readFileSync(latest), bytes);
});

test('readPublished on a missing or unparsable file is null', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncp-test-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(readPublished(dir, 'agent-manager'), null);
  fs.writeFileSync(path.join(dir, 'latest.json'), '{not json');
  assert.equal(readPublished(dir, 'agent-manager'), null);
});

test('source avoids history-changing git verbs, the force flag and timers', () => {
  const src = fs.readFileSync(path.join(__dirname, 'node-code-publish.js'), 'utf8');
  const banned = [/\breset\b/, /\bcheckout\b/, /\bstash\b/, /\bmerge\b/, /\bpush\b/, /--force/, /\s-f\b/, new RegExp('set' + 'Interval'), new RegExp('set' + 'Timeout')];
  for (const re of banned) {
    assert.equal(re.test(src), false, `source matches ${re}`);
  }
});
