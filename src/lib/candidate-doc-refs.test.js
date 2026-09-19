'use strict';

// Tests for candidate-doc-refs.js -- run against REAL git (a bare repo standing in for GitHub).
// Incident (2026-09-19, PropertyForager): candidate ids were allocated from one branch's working tree
// and generation read the doc from whichever branch was checked out, so two unmerged branches both used
// AC-2/AC-3 and a task was built from a candidate that only existed on an unmerged branch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { highestIdAcrossRefs, readCandidatesText } = require('./candidate-doc-refs.js');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const DOC = 'Docs/CANDS.md';

const block = (n, extra = '') => [
  `### AC-${n} · Candidate ${n}`, 'Strength: Strong', `Files: src/a${n}.js`, extra, '', 'Problem:', `p${n}`, '', 'Solution:', `s${n}`, '', 'Benefits:', `b${n}`, '',
].filter((l, i) => l !== '' || i > 3).join('\n');

// origin (bare) + a working clone whose main has AC-1..5. Returns { origin, work, docPath }.
function makeRepo() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cdr-'));
  const origin = path.join(T, 'origin.git');
  const work = path.join(T, 'work');
  git(['init', '--bare', '-q', '-b', 'main', origin], T);
  git(['clone', '-q', origin, work], T);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't']]) git(['config', k, v], work);
  fs.mkdirSync(path.join(work, 'Docs'));
  fs.writeFileSync(path.join(work, DOC), '# Candidates\n\n' + [1, 2, 3, 4, 5].map((n) => block(n)).join('\n') + '\n');
  git(['add', '.'], work);
  git(['commit', '-qm', 'main: AC-1..5'], work);
  git(['push', '-q', 'origin', 'main'], work);
  git(['remote', 'set-head', 'origin', 'main'], work);
  return { origin, work, docPath: path.join(work, DOC) };
}

// Push a branch that adds the given AC ids to the doc, then return to main (working tree back to main's).
function pushBranchWithIds(work, branch, ids) {
  git(['checkout', '-q', '-b', branch, 'main'], work);
  fs.appendFileSync(path.join(work, DOC), '\n' + ids.map((n) => block(n)).join('\n') + '\n');
  git(['commit', '-qam', `${branch}: ${ids.join(',')}`], work);
  git(['push', '-q', 'origin', branch], work);
  git(['checkout', '-q', 'main'], work);
}

test('highestIdAcrossRefs: sees ids on the default branch AND on unmerged agent/* branches, ignores other branches', () => {
  const { work, docPath } = makeRepo();
  assert.equal(highestIdAcrossRefs(docPath), 5, 'main alone');
  pushBranchWithIds(work, 'agent/arch-review-ac-1', [6, 7]);
  assert.equal(highestIdAcrossRefs(docPath), 7, 'an unmerged agent/* branch raises the floor');
  pushBranchWithIds(work, 'feature/unrelated', [99]);
  assert.equal(highestIdAcrossRefs(docPath), 7, 'a non-agent branch is ignored');
  fs.rmSync(path.dirname(work), { recursive: true, force: true });
});

test('highestIdAcrossRefs: a LOCAL-only agent/* branch also counts; 0 outside a git repo or with no doc', () => {
  const { work, docPath } = makeRepo();
  git(['checkout', '-q', '-b', 'agent/local-only', 'main'], work);
  fs.appendFileSync(docPath, '\n' + block(12) + '\n');
  git(['commit', '-qam', 'local'], work);
  git(['checkout', '-q', 'main'], work);
  assert.equal(highestIdAcrossRefs(docPath), 12);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cdr-plain-'));
  fs.writeFileSync(path.join(plain, 'x.md'), '### AC-9 · x\n');
  assert.equal(highestIdAcrossRefs(path.join(plain, 'x.md')), 0, 'not a git repo -> 0 (fail-open)');
  assert.equal(highestIdAcrossRefs(path.join(work, 'Docs', 'NOPE.md')), 0, 'doc on no ref -> 0');
  fs.rmSync(path.dirname(work), { recursive: true, force: true });
  fs.rmSync(plain, { recursive: true, force: true });
});

test('readCandidatesText: reads the DEFAULT BRANCH copy, not the checked-out unmerged branch\'s working tree', () => {
  const { work, docPath } = makeRepo();
  git(['checkout', '-q', '-b', 'agent/unmerged', 'main'], work);
  fs.appendFileSync(docPath, '\n' + block(6) + '\n');
  git(['commit', '-qam', 'unmerged AC-6'], work);
  assert.match(fs.readFileSync(docPath, 'utf8'), /### AC-6/, 'sanity: the working tree has the unmerged candidate');
  const text = readCandidatesText(docPath);
  assert.match(text, /### AC-5/);
  assert.doesNotMatch(text, /### AC-6/, 'an unmerged candidate must not be visible to task generation');
  fs.rmSync(path.dirname(work), { recursive: true, force: true });
});

test('readCandidatesText: kill switch, non-git fallback, and "default branch has no doc yet" -> empty', () => {
  const { work, docPath } = makeRepo();
  git(['checkout', '-q', '-b', 'agent/unmerged', 'main'], work);
  fs.appendFileSync(docPath, '\n' + block(6) + '\n');
  git(['commit', '-qam', 'unmerged AC-6'], work);

  process.env.AGENT_MANAGER_CANDIDATES_FROM_WORKING_TREE = 'true';
  try { assert.match(readCandidatesText(docPath), /### AC-6/, 'kill switch restores the working-tree read'); }
  finally { delete process.env.AGENT_MANAGER_CANDIDATES_FROM_WORKING_TREE; }

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cdr-plain2-'));
  fs.writeFileSync(path.join(plain, 'x.md'), 'plain file\n');
  assert.equal(readCandidatesText(path.join(plain, 'x.md')), 'plain file\n', 'not a git repo -> the file itself');
  assert.equal(readCandidatesText(path.join(plain, 'missing.md')), null);

  // A new doc that exists only in the working tree of an unmerged branch: main has none -> nothing merged.
  fs.writeFileSync(path.join(work, 'Docs', 'NEW_ONLY_HERE.md'), block(1) + '\n');
  assert.equal(readCandidatesText(path.join(work, 'Docs', 'NEW_ONLY_HERE.md')), '');
  fs.rmSync(path.dirname(work), { recursive: true, force: true });
  fs.rmSync(plain, { recursive: true, force: true });
});

test('applyArchDiscoveryCandidates skips ids already used on an unmerged agent/* branch (the AC-2/AC-3 collision)', () => {
  const { work, docPath } = makeRepo();
  pushBranchWithIds(work, 'agent/arch-review-ac-1', [6, 7]); // exists on origin, NOT in this working tree
  const saved = process.env.AGENT_MANAGER_REPO_ROOT;
  process.env.AGENT_MANAGER_REPO_ROOT = work;
  try {
    const { applyArchDiscoveryCandidates } = require('../candidate-docs.js');
    const implementResponse = ['### AC-001 · New one', 'Strength: Strong', 'Files: src/x.js', '', 'Problem: p', 'Solution: s', 'Benefits: b'].join('\n');
    const r = applyArchDiscoveryCandidates({ implementResponse, candidatesPath: docPath });
    assert.deepEqual(r.candidateIds, ['AC-8'], 'not AC-6 (working-tree max is 5) -- 6 and 7 are taken on the unmerged branch');
    const r2 = applyArchDiscoveryCandidates({ implementResponse, candidatesPath: docPath });
    assert.deepEqual(r2.candidateIds, ['AC-9']);
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = saved;
    fs.rmSync(path.dirname(work), { recursive: true, force: true });
  }
});

test('nextCandidateFulfillmentTask never builds a task from a candidate that exists only on an unmerged branch', () => {
  const { work, docPath } = makeRepo();
  // main's AC-1..5 are all Strong with file src/aN.js; put a distinctive Strong candidate only on the branch.
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  git(['checkout', '-q', '-b', 'agent/unmerged', 'main'], work);
  fs.appendFileSync(docPath, '\n' + block(6) + '\n');
  git(['commit', '-qam', 'unmerged AC-6'], work);

  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdr-pipe-'));
  process.env.AGENT_MANAGER_REPO_ROOT = work;
  process.env.AGENT_MANAGER_PIPELINE_DIR = pipelineDir;
  const { clearRegistry } = require('../task-source-registry.js');
  clearRegistry();
  require('../model-profile-registry.js').clearModelProfileRegistry();
  delete require.cache[require.resolve('../task-sources.js')];
  delete require.cache[require.resolve('../apply-group-a.js')];
  const { nextCandidateFulfillmentTask } = require('../task-sources.js');
  try {
    const ids = [];
    for (let i = 0; i < 8; i++) {
      const t = nextCandidateFulfillmentTask(docPath, 'arch_review');
      if (!t) break;
      ids.push(t.id);
      fs.mkdirSync(path.join(pipelineDir, 'queue', 'pending'), { recursive: true });
      fs.writeFileSync(path.join(pipelineDir, 'queue', 'pending', `${t.id}.json`), '{}');
    }
    assert.deepEqual(ids, ['arch-review-ac-1', 'arch-review-ac-2', 'arch-review-ac-3', 'arch-review-ac-4', 'arch-review-ac-5']);
    assert.ok(!ids.includes('arch-review-ac-6'), 'the unmerged branch\'s AC-6 is not turned into a task');
  } finally {
    delete process.env.AGENT_MANAGER_REPO_ROOT;
    delete process.env.AGENT_MANAGER_PIPELINE_DIR;
    fs.rmSync(path.dirname(work), { recursive: true, force: true });
    fs.rmSync(pipelineDir, { recursive: true, force: true });
  }
});
