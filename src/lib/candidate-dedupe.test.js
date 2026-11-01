'use strict';

// Tests for candidate-dedupe.js. Incident (2026-09-26): AC-187 re-appended AC-51's finding
// (`api_task_requeue`, python/dashboard/routes/task.py) because nothing compared file + function.

const test = require('node:test');
const assert = require('node:assert/strict');
const { candidateKey, entriesIn, findDuplicateCandidate, fallbackTitleIdentifier, dedupe, dedupeWithinBatch } = require('./candidate-dedupe.js');

const doc = (entries) => '# Candidates\n\n' + entries.map(([id, title, files]) =>
  [`### ${id} · ${title}`, 'Strength: Strong', files ? `Files: ${files}` : '', '', 'Problem:', 'p'].filter((l, i) => l !== '' || i > 2).join('\n')
).join('\n\n') + '\n';

const cand = (title, files) => ({ title, files });

test('same function twice -> duplicate of the existing AC id', () => {
  const text = doc([['AC-51', 'Decompose `api_task_requeue` into helpers', 'python/dashboard/routes/task.py']]);
  const hit = findDuplicateCandidate(cand('Decompose `api_task_requeue` into four single-purpose helpers', 'python/dashboard/routes/task.py'), [{ ref: 'master', text }]);
  assert.deepEqual(hit, { duplicateOf: 'AC-51', ref: 'master' });
});

test('a moved function (different line in the snippet/title suffix) still matches: line numbers never enter the key', () => {
  assert.equal(
    candidateKey(cand('Split `runReview` (L120)', 'src/review-task.js:120')),
    candidateKey(cand('Split `runReview` (L340)', 'src/review-task.js:340-410')),
  );
});

test('match found only on an unmerged branch ref', () => {
  const master = doc([['AC-1', 'Other `foo`', 'src/a.js']]);
  const branch = doc([['AC-9', 'Decompose `bar`', 'src/b.js']]);
  const hit = findDuplicateCandidate(cand('Decompose `bar` again', 'src/b.js'), [{ ref: 'master', text: master }, { ref: 'agent/triage-queue', text: branch }]);
  assert.deepEqual(hit, { duplicateOf: 'AC-9', ref: 'agent/triage-queue' });
});

test('different function in the same file, or same function name in a different file, is not a duplicate', () => {
  const text = doc([['AC-1', 'Decompose `foo`', 'src/a.js']]);
  assert.equal(findDuplicateCandidate(cand('Decompose `bar`', 'src/a.js'), [{ ref: 'master', text }]), null);
  assert.equal(findDuplicateCandidate(cand('Decompose `foo`', 'src/other.js'), [{ ref: 'master', text }]), null);
});

test('no backticked identifier or no files -> no key, never matches (fail-open)', () => {
  const text = doc([['AC-1', 'Consolidate the retry logic', 'src/a.js']]);
  assert.equal(candidateKey(cand('Consolidate the retry logic', 'src/a.js')), null);
  assert.equal(findDuplicateCandidate(cand('Consolidate the retry logic', 'src/a.js'), [{ ref: 'master', text }]), null);
  assert.equal(candidateKey(cand('Decompose `foo`', '')), null);
  assert.equal(findDuplicateCandidate(null, []), null);
  assert.deepEqual(entriesIn(null), []);
});

test('multi-file Files: lines match regardless of order and formatting', () => {
  assert.equal(
    candidateKey(cand('Fix `f`', './src/b.js, src/a.js')),
    candidateKey(cand('Fix `f()`', 'src/a.js src/b.js')),
  );
});

// --- 2026-10-03: the key no longer depends on the model backticking the symbol (AC-199 re-appended AC-52) ---

test('unbackticked verb-led titles dedupe on file + symbol (AC-199 vs AC-52 shape)', () => {
  const file = 'python/dashboard/static/js/branches-joblist-hardware-tabs.js';
  const text = doc([['AC-52', 'Decompose renderHardwareTab into per-section renderers', file]]);
  const hit = findDuplicateCandidate(cand('Decompose renderHardwareTab into per-section builders', file), [{ ref: 'master', text }]);
  assert.deepEqual(hit, { duplicateOf: 'AC-52', ref: 'master' });
});

test('same symbol in a different file is not a duplicate: a moved or same-named function is never matched on the symbol alone (AC-198 shape)', () => {
  const text = doc([['AC-10', 'Decompose applyBrainDumpSort guard-and-classify monolith', 'src/apply-group-a.js']]);
  assert.equal(findDuplicateCandidate(cand('Decompose applyBrainDumpSort into named helpers', 'src/apply-group-a-brain-dump.js'), [{ ref: 'master', text }]), null);
});

test('fallback only fires when the first word after the verb is itself identifier-like: prose titles stay keyless', () => {
  assert.equal(fallbackTitleIdentifier('Consolidate the retry logic'), '');
  assert.equal(fallbackTitleIdentifier('Extract repeated directory-traversal blocks in api_adhoc_task'), '');
  assert.equal(fallbackTitleIdentifier('Swallowed fetch error in loadProjectHistory'), '');
  assert.equal(fallbackTitleIdentifier('Decompose the api_queue_state graph logic'), 'api_queue_state');
  assert.equal(fallbackTitleIdentifier('Decompose renderHardwareTab into builders'), 'renderhardwaretab');
  assert.equal(candidateKey(cand('Consolidate the retry logic', 'src/a.js')), null);
});

test('an explicit symbol wins over the title, whatever the title says', () => {
  const k = (title, symbol) => candidateKey({ title, files: 'src/a.js', symbol });
  assert.equal(k('Decompose `foo`', 'bar'), k('no identifier here', 'bar()'));
  assert.notEqual(k('Decompose `foo`', 'bar'), k('Decompose `foo`', undefined));
});

test('entriesIn reads a Symbol: line, so an entry whose title has no identifier is still keyed', () => {
  const text = '# C\n\n### AC-7 · Tidy the retry logic\nStrength: Strong\nFiles: src/a.js\nSymbol: realFn\n\nProblem:\np\n';
  assert.deepEqual(entriesIn(text), [{ id: 'AC-7', key: 'src/a.js::realfn' }]);
  assert.deepEqual(findDuplicateCandidate({ title: 'Something unrelated', files: 'src/a.js', symbol: 'realFn' }, [{ ref: 'master', text }]), { duplicateOf: 'AC-7', ref: 'master' });
});

// --- 2026-10-07: within-batch dedupe tests (replaying questforge AC-4/AC-5 and pf-admin-ui AC-1/AC-2/AC-3) ---

test('dedupeWithinBatch: questforge AC-4/AC-5 replay - same file+symbol dropped as duplicate', () => {
  const candidates = [
    { id: 'questforge-AC-4', title: 'Decompose `migrate` into helpers', files: 'questforge/ddl/store.py', symbol: 'migrate' },
    { id: 'questforge-AC-5', title: 'Refactor `migrate` function for clarity', files: 'questforge/ddl/store.py', symbol: 'migrate' },
  ];
  const result = dedupeWithinBatch(candidates);
  assert.equal(result.candidates.length, 1, 'only one candidate kept');
  assert.equal(result.candidates[0].id, 'questforge-AC-4', 'first candidate kept (original)');
  assert.equal(result.removals.length, 1, 'one removal recorded');
  assert.equal(result.removals[0].duplicateCandidate.id, 'questforge-AC-5', 'AC-5 is the duplicate');
  assert.match(result.removals[0].reason, /within-batch duplicate/);
  assert.ok(result.removals[0].timestamp, 'removal has timestamp');
  assert.ok(result.removals[0].originalCandidate, 'removal has originalCandidate');
  assert.ok(result.removals[0].duplicateCandidate, 'removal has duplicateCandidate');
});

test('dedupeWithinBatch: pf-admin-ui AC-1/AC-2/AC-3 replay - AC-2 duplicates AC-1', () => {
  const candidates = [
    { id: 'pf-AC-1', title: 'Add `renderHardwareTab` to tabs', files: 'pf-admin-ui/static/js/tabs.js', symbol: 'renderHardwareTab' },
    { id: 'pf-AC-2', title: 'Extract `renderHardwareTab` into per-section renderers', files: 'pf-admin-ui/static/js/tabs.js', symbol: 'renderHardwareTab' },
    { id: 'pf-AC-3', title: 'Rename `TabManager` to `TabController`', files: 'pf-admin-ui/static/js/tab-manager.js', symbol: 'TabManager' },
  ];
  const result = dedupeWithinBatch(candidates);
  assert.equal(result.candidates.length, 2, 'two candidates kept');
  assert.equal(result.candidates[0].id, 'pf-AC-1', 'AC-1 kept');
  assert.equal(result.candidates[1].id, 'pf-AC-3', 'AC-3 kept (distinct)');
  assert.equal(result.removals.length, 1, 'one removal recorded');
  assert.equal(result.removals[0].duplicateCandidate.id, 'pf-AC-2', 'AC-2 is the duplicate');
});

test('dedupeWithinBatch: three-way duplicate - only first kept', () => {
  const candidates = [
    { id: 'dup-1', title: 'Fix `foo`', files: 'src/a.js', symbol: 'foo' },
    { id: 'dup-2', title: 'Refactor `foo`', files: 'src/a.js', symbol: 'foo' },
    { id: 'dup-3', title: 'Improve `foo`', files: 'src/a.js', symbol: 'foo' },
  ];
  const result = dedupeWithinBatch(candidates);
  assert.equal(result.candidates.length, 1, 'only one candidate kept');
  assert.equal(result.candidates[0].id, 'dup-1', 'first candidate kept');
  assert.equal(result.removals.length, 2, 'two removals recorded');
  assert.equal(result.removals[0].duplicateCandidate.id, 'dup-2');
  assert.equal(result.removals[1].duplicateCandidate.id, 'dup-3');
});

test('dedupeWithinBatch: distinct candidates all kept', () => {
  const candidates = [
    { id: 'dist-1', title: 'Fix `foo`', files: 'src/a.js', symbol: 'foo' },
    { id: 'dist-2', title: 'Fix `bar`', files: 'src/a.js', symbol: 'bar' },
    { id: 'dist-3', title: 'Fix `baz`', files: 'src/b.js', symbol: 'baz' },
  ];
  const result = dedupeWithinBatch(candidates);
  assert.equal(result.candidates.length, 3, 'all three candidates kept');
  assert.equal(result.removals.length, 0, 'no removals');
});

test('dedupeWithinBatch: unidentifiable candidates never dropped (fail-open)', () => {
  const candidates = [
    { id: 'id-1', title: 'Consolidate the retry logic', files: 'src/a.js' }, // no symbol, no backticked identifier
    { id: 'id-2', title: 'Fix `foo`', files: 'src/a.js', symbol: 'foo' },
  ];
  const result = dedupeWithinBatch(candidates);
  assert.equal(result.candidates.length, 2, 'both candidates kept');
  assert.equal(result.removals.length, 0, 'no removals');
});

test('dedupeWithinBatch: empty input returns empty result', () => {
  const result = dedupeWithinBatch([]);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.removals.length, 0);
});

test('dedupeWithinBatch: null input returns empty result', () => {
  const result = dedupeWithinBatch(null);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.removals.length, 0);
});

// --- Kill switch tests ---

test('dedupe: AGENT_MANAGER_CANDIDATE_DEDUPE=false disables all dedupe', () => {
  const candidates = [
    { id: 'kill-1', title: 'Fix `foo`', files: 'src/a.js', symbol: 'foo' },
    { id: 'kill-2', title: 'Refactor `foo`', files: 'src/a.js', symbol: 'foo' },
  ];
  const saved = process.env.AGENT_MANAGER_CANDIDATE_DEDUPE;
  process.env.AGENT_MANAGER_CANDIDATE_DEDUPE = 'false';
  try {
    const result = dedupe(candidates, null, { mode: 'within-batch' });
    assert.equal(result.candidates.length, 2, 'both candidates kept (kill switch)');
    assert.equal(result.removals.length, 0, 'no removals (kill switch)');
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_CANDIDATE_DEDUPE;
    else process.env.AGENT_MANAGER_CANDIDATE_DEDUPE = saved;
  }
});

test('dedupe: default mode is cross-batch', () => {
  const candidates = [
    { id: 'cb-1', title: 'Fix `foo`', files: 'src/a.js', symbol: 'foo' },
    { id: 'cb-2', title: 'Refactor `foo`', files: 'src/a.js', symbol: 'foo' },
  ];
  const result = dedupe(candidates, null, {});
  // Without docTexts, cross-batch mode doesn't drop anything (no existing doc to match against)
  assert.equal(result.candidates.length, 2);
});

test('dedupe: withinBatch flag triggers within-batch mode', () => {
  const candidates = [
    { id: 'wb-1', title: 'Fix `foo`', files: 'src/a.js', symbol: 'foo' },
    { id: 'wb-2', title: 'Refactor `foo`', files: 'src/a.js', symbol: 'foo' },
  ];
  const result = dedupe(candidates, null, { withinBatch: true });
  assert.equal(result.candidates.length, 1, 'within-batch mode drops duplicate');
  assert.equal(result.candidates[0].id, 'wb-1');
  assert.equal(result.removals.length, 1);
});

// --- Moved file scenario ---

test('dedupeWithinBatch: same function moved to different file is NOT a duplicate', () => {
  const candidates = [
    { id: 'move-1', title: 'Decompose `applyBrainDumpSort`', files: 'src/apply-group-a.js', symbol: 'applyBrainDumpSort' },
    { id: 'move-2', title: 'Refactor `applyBrainDumpSort`', files: 'src/apply-group-a-brain-dump.js', symbol: 'applyBrainDumpSort' },
  ];
  const result = dedupeWithinBatch(candidates);
  assert.equal(result.candidates.length, 2, 'both kept (different files)');
  assert.equal(result.removals.length, 0, 'no removals');
});

test('dedupeWithinBatch: line numbers stripped, so moved function in same file still matches', () => {
  const candidates = [
    { id: 'line-1', title: 'Split `runReview` (L120)', files: 'src/review-task.js:120', symbol: 'runReview' },
    { id: 'line-2', title: 'Extract `runReview` (L340)', files: 'src/review-task.js:340-410', symbol: 'runReview' },
  ];
  const result = dedupeWithinBatch(candidates);
  assert.equal(result.candidates.length, 1, 'only one kept (line numbers stripped)');
  assert.equal(result.removals.length, 1);
});

// --- Test count and replay number verification ---

test('dedupeWithinBatch: verifies test counts for questforge replay', () => {
  const candidates = [
    { id: 'questforge-AC-4', title: 'Decompose `migrate` into helpers', files: 'questforge/ddl/store.py', symbol: 'migrate' },
    { id: 'questforge-AC-5', title: 'Refactor `migrate` function for clarity', files: 'questforge/ddl/store.py', symbol: 'migrate' },
  ];
  const result = dedupeWithinBatch(candidates);
  assert.equal(result.candidates.length, 1, 'test count: 1 kept from 2');
  assert.equal(result.removals.length, 1, 'removal count: 1');
});

test('dedupeWithinBatch: verifies test counts for pf-admin-ui replay', () => {
  const candidates = [
    { id: 'pf-AC-1', title: 'Add `renderHardwareTab` to tabs', files: 'pf-admin-ui/static/js/tabs.js', symbol: 'renderHardwareTab' },
    { id: 'pf-AC-2', title: 'Extract `renderHardwareTab` into per-section renderers', files: 'pf-admin-ui/static/js/tabs.js', symbol: 'renderHardwareTab' },
    { id: 'pf-AC-3', title: 'Rename `TabManager` to `TabController`', files: 'pf-admin-ui/static/js/tab-manager.js', symbol: 'TabManager' },
  ];
  const result = dedupeWithinBatch(candidates);
  assert.equal(result.candidates.length, 2, 'test count: 2 kept from 3');
  assert.equal(result.removals.length, 1, 'removal count: 1');
});
