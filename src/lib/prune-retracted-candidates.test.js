'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pruneRetractedCandidates, retractedFromHistory, pruneDocText, pruneEnabled } = require('./prune-retracted-candidates.js');

const DOC = 'Docs/ARCH_REVIEW_CANDIDATES.md';
const block = (id, title, body = 'Strength: Strong\nFiles: x.js\n\nProblem: p') => `### AC-${id} · ${title}\n${body}`;
const doc = (...blocks) => `# Arch candidates\n\n${blocks.join('\n\n')}\n`;

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-retracted-'));
  const git = (args, extra = {}) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...extra });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  const write = (text) => { fs.mkdirSync(path.join(dir, 'Docs'), { recursive: true }); fs.writeFileSync(path.join(dir, DOC), text); };
  const commit = (msg) => { git(['add', '-A']); git(['commit', '-q', '-m', msg]); };
  return { dir, git, write, commit, read: () => fs.readFileSync(path.join(dir, DOC), 'utf8') };
}

// main: AC-1, AC-2, AC-3 -> (branch forks here) -> main retracts AC-2 and rewords AC-3's heading.
// triage branch: carries the old AC-2 and AC-3 plus its own new AC-10.
function scenario() {
  const r = mkRepo();
  r.write(doc(block(1, 'keep me'), block(2, 'retract me'), block(3, 'old wording of three')));
  r.commit('seed');
  r.git(['branch', 'triage']);
  r.write(doc(block(1, 'keep me'), block(3, 'NEW wording of three')));
  r.commit('retract AC-2, reword AC-3');
  r.git(['checkout', '-q', 'triage']);
  r.write(doc(block(1, 'keep me'), block(2, 'retract me'), block(3, 'old wording of three'), block(10, 'branch-only new candidate')));
  r.commit('Triage batch');
  return r;
}

test('a block main retracted is dropped from the branch; reworded, branch-only and unchanged blocks stay; one commit is made', () => {
  const r = scenario();
  const before = r.read();
  const out = pruneRetractedCandidates({ repoRoot: r.dir, git: r.git, mainRef: 'main', env: {} });
  assert.equal(out.committed, true);
  assert.deepEqual(out.pruned, [{ doc: DOC, ids: [2] }]);
  const after = r.read();
  assert.doesNotMatch(after, /AC-2 ·/);
  assert.match(after, /### AC-1 · keep me/);
  assert.match(after, /### AC-3 · old wording of three/, 'AC-3 is still on main (reworded), so it is not a retraction');
  assert.match(after, /### AC-10 · branch-only new candidate/);
  assert.equal(after, before.replace(`\n\n${block(2, 'retract me')}`, ''), 'every other byte of the doc is preserved exactly');
  assert.match(r.git(['log', '-1', '--format=%s']), /Drop 1 candidate\(s\) already retracted on main/);
  assert.equal(r.git(['status', '--porcelain']).trim(), '', 'the tree is clean afterwards');
});

test('an id main retracted is NOT pruned when the branch block has a different title', () => {
  const r = scenario();
  r.write(doc(block(1, 'keep me'), block(2, 'a completely different candidate'), block(3, 'old wording of three')));
  r.commit('branch reuses the id for something else');
  const out = pruneRetractedCandidates({ repoRoot: r.dir, git: r.git, mainRef: 'main', env: {} });
  assert.equal(out.committed, false);
  assert.match(r.read(), /AC-2 · a completely different candidate/);
});

test('nothing retracted -> no change and no commit', () => {
  const r = mkRepo();
  r.write(doc(block(1, 'one'), block(2, 'two')));
  r.commit('seed');
  r.git(['branch', 'triage']);
  r.git(['checkout', '-q', 'triage']);
  const head = r.git(['rev-parse', 'HEAD']);
  const out = pruneRetractedCandidates({ repoRoot: r.dir, git: r.git, mainRef: 'main', env: {} });
  assert.deepEqual(out, { pruned: [], committed: false });
  assert.equal(r.git(['rev-parse', 'HEAD']), head);
});

test('a repo with no candidate docs, or a doc that is not on main yet, is a no-op', () => {
  const bare = mkRepo();
  fs.writeFileSync(path.join(bare.dir, 'a.txt'), 'x');
  bare.commit('seed');
  assert.deepEqual(pruneRetractedCandidates({ repoRoot: bare.dir, git: bare.git, mainRef: 'main', env: {} }), { pruned: [], committed: false });

  const r = mkRepo();
  fs.writeFileSync(path.join(r.dir, 'a.txt'), 'x');
  r.commit('seed');
  r.git(['checkout', '-q', '-b', 'triage']);
  r.write(doc(block(1, 'only on the branch')));
  r.commit('doc exists only on the branch');
  assert.deepEqual(pruneRetractedCandidates({ repoRoot: r.dir, git: r.git, mainRef: 'main', env: {} }), { pruned: [], committed: false });
});

test('it never throws: a git failure means "prune nothing"', () => {
  const r = scenario();
  const before = r.read();
  const broken = () => { throw new Error('git exploded'); };
  assert.deepEqual(pruneRetractedCandidates({ repoRoot: r.dir, git: broken, mainRef: 'main', env: {} }), { pruned: [], committed: false });
  assert.equal(r.read(), before);
});

test('a failed commit restores the doc so the tree is not left dirty for the next batch', () => {
  const r = scenario();
  const before = r.read();
  const failingCommit = (args, extra) => { if (args[0] === 'commit') throw new Error('commit hook said no'); return r.git(args, extra); };
  const out = pruneRetractedCandidates({ repoRoot: r.dir, git: failingCommit, mainRef: 'main', env: {} });
  assert.equal(out.committed, false);
  assert.deepEqual(out.pruned, []);
  assert.equal(r.read(), before, 'the working copy is back to what it was');
  assert.equal(r.git(['status', '--porcelain']).trim(), '', 'and nothing is left staged');
});

test('AGENT_MANAGER_PRUNE_RETRACTED=off disables the repair', () => {
  const r = scenario();
  const before = r.read();
  const out = pruneRetractedCandidates({ repoRoot: r.dir, git: r.git, mainRef: 'main', env: { AGENT_MANAGER_PRUNE_RETRACTED: 'off' } });
  assert.deepEqual(out, { pruned: [], committed: false });
  assert.equal(r.read(), before);
  assert.equal(pruneEnabled({}), true);
  assert.equal(pruneEnabled({ AGENT_MANAGER_PRUNE_RETRACTED: 'OFF' }), false);
});

test('retractedFromHistory ignores ids still present at the tip and parses the dotted heading variants', () => {
  const history = ['-### AC-2 · retract me', '+### AC-4 · something added', '-### AC-3 · reworded', '+### AC-3 · reworded v2', '-## AC-7 - dashed title'].join('\n');
  const tip = doc(block(1, 'keep'), block(3, 'reworded v2'));
  const m = retractedFromHistory(history, tip);
  assert.deepEqual([...m.keys()].sort((a, b) => a - b), [2, 7]);
  assert.deepEqual([...m.get(2)], ['retract me']);
});

test('pruneDocText preserves the preamble and untouched blocks byte-for-byte', () => {
  const text = doc(block(1, 'a'), block(2, 'b'), block(3, 'c'));
  const { text: out, dropped } = pruneDocText(text, new Map([[2, new Set(['b'])]]));
  assert.deepEqual(dropped, [2]);
  assert.equal(out, doc(block(1, 'a'), block(3, 'c')).replace('\n\n### AC-3', '\n\n### AC-3'));
});
