'use strict';

// Unit tests for candidate-docs.js -- the AC-NNN parse/next-id/append primitives extracted
// from apply-group-a.js (2026-08-27) so the out-of-tree hygiene plugin can share one copy.
// apply-group-a.js's own arch tests still exercise these through its re-export; these test
// the module directly and pin the re-export identity so a future edit can't silently fork
// the two.
//
// Run: node --test src/candidate-docs.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const candidateDocs = require('./candidate-docs.js');
const applyGroupA = require('./apply-group-a.js');

const { isEffectivelyEmptyResponse, parseArchDiscoveryCandidates, nextAvailableCandidateId, applyArchDiscoveryCandidates } = candidateDocs;

test('apply-group-a.js re-exports the exact same function objects as candidate-docs.js', () => {
  assert.equal(applyGroupA.isEffectivelyEmptyResponse, candidateDocs.isEffectivelyEmptyResponse);
  assert.equal(applyGroupA.parseArchDiscoveryCandidates, candidateDocs.parseArchDiscoveryCandidates);
  assert.equal(applyGroupA.applyArchDiscoveryCandidates, candidateDocs.applyArchDiscoveryCandidates);
});

test('isEffectivelyEmptyResponse treats "", \'\' and blank as empty; real content is not', () => {
  assert.equal(isEffectivelyEmptyResponse(''), true);
  assert.equal(isEffectivelyEmptyResponse('   \n  '), true);
  assert.equal(isEffectivelyEmptyResponse('""'), true);
  assert.equal(isEffectivelyEmptyResponse("''"), true);
  assert.equal(isEffectivelyEmptyResponse('### AC-1 · Real'), false);
  assert.equal(isEffectivelyEmptyResponse('he said "no"'), false);
});

test('parseArchDiscoveryCandidates returns [] for empty / quote-literal responses', () => {
  assert.deepEqual(parseArchDiscoveryCandidates(''), []);
  assert.deepEqual(parseArchDiscoveryCandidates('""'), []);
});

test('parseArchDiscoveryCandidates parses one block, defaults strength to Strong, tolerates a missing separator', () => {
  const [c] = parseArchDiscoveryCandidates('### AC-7 Extract the widget\nFiles: src/a.js\n\nProblem:\nToo big.');
  assert.equal(c.title, 'Extract the widget');
  assert.equal(c.strength, 'Strong');
  assert.equal(c.files, 'src/a.js');
  assert.match(c.body, /Too big\./);
});

test('parseArchDiscoveryCandidates captures an optional Source: line (arch_import format)', () => {
  const [c] = parseArchDiscoveryCandidates('### AC-3 · Adopt retry\nStrength: Strong\nSource: some-project / item-9\nFiles: x.js\n\nProblem:\nX.');
  assert.equal(c.source, 'some-project / item-9');
});

test('parseArchDiscoveryCandidates reads Split-Depth and applyArchDiscoveryCandidates round-trips it', () => {
  const [c] = parseArchDiscoveryCandidates('### AC-4 · A sub-candidate\nStrength: Strong\nSplit-Depth: 1\nFiles: src/a.js\n\nProblem:\nX.\n\nSolution:\nY.');
  assert.equal(c.splitDepth, 1);
  assert.doesNotMatch(c.body, /Split-Depth/, 'the marker is metadata, not part of the body');

  const docPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-split-')), 'D.md');
  applyArchDiscoveryCandidates({ implementResponse: [
    '### AC-1 · sub one', 'Strength: Strong', 'Split-Depth: 1', 'Files: src/a.js', '', 'Problem:', 'p', 'Solution:', 's',
  ].join('\n'), candidatesPath: docPath });
  const written = fs.readFileSync(docPath, 'utf8');
  assert.match(written, /^Split-Depth: 1$/m);
  assert.equal(parseArchDiscoveryCandidates(written.slice(written.indexOf('### AC-')))[0].splitDepth, 1);
});

test('parseArchDiscoveryCandidates leaves splitDepth 0 for a normal candidate', () => {
  const [c] = parseArchDiscoveryCandidates('### AC-9 · Normal\nStrength: Strong\nFiles: src/a.js\n\nProblem:\nX.');
  assert.equal(c.splitDepth, 0);
});

// --- Depends-On-Index / Depends-On (2026-09-05, see prompts.js's candidateSplitInstructions
// for the incident: two sibling split candidates, one depending on the other, both offered
// for drafting the same tick because nothing tracked the relationship) -----------------

test('parseArchDiscoveryCandidates reads Depends-On-Index and excludes it from the body', () => {
  const [c] = parseArchDiscoveryCandidates('### AC-16 · guard\nStrength: Strong\nFiles: src/a.js\nDepends-On-Index: 0\n\nProblem:\nX.\n\nSolution:\nY.');
  assert.equal(c.dependsOnIndex, 0);
  assert.doesNotMatch(c.body, /Depends-On-Index/, 'the marker is metadata, not part of the body');
});

test('parseArchDiscoveryCandidates leaves dependsOnIndex null when the line is absent', () => {
  const [c] = parseArchDiscoveryCandidates('### AC-9 · Normal\nStrength: Strong\nFiles: src/a.js\n\nProblem:\nX.');
  assert.equal(c.dependsOnIndex, null);
});

test('applyArchDiscoveryCandidates resolves a dependsOnIndex to the real Depends-On: AC-NNN id of its earlier sibling, in the same batch', () => {
  const docPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-dep-')), 'D.md');
  const implementResponse = [
    '### AC-1 · the gate', 'Strength: Strong', 'Files: src/a.js', '', 'Problem:', 'p1', 'Solution:', 's1',
    '', '### AC-2 · the guard', 'Strength: Strong', 'Files: src/b.js', 'Depends-On-Index: 0', '', 'Problem:', 'p2', 'Solution:', 's2',
  ].join('\n');
  const result = applyArchDiscoveryCandidates({ implementResponse, candidatesPath: docPath });
  assert.equal(result.candidateIds.length, 2);
  const written = fs.readFileSync(docPath, 'utf8');
  const guardBlock = written.slice(written.indexOf(`### ${result.candidateIds[1]}`));
  assert.match(guardBlock, new RegExp(`^Depends-On: ${result.candidateIds[0]}$`, 'm'));
  assert.doesNotMatch(guardBlock, /Depends-On-Index/, 'the placeholder must be replaced, not left alongside the real line');
});

test('applyArchDiscoveryCandidates omits Depends-On entirely for a candidate with no dependsOnIndex', () => {
  const docPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-dep-')), 'D.md');
  applyArchDiscoveryCandidates({
    implementResponse: '### AC-1 · plain\nStrength: Strong\nFiles: src/a.js\n\nProblem:\np\nSolution:\ns',
    candidatesPath: docPath,
  });
  assert.doesNotMatch(fs.readFileSync(docPath, 'utf8'), /Depends-On/);
});

test('nextAvailableCandidateId returns 1 for empty text and max+1 otherwise', () => {
  assert.equal(nextAvailableCandidateId(''), 1);
  assert.equal(nextAvailableCandidateId('### AC-4 x\n### AC-41 y\n### AC-9 z'), 42);
});

test('applyArchDiscoveryCandidates skips cleanly with no candidates, creates the doc, re-derives ids, appends', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-docs-test-'));
  const docPath = path.join(dir, 'ARCH_REVIEW_CANDIDATES.md');

  assert.equal(applyArchDiscoveryCandidates({ implementResponse: '', candidatesPath: docPath }).skipped, true);
  assert.equal(fs.existsSync(docPath), false);

  const r1 = applyArchDiscoveryCandidates({
    implementResponse: '### AC-99 · First\nStrength: Strong\nFiles: a.js\n\nProblem:\nP1.',
    candidatesPath: docPath,
    docTitle: '# Architecture Review Candidates',
  });
  assert.deepEqual(r1.candidateIds, ['AC-1'], 're-derived from the empty doc, not the model-picked 99');
  let text = fs.readFileSync(docPath, 'utf8');
  assert.match(text, /^# Architecture Review Candidates/);
  assert.match(text, /### AC-1 · First/);

  const r2 = applyArchDiscoveryCandidates({
    implementResponse: '### AC-1 · Second\nStrength: Strong\nFiles: b.js\n\nProblem:\nP2.',
    candidatesPath: docPath,
  });
  assert.deepEqual(r2.candidateIds, ['AC-2']);
  text = fs.readFileSync(docPath, 'utf8');
  assert.match(text, /### AC-1 · First/, 'prior content intact');
  assert.match(text, /### AC-2 · Second/);
});

test('applyArchDiscoveryCandidates writes a fenced Snippet: field only when a snippet is given', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-docs-test-'));
  const docPath = path.join(dir, 'CANDIDATES.md');
  applyArchDiscoveryCandidates({
    implementResponse: '### AC-1 · With snippet\nStrength: Strong\nFiles: a.js\n\nProblem:\nP.',
    candidatesPath: docPath,
    snippet: '  } catch {\n    return [];\n  }',
  });
  assert.match(fs.readFileSync(docPath, 'utf8'), /Snippet:\n```\n {2}\} catch \{\n {4}return \[\];\n {2}\}\n```/);

  const docPath2 = path.join(dir, 'CANDIDATES2.md');
  applyArchDiscoveryCandidates({
    implementResponse: '### AC-1 · No snippet\nStrength: Strong\n\nProblem:\nP.',
    candidatesPath: docPath2,
  });
  assert.doesNotMatch(fs.readFileSync(docPath2, 'utf8'), /Snippet:/);
});

// 2026-09-19 (PropertyForager arch-review-ac-1): a candidate written with `Files: SearchView` (bare, no
// extension) went into the doc verbatim and could never be fulfilled. The Files: line is now normalized
// to the real repo-relative path when the candidate is appended; anything unresolvable is left as written.
test('applyArchDiscoveryCandidates normalizes a bare / extension-less Files: entry to the real repo-relative path', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-norm-'));
  fs.mkdirSync(path.join(repo, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'components', 'SearchView.tsx'), 'export const SearchView = 1;\n');
  const saved = process.env.AGENT_MANAGER_REPO_ROOT;
  process.env.AGENT_MANAGER_REPO_ROOT = repo;
  try {
    const candidatesPath = path.join(repo, 'Docs', 'CANDS.md');
    const implementResponse = [
      '### AC-001 · Bare',
      'Strength: Strong',
      'Files: SearchView, Ghost.ts',
      '',
      'Problem: p',
      'Solution: s',
    ].join('\n');
    const result = applyArchDiscoveryCandidates({ implementResponse, candidatesPath });
    assert.equal(result.candidateCount, 1);
    const doc = fs.readFileSync(candidatesPath, 'utf8');
    assert.match(doc, /^Files: src\/components\/SearchView\.tsx, Ghost\.ts$/m, 'real entry resolved, unresolved one left as written');
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = saved;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// --- dedupe option (2026-09-26: AC-187 re-appended AC-51) ---------------------------------------------------
const { execFileSync } = require('child_process');
const dedupeGit = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const dedupeResp = (id, title, files) => `### AC-${id} \u00b7 ${title}\nStrength: Strong\nFiles: ${files}\n\nProblem:\np\n\nSolution:\ns\n\nBenefits:\nb\n`;

function dedupeRepo(mainDocBody) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cdd-'));
  const origin = path.join(T, 'origin.git');
  const work = path.join(T, 'work');
  dedupeGit(['init', '--bare', '-q', '-b', 'main', origin], T);
  dedupeGit(['clone', '-q', origin, work], T);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't']]) dedupeGit(['config', k, v], work);
  fs.mkdirSync(path.join(work, 'Docs'));
  const docPath = path.join(work, 'Docs', 'C.md');
  fs.writeFileSync(docPath, '# Candidates\n\n' + mainDocBody);
  dedupeGit(['add', '.'], work);
  dedupeGit(['commit', '-qm', 'main'], work);
  dedupeGit(['push', '-q', 'origin', 'main'], work);
  dedupeGit(['remote', 'set-head', 'origin', 'main'], work);
  return { T, work, docPath };
}

test('dedupe on: a candidate already on the default branch is skipped, nothing written, duplicateOf reported', () => {
  const { T, docPath } = dedupeRepo(dedupeResp(51, 'Decompose `api_task_requeue`', 'python/dashboard/routes/task.py'));
  const before = fs.readFileSync(docPath, 'utf8');
  const res = applyArchDiscoveryCandidates({ implementResponse: dedupeResp(1, 'Decompose `api_task_requeue` into four helpers', 'python/dashboard/routes/task.py'), candidatesPath: docPath, dedupe: true });
  assert.equal(res.skipped, true);
  assert.equal(res.duplicateOf, 'AC-51');
  assert.match(res.reason, /skipped/i, 'must match task-disposition NOOP_RE so the task closes as noop');
  assert.equal(fs.readFileSync(docPath, 'utf8'), before);
  fs.rmSync(T, { recursive: true, force: true });
});

test('dedupe on: a duplicate that exists only on an unmerged agent/* branch is skipped', () => {
  const { T, work, docPath } = dedupeRepo(dedupeResp(1, 'Decompose `foo`', 'src/a.js'));
  dedupeGit(['checkout', '-q', '-b', 'agent/triage-queue', 'main'], work);
  fs.appendFileSync(docPath, '\n' + dedupeResp(2, 'Decompose `bar`', 'src/b.js'));
  dedupeGit(['commit', '-qam', 'branch'], work);
  dedupeGit(['push', '-q', 'origin', 'agent/triage-queue'], work);
  dedupeGit(['checkout', '-q', 'main'], work);
  const res = applyArchDiscoveryCandidates({ implementResponse: dedupeResp(1, 'Decompose `bar` again', 'src/b.js'), candidatesPath: docPath, dedupe: true });
  assert.equal(res.skipped, true);
  assert.equal(res.duplicateOf, 'AC-2');
  assert.match(res.reason, /agent\/triage-queue/);
  fs.rmSync(T, { recursive: true, force: true });
});

test('dedupe on: a genuinely new function is appended as before, and a duplicate within one batch is dropped', () => {
  const { T, docPath } = dedupeRepo(dedupeResp(1, 'Decompose `foo`', 'src/a.js'));
  const res = applyArchDiscoveryCandidates({
    implementResponse: dedupeResp(1, 'Decompose `baz`', 'src/c.js') + '\n' + dedupeResp(2, 'Decompose `baz` twice', 'src/c.js'),
    candidatesPath: docPath, dedupe: true,
  });
  assert.equal(res.candidateCount, 1);
  assert.equal(res.duplicatesSkipped, 1);
  assert.match(fs.readFileSync(docPath, 'utf8'), /Decompose `baz`/);
  fs.rmSync(T, { recursive: true, force: true });
});

test('dedupe off (default) appends a same-function candidate exactly as before -- split siblings are never dropped', () => {
  const { T, docPath } = dedupeRepo(dedupeResp(1, 'Extract `foo` part one', 'src/a.js'));
  const res = applyArchDiscoveryCandidates({ implementResponse: dedupeResp(1, 'Extract `foo` part one', 'src/a.js'), candidatesPath: docPath });
  assert.equal(res.candidateCount, 1);
  assert.equal(res.skipped, undefined);
  fs.rmSync(T, { recursive: true, force: true });
});

test('dedupe on + symbol: a Symbol: line is written right after Files:, and a repeat with an identifier-free title is skipped as a duplicate', () => {
  const { T, docPath } = dedupeRepo('');
  const first = applyArchDiscoveryCandidates({ implementResponse: dedupeResp(1, 'Decompose someHelperFn into parts', 'src/a.js'), candidatesPath: docPath, dedupe: true, symbol: 'someHelperFn' });
  assert.equal(first.candidateCount, 1);
  assert.match(fs.readFileSync(docPath, 'utf8'), /Files: src\/a\.js\nSymbol: someHelperFn\n/);
  const before = fs.readFileSync(docPath, 'utf8');
  const second = applyArchDiscoveryCandidates({ implementResponse: dedupeResp(1, 'Tidy the retry logic', 'src/a.js'), candidatesPath: docPath, dedupe: true, symbol: 'someHelperFn' });
  assert.equal(second.skipped, true);
  assert.equal(second.duplicateOf, 'AC-1');
  assert.equal(fs.readFileSync(docPath, 'utf8'), before, 'a skipped duplicate must not touch the doc');
  fs.rmSync(T, { recursive: true, force: true });
});

test('dedupe kill switch AGENT_MANAGER_CANDIDATE_DEDUPE=false restores plain appends', () => {
  const { T, docPath } = dedupeRepo(dedupeResp(1, 'Decompose `foo`', 'src/a.js'));
  process.env.AGENT_MANAGER_CANDIDATE_DEDUPE = 'false';
  try {
    const res = applyArchDiscoveryCandidates({ implementResponse: dedupeResp(1, 'Decompose `foo`', 'src/a.js'), candidatesPath: docPath, dedupe: true });
    assert.equal(res.candidateCount, 1);
  } finally { delete process.env.AGENT_MANAGER_CANDIDATE_DEDUPE; }
  fs.rmSync(T, { recursive: true, force: true });
});

test('dedupe on outside a git repo fails open to the working-tree text', () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cdd-nogit-'));
  const docPath = path.join(T, 'C.md');
  fs.writeFileSync(docPath, '# C\n\n' + dedupeResp(1, 'Decompose `foo`', 'src/a.js'));
  const dup = applyArchDiscoveryCandidates({ implementResponse: dedupeResp(1, 'Decompose `foo` again', 'src/a.js'), candidatesPath: docPath, dedupe: true });
  assert.equal(dup.skipped, true);
  const fresh = applyArchDiscoveryCandidates({ implementResponse: dedupeResp(1, 'Decompose `qux`', 'src/q.js'), candidatesPath: docPath, dedupe: true });
  assert.equal(fresh.candidateCount, 1);
  fs.rmSync(T, { recursive: true, force: true });
});

// renderCandidateSection (extracted 2026-10-03 for candidate-size-gate.js): the gate must measure exactly what
// applyArchDiscoveryCandidates writes, so the section it renders is pinned against the real written doc.
test('renderCandidateSection output is exactly the section applyArchDiscoveryCandidates writes', () => {
  const { renderCandidateSection } = candidateDocs;
  const blk = (id, title, meta, body) => `### AC-${id} · ${title}\nStrength: Strong\n${meta}\n\nProblem:\n${body}\n\nSolution:\nS\n\nBenefits:\nB\n`;
  const shapes = [
    { resp: blk(1, 'Plain', 'Files: src/a.js', 'p'), opts: {} },
    { resp: blk(1, 'Split', 'Split-Depth: 1\nFiles: src/a.js', 'p'), opts: {} },
    { resp: blk(1, 'Sourced', 'Source: function_length_review\nFiles: src/a.js', 'p'), opts: {} },
    { resp: blk(1, 'Bare', 'Files: SearchView, ./src/b.js:12-40', 'p'), opts: {} },
    { resp: blk(1, 'Decompose someFn', 'Files: src/a.js', 'p'), opts: { symbol: 'someFn' } },
    { resp: blk(1, 'Snip', 'Files: src/b.js', 'p'), opts: { snippet: 'function bar() {\n  return `x`;\n}' } },
  ];
  for (const s of shapes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-parity-'));
    const p = path.join(dir, 'DOC.md');
    const res = applyArchDiscoveryCandidates({ implementResponse: s.resp, candidatesPath: p, docTitle: '# T', ...s.opts });
    const c = parseArchDiscoveryCandidates(s.resp)[0];
    if (s.opts.symbol) c.symbol = s.opts.symbol;
    const section = renderCandidateSection(c, res.candidateIds[0], { snippet: s.opts.snippet || null, dependsOnId: null });
    assert.equal(fs.readFileSync(p, 'utf8'), `# T\n\n${section}`);
    // Pin the literal lines too: the render and the writer share one function now, so equality alone cannot see a line both drop.
    if (s.opts.symbol) assert.match(section, new RegExp(`\\nSymbol: ${s.opts.symbol}\\n`));
    if (s.opts.snippet) assert.match(section, /\nSnippet:\n```\n/);
    assert.match(section, /^### AC-\d+ · .+\nStrength: Strong\n/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderCandidateSection writes a Depends-On line only when a dependsOnId is passed', () => {
  const c = { title: 'T', strength: 'Strong', files: 'src/a.js', body: 'b' };
  assert.doesNotMatch(candidateDocs.renderCandidateSection(c, 'AC-2'), /Depends-On/);
  assert.match(candidateDocs.renderCandidateSection(c, 'AC-2', { dependsOnId: 'AC-1' }), /\nDepends-On: AC-1\n/);
});
