'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { closeAsImplemented, candidateIdentity, locateRecord } = require('./manual-close.js');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// bare origin + a working clone with one commit pushed to main (that commit is "the hand-made change") and one local-only commit.
function repo() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mclose-git-'));
  const origin = path.join(T, 'origin.git');
  const work = path.join(T, 'work');
  git(['init', '--bare', '-q', '-b', 'main', origin], T);
  git(['clone', '-q', origin, work], T);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't']]) git(['config', k, v], work);
  fs.writeFileSync(path.join(work, 'a.txt'), '1');
  git(['add', '.'], work); git(['commit', '-qm', 'base'], work); git(['push', '-q', 'origin', 'main'], work);
  git(['remote', 'set-head', 'origin', 'main'], work);
  fs.writeFileSync(path.join(work, 'a.txt'), '2');
  git(['commit', '-qam', 'hand-made refactor (no Task trailer)'], work); git(['push', '-q', 'origin', 'main'], work);
  const onMain = git(['rev-parse', 'HEAD'], work);
  fs.writeFileSync(path.join(work, 'a.txt'), '3');
  git(['commit', '-qam', 'local only'], work);
  const localOnly = git(['rev-parse', 'HEAD'], work);
  return { work, onMain, localOnly };
}

function pipeline() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'mclose-pipe-'));
  return p;
}
function put(pipe, rel, id, extra = {}) {
  const dir = path.join(pipe, 'queue', rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, source: 'arch_review', status: 'pending', history: [], ...extra }));
  return path.join(dir, `${id}.json`);
}
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('refuses a commit that is not on origin/<main>, and touches nothing', () => {
  const { work, localOnly } = repo();
  const pipe = pipeline();
  const f = put(pipe, 'done/_archived_no_action', 'arch-review-ac-6');
  const before = fs.readFileSync(f, 'utf8');
  const r = closeAsImplemented({ pipelineDir: pipe, repoRoot: work, ids: ['arch-review-ac-6'], commit: localOnly });
  assert.equal(r.ok, false);
  assert.match(r.error, /not on origin\/main/);
  assert.equal(fs.readFileSync(f, 'utf8'), before);
  assert.equal(closeAsImplemented({ pipelineDir: pipe, repoRoot: work, ids: ['x'], commit: 'zzzz' }).ok, false);
  assert.match(closeAsImplemented({ pipelineDir: pipe, repoRoot: work, ids: ['x'], commit: 'abcdef1234567' }).error, /not found/);
});

test('stamps an archived, unclassified record superseded with the commit; no mergedAt; dependents are released', () => {
  const { work, onMain } = repo();
  const pipe = pipeline();
  const f = put(pipe, 'done/_archived_no_action', 'arch-review-ac-6', { mergedAt: 'stale', mergedAtSource: 'bug' });
  const r = closeAsImplemented({ pipelineDir: pipe, repoRoot: work, ids: ['arch-review-ac-6'], commit: onMain.slice(0, 10), note: 'SearchMode refactor' });
  assert.equal(r.ok, true);
  assert.equal(r.commit, onMain);
  assert.equal(r.results[0].action, 'stamped');
  const rec = read(f);
  assert.equal(rec.terminalDisposition, 'superseded');
  assert.equal(rec.manualClose.commit, onMain);
  assert.equal(rec.manualClose.note, 'SearchMode refactor');
  assert.equal(rec.mergedAt, undefined);
  assert.equal(rec.history.at(-1).stage, 'superseded');
  assert.match(rec.history.at(-1).detail, /SearchMode refactor/);

  // The real gate agrees.
  const { isDependencySatisfied } = require('./task-sources.js');
  assert.equal(isDependencySatisfied(pipe, 'arch-review-ac-6'), true);
});

test('a candidate that was never tasked gets a closed record, so its id is TAKEN and the dependency is satisfied', () => {
  const { work, onMain } = repo();
  const pipe = pipeline();
  const r = closeAsImplemented({ pipelineDir: pipe, repoRoot: work, ids: ['arch-review-ac-7'], commit: onMain });
  assert.equal(r.results[0].action, 'created');
  const f = path.join(pipe, 'queue', 'done', '_archived_no_action', 'arch-review-ac-7.json');
  const rec = read(f);
  assert.equal(rec.source, 'arch_review');
  assert.equal(rec.terminalDisposition, 'superseded');
  assert.equal(JSON.parse(rec.promptContext).candidateId, 'AC-7');
  const { isDependencySatisfied } = require('./task-sources.js');
  assert.equal(isDependencySatisfied(pipe, 'arch-review-ac-7'), true);
});

test('a blocked task is stamped and moved to the archive; an in-pipeline task is refused', () => {
  const { work, onMain } = repo();
  const pipe = pipeline();
  const blocked = put(pipe, 'blocked', 'arch-review-ac-3');
  const drafting = put(pipe, 'review', 'arch-review-ac-4');
  const r = closeAsImplemented({ pipelineDir: pipe, repoRoot: work, ids: ['arch-review-ac-3', 'arch-review-ac-4'], commit: onMain });
  assert.equal(r.ok, false, 'one refusal makes the overall result not-ok');
  assert.equal(r.results[0].ok, true);
  assert.equal(fs.existsSync(blocked), false);
  assert.equal(read(path.join(pipe, 'queue', 'done', '_archived_no_action', 'arch-review-ac-3.json')).terminalDisposition, 'superseded');
  assert.equal(r.results[1].ok, false);
  assert.match(r.results[1].error, /review\/ -- a worker may hold it/);
  assert.equal(fs.existsSync(drafting), true, 'the in-pipeline record is untouched');
});

test('idempotent; leaves an already-merged record alone; dry-run writes nothing; unknown non-candidate id is an error', () => {
  const { work, onMain } = repo();
  const pipe = pipeline();
  const merged = put(pipe, 'done', 'arch-review-ac-1', { terminalDisposition: 'merged', mergedAt: 'x' });
  const arch = put(pipe, 'done/_archived_no_action', 'arch-review-ac-6');
  const args = { pipelineDir: pipe, repoRoot: work, commit: onMain };

  const dry = closeAsImplemented({ ...args, ids: ['arch-review-ac-6', 'arch-review-ac-7'], dryRun: true });
  assert.deepEqual(dry.results.map((x) => x.action), ['would-stamp', 'would-create']);
  assert.equal(read(arch).terminalDisposition, undefined);
  assert.equal(fs.existsSync(path.join(pipe, 'queue', 'done', '_archived_no_action', 'arch-review-ac-7.json')), false);

  assert.equal(closeAsImplemented({ ...args, ids: ['arch-review-ac-1'] }).results[0].action, 'already-landed');
  assert.equal(read(merged).terminalDisposition, 'merged');
  assert.equal(closeAsImplemented({ ...args, ids: ['arch-review-ac-6'] }).results[0].action, 'stamped');
  assert.equal(closeAsImplemented({ ...args, ids: ['arch-review-ac-6'] }).results[0].action, 'already-closed');

  const bad = closeAsImplemented({ ...args, ids: ['some-adhoc-task'] });
  assert.equal(bad.ok, false);
  assert.match(bad.results[0].error, /not a candidate id/);
});

test('candidateIdentity / locateRecord', () => {
  assert.deepEqual(candidateIdentity('function-length-ac-12'), { source: 'function_length', candidateId: 'AC-12' });
  assert.equal(candidateIdentity('adhoc-thing'), null);
  const pipe = pipeline();
  put(pipe, 'done/_archived/2026-08', 'arch-review-ac-2');
  assert.equal(locateRecord(pipe, 'arch-review-ac-2').state, 'archived');
  assert.equal(locateRecord(pipe, 'nope'), null);
});
