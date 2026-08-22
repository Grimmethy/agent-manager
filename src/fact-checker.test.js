'use strict';

// Unit tests for fact-checker.js's file-existence resolution -- added alongside a real
// bug fix (found live 2026-07-21): resolveAgainstRepo() only tried repoRoot,
// repoRoot/backend, and repoRoot/backend/python_services as candidate roots -- a
// DIFFERENT consumer project's directory layout hardcoded into this package's own code.
// This repo's real files live under src/, which was never tried, so a draft claiming a
// bare filename (e.g. "Files: ornith-client.js" instead of "src/ornith-client.js") always
// false-negatived as "missing" and got misreported to review as fabrication -- even
// though the file is real and the draft's specific technical claims about its content
// were independently verified accurate.
//
// Run: node --test src/fact-checker.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { checkFilePaths, checkDraft, resolveAgainstRepo, findByBasename, extractCreateModeTargets } = require('./fact-checker.js');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'real-file.js'), '// real');
  return dir;
}

test('resolveAgainstRepo resolves a path that already includes the real directory', () => {
  const repoRoot = makeRepo();
  const resolved = resolveAgainstRepo(repoRoot, 'src/real-file.js');
  assert.equal(resolved, path.join(repoRoot, 'src', 'real-file.js'));
});

test('resolveAgainstRepo returns null for a genuinely fabricated path, even with extraRoots given', () => {
  const repoRoot = makeRepo();
  const resolved = resolveAgainstRepo(repoRoot, 'src/does-not-exist.js', ['src']);
  assert.equal(resolved, null);
});

test('resolveAgainstRepo finds a bare filename even with no extraRoots, via the basename-search fallback', () => {
  // Superseded by the findByBasename fallback added alongside the deep_dive incident
  // below -- extraRoots is now a fast/known-location tier, not the only path to a match.
  const repoRoot = makeRepo();
  const resolved = resolveAgainstRepo(repoRoot, 'real-file.js');
  assert.equal(resolved, path.join(repoRoot, 'src', 'real-file.js'));
});

test('resolveAgainstRepo finds a bare filename when its real directory is passed as an extraRoot (the fix)', () => {
  const repoRoot = makeRepo();
  const resolved = resolveAgainstRepo(repoRoot, 'real-file.js', ['src']);
  assert.equal(resolved, path.join(repoRoot, 'src', 'real-file.js'));
});

test('checkFilePaths marks a real file (via extraRoots) as existing, not fabricated', () => {
  const repoRoot = makeRepo();
  const text = 'See `real-file.js` for details.';
  const [check] = checkFilePaths(text, repoRoot, ['src']);
  assert.equal(check.claimedPath, 'real-file.js');
  assert.equal(check.exists, true);
});

test('checkFilePaths still correctly flags a genuinely fabricated file as missing', () => {
  const repoRoot = makeRepo();
  const text = 'See `totally-made-up.js` for details.';
  const [check] = checkFilePaths(text, repoRoot, ['src']);
  assert.equal(check.exists, false);
});

test('checkFilePaths tries multiple extraRoots in order, not just the first', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-test-'));
  fs.mkdirSync(path.join(repoRoot, 'frontend', 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'backend', 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'backend', 'src', 'only-in-backend.js'), '// x');

  const [check] = checkFilePaths('`only-in-backend.js`', repoRoot, ['frontend/src', 'backend/src']);
  assert.equal(check.exists, true);
});

// --- Replay of the real incident, verbatim ---

test('replaying the real community-0 draft: a claim about local-client.js/local-tool-client.js is no longer misreported as fabricated', () => {
  // This repo's own real src/ files -- the actual fix target, not a synthetic fixture.
  // Renamed 2026-08-22 from ornith-client.js/ornith-tool-client.js -- same real files,
  // this replay just needs to name whatever they're actually called today.
  const repoRoot = path.join(__dirname, '..');
  const draftExcerpt = [
    'Files: local-client.js, local-tool-client.js',
    '',
    'Problem: Both `local-client.js` and `local-tool-client.js` define their own local',
    'constant instead of reading it from a shared config or module.',
  ].join('\n');

  // Production config: extraRoots=['src'] via AGENT_MANAGER_GREP_DIRS, the fast/
  // unambiguous tier -- the basename-search fallback alone would also resolve this now
  // that .claude/ is excluded from the walk, but extraRoots is what actually runs in
  // production (review-runner.ps1's child fact-checker.js call inherits it from env).
  const checksWithFix = checkFilePaths(draftExcerpt, repoRoot, ['src']);
  for (const c of checksWithFix) {
    assert.equal(c.exists, true, `${c.claimedPath} should now resolve under src/`);
  }
});

// --- findByBasename fallback: for deep_dive's cloned external repos, whose layout can't
// be known in advance the way this package's own 'src/' can (no fixed extraRoots list
// generalizes to an arbitrary external project) ---

test('findByBasename finds a file nested several directories deep', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-test-'));
  const nested = path.join(dir, 'a', 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'Deep.tsx'), '// x');

  const matches = findByBasename(dir, 'Deep.tsx');
  assert.deepEqual(matches, [path.join(nested, 'Deep.tsx')]);
});

test('findByBasename does not walk into node_modules/.git/etc', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-test-'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'Hidden.tsx'), '// x');

  const matches = findByBasename(dir, 'Hidden.tsx');
  assert.deepEqual(matches, []);
});

test('resolveAgainstRepo trusts a SINGLE basename match found via the fallback search', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-test-'));
  const nested = path.join(dir, 'desktop', 'src', 'components', 'ExecutionReport');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'SummaryCard.tsx'), '// x');

  // Bare filename, no directory -- exactly the real shape a deep_dive draft wrote.
  const resolved = resolveAgainstRepo(dir, 'SummaryCard.tsx');
  assert.equal(resolved, path.join(nested, 'SummaryCard.tsx'));
});

test('resolveAgainstRepo refuses to guess when a basename matches more than once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-test-'));
  fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'index.ts'), '// x');
  fs.writeFileSync(path.join(dir, 'b', 'index.ts'), '// x');

  const resolved = resolveAgainstRepo(dir, 'index.ts');
  assert.equal(resolved, null, 'ambiguous match should not be silently trusted');
});

// --- Replay of the SECOND real incident, same session, different flavor: deep_dive
// reviewing a cloned external repo (UsefulProjectIndex/clones/plan-cascade) wrote a bare
// filename for a file nested three directories deep. Skipped automatically if the clone
// isn't present on this machine (this is a real external clone, not a repo fixture). ---

test('replaying the real deep-dive-plan-cascade-18 draft against the actual clone', { skip: !fs.existsSync('F:\\GitHub\\UsefulProjectIndex\\clones\\plan-cascade') }, () => {
  const cloneRoot = 'F:\\GitHub\\UsefulProjectIndex\\clones\\plan-cascade';
  const draftExcerpt = 'Files: SummaryCard.tsx, TimelineWaterfall.tsx, QualityRadarChart.tsx';

  const checks = checkFilePaths(draftExcerpt, cloneRoot, []);
  for (const c of checks) {
    assert.equal(c.exists, true, `${c.claimedPath} should resolve via the basename-search fallback`);
  }
});

// --- Replay of the THIRD real incident: product_spec's first-ever live run (2026-08-20,
// against a brand-new crm-plugin repo) auto-rejected in review because a Group B
// `mode:"create"` draft's OWN target got flagged as a "missing file" -- exactly correct
// and expected for a create (the file isn't supposed to exist yet), not fabrication. ---

test('extractCreateModeTargets finds a single create-mode object\'s own target', () => {
  const draft = JSON.stringify({ mode: 'create', file: 'Docs/PRODUCT_SPEC.md', content: '# Spec' });
  const targets = extractCreateModeTargets(draft);
  assert.ok(targets.has('Docs/PRODUCT_SPEC.md'));
});

test('extractCreateModeTargets finds create-mode targets inside a multi-file array, ignoring edit/delete entries', () => {
  const draft = JSON.stringify([
    { mode: 'create', file: 'src/new-thing.js', content: '...' },
    { mode: 'edit', file: 'src/existing.js', find: 'a', replace: 'b' },
    { mode: 'delete', file: 'src/old.js' },
  ]);
  const targets = extractCreateModeTargets(draft);
  assert.deepEqual([...targets], ['src/new-thing.js']);
});

test('extractCreateModeTargets returns an empty set for non-Group-B prose (e.g. a brain_dump_sort/research draft), not a throw', () => {
  assert.deepEqual([...extractCreateModeTargets('This is plain prose, not JSON.')], []);
});

test('checkDraft does not flag a create-mode draft\'s own target as a missing-file fabrication signal (the live 2026-08-20 product_spec incident)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-test-'));
  const draft = JSON.stringify({ mode: 'create', file: 'Docs/PRODUCT_SPEC.md', content: '# Product Spec\n\n## Entities\n' });

  const result = checkDraft(draft, dir);
  assert.deepEqual(result.flags.filter((f) => f.type === 'missing-file'), []);
  // Still recorded in fileChecks for transparency -- only the derived flag is suppressed.
  const check = result.fileChecks.find((c) => c.claimedPath === 'Docs/PRODUCT_SPEC.md');
  assert.equal(check.exists, false);
  // isCreateTarget stamped onto the raw fileChecks entry too, not just used to filter
  // `flags` -- the reviewer MODEL reads this raw JSON directly (see review-task.js's
  // buildVerdictPrompt), so the explanation has to travel with the data itself, not just
  // live in the derived flags list the model never sees on its own.
  assert.equal(check.isCreateTarget, true);
});

test('checkDraft does NOT stamp isCreateTarget on a path that merely happens to share a name with an unrelated create target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-test-'));
  const draft = JSON.stringify([
    { mode: 'create', file: 'Docs/PRODUCT_SPEC.md', content: '# Spec' },
    { mode: 'edit', file: 'Docs/OTHER_MISSING.md', find: 'a', replace: 'b' },
  ]);

  const result = checkDraft(draft, dir);
  const other = result.fileChecks.find((c) => c.claimedPath === 'Docs/OTHER_MISSING.md');
  assert.equal(other.isCreateTarget, undefined);
});

test('checkDraft still flags a genuinely fabricated path referenced by an edit/delete (not the create target) as missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-test-'));
  const draft = JSON.stringify([
    { mode: 'create', file: 'Docs/PRODUCT_SPEC.md', content: '# Spec' },
    { mode: 'edit', file: 'src/does-not-exist.js', find: 'a', replace: 'b' },
  ]);

  const result = checkDraft(draft, dir);
  const missing = result.flags.filter((f) => f.type === 'missing-file').map((f) => f.detail);
  assert.deepEqual(missing, ['src/does-not-exist.js']);
});
