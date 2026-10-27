'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { isGeneratedPath, classifyStatus, healGeneratedDirt, healMode } = require('./apply-clone-dirt.js');
const { createRealGitRunner } = require('../git-runner.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A real repo that TRACKS a .pyc, like TaxHarvest does.
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-dirt-'));
  const bare = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  git(root, 'init', '--bare', '-b', 'main', bare);
  git(root, 'clone', '-q', bare, repo);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  fs.mkdirSync(path.join(repo, 'py', '__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'py', '__pycache__', 'a.cpython-312.pyc'), 'v1');
  fs.writeFileSync(path.join(repo, 'py', '__pycache__', 'b.cpython-312.pyc'), 'v1');
  fs.writeFileSync(path.join(repo, 'src.js'), 'one\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init'); git(repo, 'push', '-q', 'origin', 'main');
  const run = (args) => git(repo, ...args);
  return { repo, run };
}
const pyc = (repo, n = 'a') => path.join(repo, 'py', '__pycache__', `${n}.cpython-312.pyc`);

test('isGeneratedPath: __pycache__ dirs and .pyc/.pyo only', () => {
  for (const p of ['py/__pycache__/a.cpython-312.pyc', '__pycache__/x.py', 'a/b.pyc', 'a/b.pyo']) assert.equal(isGeneratedPath(p), true, p);
  for (const p of ['src/app.py', 'Docs/X_CANDIDATES.md', 'pycache/a.txt', 'a/b.pycx']) assert.equal(isGeneratedPath(p), false, p);
});

test('classifyStatus: unstaged generated changes are generated; staged, other files and renames stay "other"', () => {
  const out = [' M py/__pycache__/a.cpython-312.pyc', ' D py/__pycache__/b.cpython-312.pyc', 'M  py/__pycache__/c.pyc', ' M src.js', 'R  old.pyc -> new.pyc'].join('\n');
  const c = classifyStatus(out);
  assert.deepEqual(c.generated, ['py/__pycache__/a.cpython-312.pyc', 'py/__pycache__/b.cpython-312.pyc']);
  assert.equal(c.other.length, 3);
});

test('on: restores modified and deleted tracked .pyc files and nothing else', () => {
  const { repo, run } = makeRepo();
  fs.writeFileSync(pyc(repo, 'a'), 'v2');
  fs.rmSync(pyc(repo, 'b'));
  const r = healGeneratedDirt(run, { mode: 'on' });
  assert.equal(r.restored.length, 2); assert.deepEqual(r.other, []);
  assert.equal(fs.readFileSync(pyc(repo, 'a'), 'utf8'), 'v1');
  assert.equal(fs.existsSync(pyc(repo, 'b')), true);
  assert.equal(run(['status', '--porcelain', '--untracked-files=no']).trim(), '');
});

test('on: a modified source file is never touched and is reported in other', () => {
  const { repo, run } = makeRepo();
  fs.writeFileSync(pyc(repo, 'a'), 'v2');
  fs.writeFileSync(path.join(repo, 'src.js'), 'my uncommitted work\n');
  const r = healGeneratedDirt(run, { mode: 'on' });
  assert.equal(r.restored.length, 1); assert.equal(r.other.length, 1); assert.match(r.other[0], /src\.js/);
  assert.equal(fs.readFileSync(path.join(repo, 'src.js'), 'utf8'), 'my uncommitted work\n');
});

test('on: a STAGED .pyc change is left alone (someone staged it deliberately)', () => {
  const { repo, run } = makeRepo();
  fs.writeFileSync(pyc(repo, 'a'), 'v2'); git(repo, 'add', '-f', pyc(repo, 'a'));
  fs.writeFileSync(pyc(repo, 'a'), 'v3');   // staged AND modified again (status MM)
  const r = healGeneratedDirt(run, { mode: 'on' });
  assert.equal(r.restored.length, 0); assert.equal(r.other.length, 1);
  assert.equal(fs.readFileSync(pyc(repo, 'a'), 'utf8'), 'v3');
});

test('dry-run reports wouldRestore, restores nothing, and still counts the files as other; off does nothing', () => {
  const { repo, run } = makeRepo();
  fs.writeFileSync(pyc(repo, 'a'), 'v2');
  const d = healGeneratedDirt(run, { mode: 'dry-run' });
  assert.equal(d.restored.length, 0); assert.equal(d.wouldRestore.length, 1); assert.equal(d.other.length, 1);
  assert.equal(fs.readFileSync(pyc(repo, 'a'), 'utf8'), 'v2');
  const o = healGeneratedDirt(run, { mode: 'off' });
  assert.deepEqual(o, { mode: 'off', restored: [], wouldRestore: [], other: [] });
});

test('healMode: default dry-run; env switch honoured', () => {
  const prev = process.env.AGENT_MANAGER_APPLY_CLONE_HEAL;
  try {
    delete process.env.AGENT_MANAGER_APPLY_CLONE_HEAL; assert.equal(healMode(), 'dry-run');
    process.env.AGENT_MANAGER_APPLY_CLONE_HEAL = 'on'; assert.equal(healMode(), 'on');
    process.env.AGENT_MANAGER_APPLY_CLONE_HEAL = 'off'; assert.equal(healMode(), 'off');
  } finally { if (prev === undefined) delete process.env.AGENT_MANAGER_APPLY_CLONE_HEAL; else process.env.AGENT_MANAGER_APPLY_CLONE_HEAL = prev; }
});

test('a failing run() never throws out of healGeneratedDirt', () => {
  const r = healGeneratedDirt(() => { throw new Error('git broke'); }, { mode: 'on' });
  assert.deepEqual(r.restored, []);
});

test('real runner assertCleanTree: with heal on, pyc-only dirt passes; with real dirt it still throws and names only that file', () => {
  const prev = process.env.AGENT_MANAGER_APPLY_CLONE_HEAL;
  process.env.AGENT_MANAGER_APPLY_CLONE_HEAL = 'on';
  try {
    const { repo } = makeRepo();
    const runner = createRealGitRunner(repo);
    fs.writeFileSync(pyc(repo, 'a'), 'v2');
    runner.assertCleanTree();                                  // must not throw
    assert.equal(fs.readFileSync(pyc(repo, 'a'), 'utf8'), 'v1');
    fs.writeFileSync(pyc(repo, 'a'), 'v3'); fs.writeFileSync(path.join(repo, 'src.js'), 'real work\n');
    assert.throws(() => runner.assertCleanTree(), (e) => /apply clone is dirty/.test(e.message) && /src\.js/.test(e.message) && !/\.pyc/.test(e.message));
  } finally { if (prev === undefined) delete process.env.AGENT_MANAGER_APPLY_CLONE_HEAL; else process.env.AGENT_MANAGER_APPLY_CLONE_HEAL = prev; }
});

test('real runner assertCleanTree with heal at default dry-run: pyc dirt still throws (behaviour unchanged)', () => {
  const prev = process.env.AGENT_MANAGER_APPLY_CLONE_HEAL; delete process.env.AGENT_MANAGER_APPLY_CLONE_HEAL;
  try {
    const { repo } = makeRepo();
    const runner = createRealGitRunner(repo);
    fs.writeFileSync(pyc(repo, 'a'), 'v2');
    assert.throws(() => runner.assertCleanTree(), /apply clone is dirty/);
  } finally { if (prev !== undefined) process.env.AGENT_MANAGER_APPLY_CLONE_HEAL = prev; }
});

test('apply-retry-check release test: pyc-only dirt counts as clean only when heal is on; real dirt never does', () => {
  const { defaultIsApplyCloneClean } = require('../apply-retry-check.js');
  const prevHeal = process.env.AGENT_MANAGER_APPLY_CLONE_HEAL;
  const prevRoot = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  const prevRepo = process.env.AGENT_MANAGER_REPO_ROOT;
  const prevPipe = process.env.AGENT_MANAGER_PIPELINE_DIR;
  try {
    const { repo } = makeRepo();
    process.env.AGENT_MANAGER_REPO_ROOT = repo;
    process.env.AGENT_MANAGER_PIPELINE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-dirt-pipe-'));
    process.env.AGENT_MANAGER_APPLY_REPO_ROOT = repo;
    fs.writeFileSync(pyc(repo, 'a'), 'v2');
    process.env.AGENT_MANAGER_APPLY_CLONE_HEAL = 'dry-run';
    assert.equal(defaultIsApplyCloneClean(), false);
    process.env.AGENT_MANAGER_APPLY_CLONE_HEAL = 'on';
    assert.equal(defaultIsApplyCloneClean(), true);
    fs.writeFileSync(pyc(repo, 'a'), 'v2'); fs.writeFileSync(path.join(repo, 'src.js'), 'real work\n');
    assert.equal(defaultIsApplyCloneClean(), false);
  } finally {
    for (const [k, v] of [['AGENT_MANAGER_APPLY_CLONE_HEAL', prevHeal], ['AGENT_MANAGER_APPLY_REPO_ROOT', prevRoot], ['AGENT_MANAGER_REPO_ROOT', prevRepo], ['AGENT_MANAGER_PIPELINE_DIR', prevPipe]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
