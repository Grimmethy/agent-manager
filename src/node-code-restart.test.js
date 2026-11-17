'use strict';

// Tests for src/node-code-restart.js: an injected runner and an in-memory fs for every branch, plus one run on a real temp repo.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { planRestart, PENDING_FILE, AUDIT_FILE } = require('./node-code-restart.js');

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const NEWER = 'c'.repeat(40);
const T1 = Date.parse('2026-11-16T10:00:00.000Z');
const T2 = Date.parse('2026-11-16T11:00:00.000Z');
const PIPE = '/pipe';
const PENDING = path.join(PIPE, 'instances', PENDING_FILE);
const AUDIT = path.join(PIPE, 'instances', AUDIT_FILE);

// In-memory fs with the five calls planRestart uses; files maps a path to its text.
function memFs(files = {}) {
  return {
    files,
    mkdirSync() {},
    readFileSync(p) { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    writeFileSync(p, data) { files[p] = String(data); },
    renameSync(from, to) { files[to] = files[from]; delete files[from]; },
    appendFileSync(p, data) { files[p] = (files[p] || '') + String(data); },
  };
}

function runWith(paths) {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, args]); return `${paths.join('\n')}\n`; };
  run.calls = calls;
  return run;
}

function plan(paths, extra = {}) {
  const fs = extra.fs || memFs();
  const run = runWith(paths);
  const result = planRestart({ repoDir: '/repo', oldSha: OLD, newSha: NEW, pipelineDir: PIPE, mode: 'on', run, fs, now: () => T1, ...extra, fs });
  return { result, fs, run };
}

test('a src change sets units and pipeline and writes the pending record', () => {
  const { result, fs, run } = plan(['src/a.js', 'docs/x.md']);
  assert.deepEqual(run.calls[0], ['git', ['-C', '/repo', 'diff', '--name-only', `${OLD}..${NEW}`]]);
  assert.deepEqual(result, {
    oldSha: OLD, newSha: NEW, units: true, pipeline: true,
    matched: { units: ['src/a.js'], pipeline: ['src/a.js'] }, since: '2026-11-16T10:00:00.000Z', alerted: false,
  });
  assert.deepEqual(JSON.parse(fs.files[PENDING]), result);
  assert.match(fs.files[AUDIT], /"decision":"restart units=true pipeline=true"/);
});

test('a scripts change sets the pipeline only', () => {
  const { result } = plan(['scripts/launch.sh']);
  assert.equal(result.units, false);
  assert.equal(result.pipeline, true);
  assert.deepEqual(result.matched, { units: [], pipeline: ['scripts/launch.sh'] });
});

test('docs only gives null and writes no record', () => {
  const { result, fs } = plan(['docs/a.md', 'README.md', 'Docs/b.md']);
  assert.equal(result, null);
  assert.equal(PENDING in fs.files, false);
});

test('python/dashboard only gives null and writes no record', () => {
  const { result, fs } = plan(['python/dashboard/app.py']);
  assert.equal(result, null);
  assert.equal(PENDING in fs.files, false);
});

test('dry-run writes no record, only an audit line with the shas, paths and decision', () => {
  const { result, fs } = plan(['src/a.js'], { mode: 'dry-run' });
  assert.equal(result, null);
  assert.equal(PENDING in fs.files, false);
  const line = JSON.parse(fs.files[AUDIT].trim());
  assert.equal(line.oldSha, OLD);
  assert.equal(line.newSha, NEW);
  assert.deepEqual(line.matched, ['src/a.js']);
  assert.match(line.decision, /would restart units=true pipeline=true/);
  assert.equal(line.mode, 'dry-run');
});

test('mode off does nothing: no git call, no record, no audit', () => {
  const { result, fs, run } = plan(['src/a.js'], { mode: 'off' });
  assert.equal(result, null);
  assert.equal(run.calls.length, 0);
  assert.deepEqual(fs.files, {});
});

test('a second call keeps since, alerted and the first oldSha, takes the new newSha and never loses an action', () => {
  const fs = memFs();
  plan(['src/a.js'], { fs });
  const first = JSON.parse(fs.files[PENDING]);
  fs.files[PENDING] = JSON.stringify({ ...first, alerted: true });
  const second = planRestart({ repoDir: '/repo', oldSha: NEW, newSha: NEWER, pipelineDir: PIPE, mode: 'on', run: runWith(['scripts/x.sh']), fs, now: () => T2 });
  assert.equal(second.since, '2026-11-16T10:00:00.000Z');
  assert.equal(second.alerted, true);
  assert.equal(second.oldSha, OLD);
  assert.equal(second.newSha, NEWER);
  assert.equal(second.units, true);
  assert.equal(second.pipeline, true);
  assert.deepEqual(second.matched, { units: ['src/a.js'], pipeline: ['src/a.js', 'scripts/x.sh'] });
});

test('a docs-only update while a record exists leaves the record as it is', () => {
  const fs = memFs();
  plan(['src/a.js'], { fs });
  const before = fs.files[PENDING];
  const result = planRestart({ repoDir: '/repo', oldSha: NEW, newSha: NEWER, pipelineDir: PIPE, mode: 'on', run: runWith(['docs/a.md']), fs, now: () => T2 });
  assert.equal(result, null);
  assert.equal(fs.files[PENDING], before);
});

test('a git failure is audited and returns null without throwing', () => {
  const fs = memFs();
  const run = () => { throw new Error('boom'); };
  const result = planRestart({ repoDir: '/repo', oldSha: OLD, newSha: NEW, pipelineDir: PIPE, mode: 'on', run, fs, now: () => T1 });
  assert.equal(result, null);
  assert.equal(PENDING in fs.files, false);
  assert.match(fs.files[AUDIT], /git diff failed: boom/);
});

test('a bad sha is audited, runs no git and returns null', () => {
  for (const [oldSha, newSha] of [['xyz', NEW], [OLD, 'B'.repeat(40)], [undefined, NEW]]) {
    const fs = memFs();
    const run = runWith(['src/a.js']);
    assert.equal(planRestart({ repoDir: '/repo', oldSha, newSha, pipelineDir: PIPE, mode: 'on', run, fs }), null);
    assert.equal(run.calls.length, 0);
    assert.match(fs.files[AUDIT], /sha must be 40 lowercase hex/);
  }
});

test('an unwritable record is audited and returns null', () => {
  const fs = memFs();
  fs.writeFileSync = () => { throw new Error('disk full'); };
  const result = planRestart({ repoDir: '/repo', oldSha: OLD, newSha: NEW, pipelineDir: PIPE, mode: 'on', run: runWith(['src/a.js']), fs, now: () => T1 });
  assert.equal(result, null);
  assert.match(fs.files[AUDIT], /record not written: disk full/);
});

test('a real temp repo: two commits, the diff drives the record', () => {
  const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'ncr-'));
  try {
    const repo = path.join(root, 'repo');
    nodeFs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const git = (...args) => childProcess.execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'master');
    nodeFs.writeFileSync(path.join(repo, 'README.md'), 'one');
    git('add', '.');
    git('commit', '-q', '-m', 'one');
    const first = git('rev-parse', 'HEAD');
    nodeFs.writeFileSync(path.join(repo, 'src', 'a.js'), 'x');
    git('add', '.');
    git('commit', '-q', '-m', 'two');
    const second = git('rev-parse', 'HEAD');
    const pipe = path.join(root, 'pipe');
    const result = planRestart({ repoDir: repo, oldSha: first, newSha: second, pipelineDir: pipe, mode: 'on' });
    assert.equal(result.units, true);
    assert.deepEqual(JSON.parse(nodeFs.readFileSync(path.join(pipe, 'instances', PENDING_FILE), 'utf8')).matched.units, ['src/a.js']);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});
