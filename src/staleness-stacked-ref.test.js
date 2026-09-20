'use strict';

// A STACKED task's files live on its chain branch, which the shared checkout's working tree does not show. 2026-09-20, PF HUB0005-01: the
// staleness sweep flagged it `invalid-premise (high, retire)` -- "every file this task names is absent from the repo" -- because
// src/lib/tileGrid.ts existed only on its chain branch. Real git: a bare origin, a clone left on main, and a chain branch that adds the file.
//
// Run: node --test src/staleness-stacked-ref.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { invalidPremiseSignal, alreadyImplementedSignal } = require('./staleness-audit-signals.js');
const { findStalenessCandidates } = require('./staleness-audit.js');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const BRANCH = 'agent/decompose-chain';

function makeRepo() {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-origin-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-repo-'));
  git(['init', '--bare', '-b', 'main', bare]);
  git(['clone', bare, repo]);
  git(['config', 'user.email', 't@example.com'], repo); git(['config', 'user.name', 'T'], repo);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'main.js'), 'x\n');
  git(['add', '.'], repo); git(['commit', '-m', 'init'], repo); git(['push', 'origin', 'main'], repo);
  git(['checkout', '-b', BRANCH], repo);
  fs.mkdirSync(path.join(repo, 'src', 'lib'));
  fs.writeFileSync(path.join(repo, 'src', 'lib', 'tileGrid.ts'), 'export const t = 1;\n');
  git(['add', '.'], repo); git(['commit', '-m', 'chain step'], repo); git(['push', 'origin', BRANCH], repo);
  git(['checkout', 'main'], repo); // the shared checkout is NOT on the chain branch
  return repo;
}

const task = (over = {}) => ({
  id: 'HUB0005-01', title: 'Add latLngToPx to src/lib/tileGrid.ts', source: 'manual',
  promptContext: { rawText: 'In src/lib/tileGrid.ts add an exported latLngToPx helper.' }, history: [], ...over,
});

test('invalidPremiseSignal: without a ref, a file only the chain branch has reads as absent (the live misfire)', () => {
  const repo = makeRepo();
  assert.equal(invalidPremiseSignal(repo, task()).hit, true);
});

test('invalidPremiseSignal: existsAtRef makes it real; false / throw / non-function leave the flag', () => {
  const repo = makeRepo();
  assert.equal(invalidPremiseSignal(repo, task(), (p) => p.endsWith('tileGrid.ts')).hit, false);
  for (const cb of [() => false, () => { throw new Error('git gone'); }, 'nope']) assert.equal(invalidPremiseSignal(repo, task(), cb).hit, true);
});

test('alreadyImplementedSignal: "asks to create X" is strong evidence when X already exists on the task\'s branch', () => {
  const repo = makeRepo();
  const t = task({ title: 'Create src/lib/tileGrid.ts', promptContext: { rawText: 'Create `src/lib/tileGrid.ts` with buildTileGrid.' } });
  assert.equal(alreadyImplementedSignal(repo, t).strong, false, 'the working tree (main) does not have it');
  const r = alreadyImplementedSignal(repo, t, (p) => p === 'src/lib/tileGrid.ts');
  assert.equal(r.strong, true);
  assert.match(r.strongEvidence[0], /already exists on this task's branch/);
});

test('findStalenessCandidates resolves a stacked task\'s branch itself: no invalid-premise flag for it, still one for a non-stacked twin', () => {
  const repo = makeRepo();
  const stacked = task({ stacked: { branch: BRANCH, seq: 5, total: 6 } });
  const plain = task({ id: 'twin' });
  const out = findStalenessCandidates([stacked, plain], {}, Date.now(), { repoRoot: repo });
  const reasonsOf = (id) => (out.find((c) => c.task.id === id) || { reasons: [] }).reasons;
  assert.ok(!reasonsOf('HUB0005-01').includes('invalid-premise'), `stacked task must not be flagged: ${reasonsOf('HUB0005-01')}`);
  assert.ok(reasonsOf('twin').includes('invalid-premise'), 'a non-stacked task naming the same absent file is still flagged');
});

test('findStalenessCandidates: a stacked task whose branch is not on origin keeps the working-tree verdict', () => {
  const repo = makeRepo();
  const t = task({ stacked: { branch: 'agent/no-such-branch', seq: 1, total: 2 } });
  const out = findStalenessCandidates([t], {}, Date.now(), { repoRoot: repo });
  assert.ok(out[0].reasons.includes('invalid-premise'));
});
