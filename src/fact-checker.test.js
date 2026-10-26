'use strict';

// Unit tests for fact-checker.js's file-existence resolution -- added alongside a real
// bug fix (found live 2026-07-21): resolveAgainstRepo() only tried repoRoot,
// repoRoot/backend, and repoRoot/backend/python_services as candidate roots -- a
// DIFFERENT consumer project's directory layout hardcoded into this package's own code.
// This repo's real files live under src/, which was never tried, so a draft claiming a
// bare filename (e.g. "Files: local-client.js" instead of "src/local-client.js") always
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
const { execFileSync } = require('child_process');
const { extractDiffCreateTargets, checkFilePaths, extractFilePaths, checkDraft, resolveAgainstRepo, findByBasename, extractCreateModeTargets, checkCommitClaims, extractClaimedCommits, checkGroundedValues, checkFileLineCitations, checkRevertsAPriorFix, checkCompletionClaimsInNote, stripVendoredDiffSections } = require('./fact-checker.js');

// Real git repo fixture with exactly one real commit -- needed to test checkCommitClaims
// against a hash that genuinely exists, not just one that doesn't.
function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-git-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'test');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  const realHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, realHash };
}

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

// --- Regression: a file:line token (e.g. "src/foo.js:310") must not be silently truncated
// to its bare path by PATH_EXT_RE -- that would leak a false exists:true (or exists:false)
// signal downstream. PATH_EXT_RE's (?!\s*:\s*\d) lookahead rejects the :NNN suffix at
// extraction time (commit #239); these tests pin that behaviour so a future regex edit
// cannot reintroduce the truncation. ---

test('extractFilePaths does not truncate a file:line token to its bare path', () => {
  assert.deepEqual(extractFilePaths('see src/agentic-draft-common.js:310 for detail'), []);
});

test('extractFilePaths still extracts a bare path with no line suffix', () => {
  assert.deepEqual(extractFilePaths('see src/real-file.js for detail'), ['src/real-file.js']);
});

// A method call that happens to end in a file extension (res.json(...), r.json(), resp.json()) is code, not a cited file.
test('extractFilePaths does not read a method call like res.json({...}), r.json() or resp.json() as a file path', () => {
  assert.deepEqual(extractFilePaths('await res.json({ ok: 1 }) then r.json() and resp.json()'), []);
});

test('extractFilePaths still extracts real, backticked and quoted paths and a path followed by prose in parentheses', () => {
  assert.deepEqual(
    extractFilePaths("see foo.js (the helper) and src/data.json and `config.json` and require('./lib/x.js')"),
    ['foo.js', 'src/data.json', 'config.json', './lib/x.js'],
  );
});

test('extractFilePaths returns only the real path when a call and a path share one text', () => {
  assert.deepEqual(extractFilePaths('const d = await r.json(); // reads src/real-file.js'), ['src/real-file.js']);
});

test('checkFilePaths does not leak a :NNN-suffixed token as an existing file', () => {
  const repoRoot = makeRepo();
  assert.deepEqual(checkFilePaths('see src/real-file.js:310 for detail', repoRoot, ['src']), []);
});

test('checkFilePaths still resolves a bare path to an existing file', () => {
  const repoRoot = makeRepo();
  const [check] = checkFilePaths('see src/real-file.js for detail', repoRoot, ['src']);
  assert.equal(check.claimedPath, 'src/real-file.js');
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

// --- 2026-08-31: brain_dump_sort / secondbrain drafts name a `secondBrainPath` note
// destination. Filing a brand-new note (the path doesn't exist yet) is the normal case,
// not fabrication -- but the deterministic missing-file flag was still generated and fed
// to the reviewer as evidence. Done-task backlog: 7/8 brain_dump_sort tasks bounced at
// review on exactly this. Treat secondBrainPath the same as a Group B create target. ---

test('extractCreateModeTargets picks up a brain_dump_sort draft\'s secondBrainPath', () => {
  const draft = JSON.stringify({
    category: 'task',
    secondBrainPath: 'projects/screaming_goat_advertisement_concept.md',
    tags: ['advertising'],
    actionable: true,
  });
  assert.deepEqual([...extractCreateModeTargets(draft)], ['projects/screaming_goat_advertisement_concept.md']);
});

test('checkDraft does not flag a not-yet-existing secondBrainPath as missing-file, and stamps isCreateTarget on it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-test-'));
  const draft = JSON.stringify({
    category: 'idea',
    secondBrainPath: 'agent_manager/ideas/send_to_chat.md',
    tags: ['agent-manager'],
    rationale: 'Feature idea for the chat panel.',
  });

  const result = checkDraft(draft, dir);
  assert.deepEqual(result.flags.filter((f) => f.type === 'missing-file'), [], 'no missing-file flag for the note destination');
  const check = result.fileChecks.find((c) => c.claimedPath === 'agent_manager/ideas/send_to_chat.md');
  assert.equal(check.exists, false);
  assert.equal(check.isCreateTarget, true, 'the explanation travels with the raw fileChecks entry the reviewer model reads');
});

test('checkDraft still flags a genuinely fabricated repo path in a brain_dump_sort draft that also carries a secondBrainPath', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-test-'));
  const draft = JSON.stringify({
    category: 'task',
    secondBrainPath: 'projects/new_note.md',
    rationale: 'This relates to code in src/totally-made-up-module.js which handles it.',
  });

  const result = checkDraft(draft, dir);
  const missing = result.flags.filter((f) => f.type === 'missing-file').map((f) => f.detail);
  assert.deepEqual(missing, ['src/totally-made-up-module.js'], 'the note destination is exempt; a fabricated code path is still caught');
});

// Regression, 2026-08-23: caught live -- a draft was rejected TWICE by a human reviewer
// for claiming "already resolved (commit 7261944)" with no diff or evidence, and that
// hash does not exist anywhere in the repo. checkFilePaths already catches a fabricated
// FILE reference deterministically before a review pass spends a token on it; this closes
// the same gap for a fabricated COMMIT reference.

test('extractClaimedCommits finds a commit hash following the word "commit"', () => {
  assert.deepEqual(extractClaimedCommits('already resolved (commit 7261944), nothing to do'), ['7261944']);
});

test('extractClaimedCommits finds a backtick-wrapped hash and lowercases it', () => {
  assert.deepEqual(extractClaimedCommits('see commit `ABC1234`'), ['abc1234']);
});

test('extractClaimedCommits dedupes repeated mentions of the same hash', () => {
  assert.deepEqual(extractClaimedCommits('fixed in commit abc1234. See also commit abc1234 for details.'), ['abc1234']);
});

test('extractClaimedCommits ignores a bare hex-looking string with no "commit" nearby', () => {
  assert.deepEqual(extractClaimedCommits('the value 7261944 appears in the config'), []);
});

test('checkCommitClaims flags a hash that does not exist in the repo as exists:false', () => {
  const { dir } = makeGitRepo();
  const result = checkCommitClaims('already resolved in commit 7261944', dir);
  assert.equal(result.length, 1);
  assert.equal(result[0].claimedHash, '7261944');
  assert.equal(result[0].exists, false);
});

test('checkCommitClaims confirms a hash that genuinely exists in the repo as exists:true', () => {
  const { dir, realHash } = makeGitRepo();
  const result = checkCommitClaims(`already resolved in commit ${realHash}`, dir);
  assert.equal(result.length, 1);
  assert.equal(result[0].exists, true);
});

test('checkCommitClaims reports exists:null (not false) when the repo/git itself is unavailable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-nogit-test-')); // not a git repo
  const result = checkCommitClaims('already resolved in commit 7261944', dir);
  assert.equal(result.length, 1);
  assert.equal(result[0].exists, null);
});

test('checkDraft flags a fabricated commit reference and includes commitChecks in its return value', () => {
  const { dir } = makeGitRepo();
  const result = checkDraft('This was already resolved in commit 7261944, no changes needed.', dir);
  const fabricated = result.flags.filter((f) => f.type === 'fabricated-commit-reference');
  assert.deepEqual(fabricated, [{ type: 'fabricated-commit-reference', detail: '7261944' }]);
  assert.equal(result.commitChecks.length, 1);
});

test('checkDraft does NOT flag a real, existing commit hash', () => {
  const { dir, realHash } = makeGitRepo();
  const result = checkDraft(`This was already resolved in commit ${realHash}, no changes needed.`, dir);
  const fabricated = result.flags.filter((f) => f.type === 'fabricated-commit-reference');
  assert.deepEqual(fabricated, []);
});

// checkGroundedValues: newly-declared identifier exemption ------------------------------
// 2026-08-25, root-caused live via a real blocked task: a pure UI change legitimately
// introduced two brand-new JS constants (JOB_TYPE_FAMILIES, JOB_TYPE_FAMILY_BY_SOURCE) as
// part of a real `+const NAME = ...` line in its own diff, and both got flagged
// ungrounded-field -- a category error, not a false positive of the check's ORIGINAL
// purpose (a fabricated EXTERNAL data field, e.g. a GIS column name that's supposed to
// already exist upstream). A value the draft's own diff is DEFINING right now can never
// appear in grounding material that, by construction, predates the definition.

test('checkGroundedValues does not flag a newly-declared constant from a real +const line in the draft\'s own diff', () => {
  const draftText = [
    'Added grouping support.',
    '',
    '=== DIFF ===',
    'diff --git a/index.html b/index.html',
    '@@ -10,0 +11,3 @@',
    '+const JOB_TYPE_FAMILIES = [',
    '+  { key: "arch", members: ["arch_discovery"] },',
    '+];',
  ].join('\n');
  const sourceText = 'unrelated grounding material that never mentions that constant at all';

  const flags = checkGroundedValues(draftText, sourceText);
  assert.deepEqual(flags, []);
});

test('checkGroundedValues still flags a genuinely fabricated field that is NOT declared anywhere in the diff', () => {
  const draftText = 'The response includes the FCV_CUR field for current value.';
  const sourceText = 'grounding material that never mentions that field at all';

  const flags = checkGroundedValues(draftText, sourceText);
  assert.deepEqual(flags, [{ type: 'ungrounded-field', detail: 'FCV_CUR' }]);
});

test('checkGroundedValues does not exempt a field that merely APPEARS on a diff line without being declared', () => {
  // A reference to an ungrounded field inside a comment or a call, not a real declaration
  // of it, must still be flagged -- only an actual `const/let/var NAME =` counts.
  const draftText = [
    '=== DIFF ===',
    'diff --git a/index.html b/index.html',
    '@@ -10,0 +11,1 @@',
    '+  console.log(FCV_CUR);',
  ].join('\n');
  const sourceText = 'grounding material that never mentions that field at all';

  const flags = checkGroundedValues(draftText, sourceText);
  assert.deepEqual(flags, [{ type: 'ungrounded-field', detail: 'FCV_CUR' }]);
});

// Regression, 2026-08-25, same day: the const/let/var-only version above was itself a
// real, live false-positive gap -- confirmed on two real blocked adhoc tasks (WIKILINK_RE
// = re.compile(...), PANEL_TOGGLES_HTML = _read_asset(...)), both legitimate new Python
// module-level constants that no JS keyword could ever match.
test('checkGroundedValues does not flag a newly-declared Python constant with no const/let/var keyword', () => {
  const draftText = [
    '=== DIFF ===',
    'diff --git a/build_notes.py b/build_notes.py',
    '@@ -5,0 +6,1 @@',
    '+WIKILINK_RE = re.compile(r"\\[\\[([^\\]\\|#]+)")',
  ].join('\n');
  const sourceText = 'unrelated grounding material that never mentions that pattern at all';

  const flags = checkGroundedValues(draftText, sourceText);
  assert.deepEqual(flags, []);
});

test('checkGroundedValues still flags a real comparison (NAME == value) rather than treating it as a declaration', () => {
  const draftText = [
    '=== DIFF ===',
    'diff --git a/check.py b/check.py',
    '@@ -5,0 +6,1 @@',
    '+if FCV_CUR == expected:',
  ].join('\n');
  const sourceText = 'grounding material that never mentions that field at all';

  const flags = checkGroundedValues(draftText, sourceText);
  assert.deepEqual(flags, [{ type: 'ungrounded-field', detail: 'FCV_CUR' }]);
});

// checkGroundedValues: self-invented shell echo-marker exemption ------------------------
// 2026-09-08, root-caused live via a real blocked adhoc task (analytics-and-discovery.js
// file-decompose child): the draft's own agentic run really executed `node --check
// newfile.js && echo "NEWFILE_SYNTAX_OK"` in a sandboxed run_bash call, got real, live
// stdout back confirming the check passed, and cited that real result in its own report --
// flagged ungrounded-field anyway, because the marker is GIS_FIELD_RE-shaped and, being a
// private verification convention the model invented for itself, can never appear in any
// real repo source file. The 4th documented instance of this false-positive shape.

test('checkGroundedValues does not flag a self-invented echo success-marker the draft cites as real verification output', () => {
  const draftText = [
    'Ran the extraction script, then verified both files parse:',
    '`python3 extract.py && node --check newfile.js && echo "NEWFILE_SYNTAX_OK"`',
    'Real output: OK: 29 ranges removed; template 4921 -> 4076 lines; new file 873 lines',
    'NEWFILE_SYNTAX_OK',
  ].join('\n');
  const sourceText = 'unrelated grounding material that never mentions that marker at all';

  const flags = checkGroundedValues(draftText, sourceText);
  assert.deepEqual(flags, []);
});

test('checkGroundedValues still flags a field that merely LOOKS like an echo marker but was never actually echoed', () => {
  // Same ALL_CAPS-with-underscores shape, but never appears as the argument of an echo
  // command anywhere in the draft -- must still be flagged as a real fabrication risk.
  const draftText = 'The upstream dataset exposes a NEWFILE_SYNTAX_OK status column.';
  const sourceText = 'grounding material that never mentions that field at all';

  const flags = checkGroundedValues(draftText, sourceText);
  assert.deepEqual(flags, [{ type: 'ungrounded-field', detail: 'NEWFILE_SYNTAX_OK' }]);
});

test('checkGroundedValues exempts an echo marker whether or not it is quoted', () => {
  const draftText = 'Verified with: some_check.sh && echo INLINE_SYNTAX_OK';
  const sourceText = 'grounding material that never mentions that marker at all';

  const flags = checkGroundedValues(draftText, sourceText);
  assert.deepEqual(flags, []);
});

// checkGroundedValues: named-external-service URL exemption -----------------------------
// 2026-08-25, root-caused live via a real blocked adhoc task: a human design-decision note
// in the task's own promptContext.rawText named a real third-party webhook service by name
// ("Default to ntfy") without ever spelling out its literal URL. The draft correctly cited
// https://ntfy.sh and https://ntfy.sh/docs/publish/ as documentation for that choice, and
// both got flagged ungrounded-url -- a literal URL for a service that lives entirely
// outside this repo can never appear in local grounding material, no matter how legitimate
// the citation is.

test('checkGroundedValues does not flag a URL whose domain was named by the human in the source material', () => {
  const draftText = 'POST the alert payload to https://ntfy.sh/docs/publish/ as documented.';
  const sourceText = 'HUMAN DESIGN DECISION: Default to ntfy (self-hostable, no account/API-key required).';

  const flags = checkGroundedValues(draftText, sourceText);
  assert.deepEqual(flags, []);
});

test('checkGroundedValues still flags a fabricated URL whose domain was never named anywhere in the source material', () => {
  const draftText = 'POST the alert payload to https://totally-invented-service.example-real-tld.com/api.';
  const sourceText = 'HUMAN DESIGN DECISION: Default to ntfy (self-hostable, no account/API-key required).';

  const flags = checkGroundedValues(draftText, sourceText);
  assert.deepEqual(flags, [{ type: 'ungrounded-url', detail: 'https://totally-invented-service.example-real-tld.com/api' }]);
});

// checkGroundedValues: dotted letter-octet placeholder host ------------------------------
// 2026-10-22, live: a README example {"url": "http://100.x.y.z:7450"} beside a real grounded URL hard-blocked a
// whole multi-chat draft as ungrounded-url.

test('checkGroundedValues does not flag a dotted x.y.z placeholder host', () => {
  const sourceText = 'AGENT_URL=http://100.96.112.78:7450';
  const draftText = 'e.g. http://100.96.112.78:7450 and http://100.x.y.z:7450 or http://x.x.x.x:7450';
  assert.deepEqual(checkGroundedValues(draftText, sourceText), []);
});

test('checkGroundedValues still flags an invented numeric address next to a placeholder one', () => {
  const sourceText = 'AGENT_URL=http://100.96.112.78:7450';
  const draftText = 'use http://100.x.y.z:7450 or http://10.231.4.9:7450';
  assert.deepEqual(checkGroundedValues(draftText, sourceText), [{ type: 'ungrounded-url', detail: 'http://10.231.4.9:7450' }]);
});

// checkGroundedValues: real-but-elsewhere-in-the-repo exemption --------------------------
// 2026-08-25, root-caused live via a real blocked adhoc task (a Hardware tab UI diff): the
// draft's own comment correctly cited AGENT_MANAGER_MIN_FREE_VRAM_MB -- a real, pre-
// existing env var defined in gpu-guard.js -- as justification for a design choice, and
// got flagged ungrounded-field anyway, because sourceText only ever covers files the DIFF
// itself touches/cites; a frontend-only diff never touches gpu-guard.js. More general than
// the newly-declared-field and named-service-URL exemptions above: this covers ANY real
// identifier that exists literally ANYWHERE in the actual tracked repo, via a real
// `git grep`, not just ones the task's own rawText happened to name.

test('checkGroundedValues does not flag a field that exists literally elsewhere in the real repo, even though the diff never touches that file', () => {
  const { dir } = makeGitRepo();
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'gpu-guard.js'), "const MIN_FREE_VRAM_MB = Number(process.env.AGENT_MANAGER_MIN_FREE_VRAM_MB) || 4096;\n");
  execFileSync('git', ['add', 'src/gpu-guard.js'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'add gpu-guard'], { cwd: dir });

  const draftText = '// GPU VRAM headroom: gpu-guard.js already stops idle apps below its AGENT_MANAGER_MIN_FREE_VRAM_MB threshold.';
  const sourceText = 'unrelated frontend grounding material that never mentions VRAM at all';

  const flags = checkGroundedValues(draftText, sourceText, dir);
  assert.deepEqual(flags, []);
});

// checkGroundedValues: unchanged diff context/removed lines are not new claims -----------
// 2026-08-26, root-caused live via a real blocked adhoc task (the Job List family-grouping
// change): PERFORMANCE_FIX_CANDIDATES -- a field that had existed in the target file for
// six days before this draft touched it -- got flagged ungrounded-field anyway, because it
// happened to sit in an UNCHANGED context line of the draft's own embedded diff (the git-
// grep repo fallback above is a real safety net, but depends on a live repoRoot at review
// time and isn't a substitute for not flagging a context line in the first place). A field
// that only ever appears on an unchanged (' ') or removed ('-') diff line -- never on a
// real '+' addition -- is never a new claim the draft is making, regardless of whether
// sourceText or the repo happen to confirm it too.
test('checkGroundedValues does not flag a field that only appears in an unchanged diff context line', () => {
  const draftText = [
    'RESOLUTION: implemented',
    '',
    '=== DIFF ===',
    'diff --git a/index.html b/index.html',
    'index 1111111..2222222 100644',
    '--- a/index.html',
    '+++ b/index.html',
    '@@ -10,3 +10,5 @@ const JOB_TYPES = [',
    "   { source: 'performance_fix', description: 'against PERFORMANCE_FIX_CANDIDATES.md.' },",
    ' ];',
    '+const JOB_TYPE_FAMILIES = [];',
  ].join('\n');
  const sourceText = 'unrelated grounding material that never mentions that field at all';

  const flags = checkGroundedValues(draftText, sourceText);
  assert.deepEqual(flags, []);
});

test('checkGroundedValues still flags a field that does not exist anywhere in the real repo', () => {
  const { dir } = makeGitRepo();

  const draftText = 'The response includes the TOTALLY_FABRICATED_FIELD_XYZ for support.';
  const sourceText = 'grounding material that never mentions that field at all';

  const flags = checkGroundedValues(draftText, sourceText, dir);
  assert.deepEqual(flags, [{ type: 'ungrounded-field', detail: 'TOTALLY_FABRICATED_FIELD_XYZ' }]);
});

test('checkGroundedValues does not flag a URL that exists literally elsewhere in the real repo', () => {
  const { dir } = makeGitRepo();
  fs.writeFileSync(path.join(dir, 'config.js'), "const DOCS_URL = 'https://real-internal-docs.example.test/page';\n");
  execFileSync('git', ['add', 'config.js'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'add config'], { cwd: dir });

  const draftText = 'See https://real-internal-docs.example.test/page for details.';
  const sourceText = 'unrelated grounding material';

  const flags = checkGroundedValues(draftText, sourceText, dir);
  assert.deepEqual(flags, []);
});

// --- resolvedVia / imprecise-file-path (2026-08-30): a real file cited with a missing or
// wrong directory prefix is a citation nit, not fabrication. -----------------------------
const { resolveAgainstRepoDetailed } = require('./fact-checker.js');

test('resolveAgainstRepoDetailed reports how a path resolved (exact / prefix / basename)', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-via-'));
  fs.mkdirSync(path.join(repoRoot, 'server'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'server', 'app.py'), '# app');
  fs.writeFileSync(path.join(repoRoot, 'top.js'), '// top');

  assert.equal(resolveAgainstRepoDetailed(repoRoot, 'top.js').resolvedVia, 'exact');
  assert.equal(resolveAgainstRepoDetailed(repoRoot, 'server/app.py').resolvedVia, 'exact');
  assert.equal(resolveAgainstRepoDetailed(repoRoot, 'app.py', ['server']).resolvedVia, 'prefix');
  assert.equal(resolveAgainstRepoDetailed(repoRoot, 'app.py', []).resolvedVia, 'basename'); // single basename match
  assert.equal(resolveAgainstRepoDetailed(repoRoot, 'nope.py', ['server']).resolvedPath, null);
});

test('resolveAgainstRepoDetailed disambiguates >1 basename match by preferring one under an extraRoot', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-ambig-'));
  fs.mkdirSync(path.join(repoRoot, 'server', 'core'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'thirdparty'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'server', 'core', 'app.py'), '# real');
  fs.writeFileSync(path.join(repoRoot, 'thirdparty', 'app.py'), '# stray copy');

  // Neither tier-1 nor tier-2 (<root>/server/app.py, <root>/web/app.py) hits; the bare
  // basename walk finds 2 -> was null before; now prefers the one under an extraRoot.
  const r = resolveAgainstRepoDetailed(repoRoot, 'app.py', ['server', 'web']);
  assert.equal(r.resolvedPath, path.join(repoRoot, 'server', 'core', 'app.py'));
  assert.equal(r.resolvedVia, 'basename');
});

test('checkDraft: a real file cited with a wrong prefix -> imprecise-file-path flag, NOT missing-file', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-imprecise-'));
  fs.mkdirSync(path.join(repoRoot, 'server'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'server', 'app.py'), '# app');

  const draft = "The NSFW gating is already wired through app.py's /api/nsfw endpoint.";
  const fc = checkDraft(draft, repoRoot, undefined, ['server']);
  assert.equal(fc.flags.some((f) => f.type === 'missing-file'), false, 'no fabrication flag for a real file');
  const imp = fc.flags.find((f) => f.type === 'imprecise-file-path');
  assert.ok(imp, 'an informational imprecise-file-path flag is emitted');
  assert.match(imp.detail, /app\.py -> server\/app\.py/);
  assert.equal(fc.fileChecks.find((f) => f.claimedPath === 'app.py').resolvedVia, 'prefix');
});

test('checkDraft: a genuinely absent file is still flagged missing-file', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-absent-'));
  const fc = checkDraft('See totally-made-up.py for the implementation.', repoRoot, undefined, ['server']);
  assert.ok(fc.flags.some((f) => f.type === 'missing-file' && f.detail === 'totally-made-up.py'));
});

// existsLiterallyInRepo / checkGroundedValues: stacked-branch ref (2026-09-08 incident) ---
// A stacked task correctly citing a sibling's real, committed-but-unmerged value used to be
// hard-blocked ("cites a value that appears nowhere in its real grounding source") because
// existsLiterallyInRepo's git grep ran against the plain WORKING TREE (main), never the
// shared stacked branch the value actually lives on. `ref` (new optional arg, threaded from
// review-task.js's resolveGroundingRef) reads via the stacked ref's own tree instead.

function makeGitRepoWithOrigin() {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-stacked-origin-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-stacked-repo-'));
  execFileSync('git', ['init', '--bare', '-b', 'main', bareDir]);
  execFileSync('git', ['clone', bareDir, dir]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'test');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  execFileSync('git', ['push', 'origin', 'main'], { cwd: dir });

  execFileSync('git', ['checkout', '-b', 'agent/stacked-family'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'sibling.js'), 'const SIBLING_ONLY_FIELD = 1;\n');
  execFileSync('git', ['add', 'src/sibling.js'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'sibling commit'], { cwd: dir });
  execFileSync('git', ['push', 'origin', 'agent/stacked-family'], { cwd: dir });
  execFileSync('git', ['checkout', 'main'], { cwd: dir });

  return { dir };
}

test('checkGroundedValues does NOT flag a field that exists only on the given stacked ref', () => {
  const { dir } = makeGitRepoWithOrigin();
  const draftText = 'Wire this through SIBLING_ONLY_FIELD, already added by the sibling move task.';
  const sourceText = 'unrelated grounding material that never mentions this field';

  const flagsWithRef = checkGroundedValues(draftText, sourceText, dir, 'agent/stacked-family');
  assert.deepEqual(flagsWithRef, [], 'a value real on the stacked branch must not be flagged ungrounded');

  const flagsWithoutRef = checkGroundedValues(draftText, sourceText, dir);
  assert.deepEqual(flagsWithoutRef, [{ type: 'ungrounded-field', detail: 'SIBLING_ONLY_FIELD' }],
    'without a ref (a non-stacked task), the same value is still correctly flagged -- proves this is not a blanket loosening of the gate');
});

test('checkDraft threads a ref through to still flag a genuinely fabricated field even when a ref is given', () => {
  const { dir } = makeGitRepoWithOrigin();
  const draftText = 'This relies on TOTALLY_MADE_UP_FIELD being set.';
  const sourceText = 'grounding material with no mention of this field';

  const fc = checkDraft(draftText, dir, sourceText, [], 'agent/stacked-family');
  assert.ok(fc.flags.some((f) => f.type === 'ungrounded-field' && f.detail === 'TOTALLY_MADE_UP_FIELD'),
    'a value that is fabricated everywhere, including on the stacked branch, must still be flagged');
});

// --- checkRevertsAPriorFix (2026-09-08) -------------------------------------------------
// Root-caused live: change-review-fix-ac-1 auto-drafted (and got approved) a revert of a
// `throw err` back to `continue`, unaware that `throw` was the deliberate resolution of an
// earlier, different, already-confirmed finding (AC-164). This is the deterministic,
// git-grounded gate that catches that class of edit before it ever reaches a review vote.

function makeRevertFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-revert-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

  const filePath = path.join(dir, 'sweep.js');
  fs.writeFileSync(filePath, "  for (const dir of DIRS) {\n    try { names = fs.readdirSync(dir); } catch { continue; }\n  }\n");
  execFileSync('git', ['add', 'sweep.js'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial sweep loop'], { cwd: dir });

  // The "prior confirmed fix" -- carries this pipeline's own AC-\d+ marker.
  fs.writeFileSync(filePath, "  for (const dir of DIRS) {\n    try { names = fs.readdirSync(dir); } catch (err) { if (err.code === 'ENOENT') continue; console.error(err); throw err; }\n  }\n");
  execFileSync('git', ['add', 'sweep.js'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'AC-164 · Bare catch swallows non-ENOENT filesystem errors'], { cwd: dir });

  return { dir, filePath };
}

test('checkRevertsAPriorFix flags an edit that reverts toward code removed by a prior AC-marked commit', () => {
  const { dir } = makeRevertFixture();
  const implementResponse = JSON.stringify([{
    file: 'sweep.js',
    mode: 'edit',
    find: "console.error(err); throw err; }",
    replace: "console.error(err); continue; }",
  }]);
  const flags = checkRevertsAPriorFix(implementResponse, dir);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].type, 'reverts-a-prior-fix');
  assert.match(flags[0].subject, /AC-164/);
  assert.match(flags[0].detail, /sweep\.js/);
});

test('checkRevertsAPriorFix does not flag an edit to the same line that is NOT a revert (different transformation)', () => {
  const { dir } = makeRevertFixture();
  const implementResponse = JSON.stringify([{
    file: 'sweep.js',
    mode: 'edit',
    find: "console.error(err); throw err; }",
    replace: "logHardFailureAudit({ code: err.code }); throw err; }",
  }]);
  const flags = checkRevertsAPriorFix(implementResponse, dir);
  assert.deepEqual(flags, []);
});

test('checkRevertsAPriorFix does not flag a revert of a commit with no AC-\\d+ marker (ordinary iteration, not undoing a confirmed fix)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-revert-noac-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  const filePath = path.join(dir, 'sweep.js');
  fs.writeFileSync(filePath, "const x = 1;\n");
  execFileSync('git', ['add', 'sweep.js'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  fs.writeFileSync(filePath, "const x = 2;\n");
  execFileSync('git', ['add', 'sweep.js'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'just bump the constant, no AC marker here'], { cwd: dir });

  const implementResponse = JSON.stringify([{ file: 'sweep.js', mode: 'edit', find: 'const x = 2;', replace: 'const x = 1;' }]);
  const flags = checkRevertsAPriorFix(implementResponse, dir);
  assert.deepEqual(flags, []);
});

test('checkRevertsAPriorFix is a no-op (never throws) with no git repo at all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-revert-nogit-'));
  fs.writeFileSync(path.join(dir, 'sweep.js'), 'const x = 1;\n');
  const implementResponse = JSON.stringify([{ file: 'sweep.js', mode: 'edit', find: 'const x = 1;', replace: 'const x = 2;' }]);
  assert.doesNotThrow(() => checkRevertsAPriorFix(implementResponse, dir));
  assert.deepEqual(checkRevertsAPriorFix(implementResponse, dir), []);
});

test('checkRevertsAPriorFix returns [] for non-Group-B implementResponse (Group A markdown, not JSON)', () => {
  const { dir } = makeRevertFixture();
  assert.deepEqual(checkRevertsAPriorFix('Just a markdown writeup, not JSON.', dir), []);
});

test('checkDraft wires revertChecks into its own flags/return shape', () => {
  const { dir } = makeRevertFixture();
  const implementResponse = JSON.stringify([{
    file: 'sweep.js', mode: 'edit',
    find: "console.error(err); throw err; }", replace: "console.error(err); continue; }",
  }]);
  const fc = checkDraft(implementResponse, dir);
  assert.ok(fc.flags.some((f) => f.type === 'reverts-a-prior-fix'));
  assert.equal(fc.revertChecks.length, 1);
});

// --- Symbol-presence warning (HUB0136 1/3): a backtick-quoted identifier cited on the
// same line as a file:line citation should actually appear in the cited file's content.
// WARNING-ONLY by design -- the gate still passes and nothing is stripped; the miss just
// surfaces as a severity:'warning' entry in the result. ---

test('checkFileLineCitations passes the gate AND emits a symbol-not-found-in-cited-file warning when the backtick-quoted symbol is absent from the cited real file', () => {
  const repoRoot = makeRepo(); // src/real-file.js containing only `// real` -- no symbol in it
  const draftText = 'The `ghostSymbol` helper lives at src/real-file.js:1';
  const sourceText = 'grounding: src/real-file.js:1';

  const { unconfirmedCitations, warnings } = checkFileLineCitations(draftText, sourceText, repoRoot, ['src']);
  assert.deepEqual(unconfirmedCitations, [], 'the citation is grounded in sourceText, so the gate passes and nothing is stripped');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'symbol-not-found-in-cited-file');
  assert.equal(warnings[0].identifier, 'ghostSymbol');
  assert.equal(warnings[0].citedFile, 'src/real-file.js');
  assert.equal(warnings[0].severity, 'warning');
});

test('checkFileLineCitations does NOT emit a symbol-not-found-in-cited-file warning when the backtick-quoted symbol is actually present in the cited real file', () => {
  const repoRoot = path.join(__dirname, '..'); // this repo: src/fact-checker.js really defines checkFileLineCitations
  const draftText = 'The `checkFileLineCitations` gate sits at src/fact-checker.js:645';
  const sourceText = 'grounding: src/fact-checker.js:645';

  const { unconfirmedCitations, warnings } = checkFileLineCitations(draftText, sourceText, repoRoot, ['src']);
  assert.deepEqual(unconfirmedCitations, []);
  assert.deepEqual(warnings.filter((w) => w.type === 'symbol-not-found-in-cited-file'), [], 'symbol exists in the file, so no warning');
});

test('checkFileLineCitations strips a line citing scripts/local-worker.sh:414 when sourceText lacks it', () => {
  const draftText = 'The INFRA_FAILURE_PATTERN regex lives at scripts/local-worker.sh:414.';
  const sourceText = 'unrelated grounding material';
  assert.deepEqual(
    checkFileLineCitations(draftText, sourceText).unconfirmedCitations,
    [draftText],
  );
});

test('checkFileLineCitations leaves a line citing src/agentic-draft-common.js:310 intact when sourceText contains it', () => {
  const draftText = 'The worktree helper is at src/agentic-draft-common.js:310.';
  const sourceText = 'See src/agentic-draft-common.js:310 for the helper.';
  assert.deepEqual(
    checkFileLineCitations(draftText, sourceText).unconfirmedCitations,
    [],
  );
});

test('checkFileLineCitations is a no-op for a bare path with no :NNN suffix', () => {
  const draftText = 'The worker script lives in scripts/local-worker.sh.';
  const sourceText = 'whatever';
  assert.deepEqual(
    checkFileLineCitations(draftText, sourceText).unconfirmedCitations,
    [],
  );
});

// --- checkCompletionClaimsInNote: "already in place / already inserted" claims in a
// note are verified against the LIVE repo (file exists, named function exists in it),
// fail-open on read errors, and return one candidate object per claim ---

test('checkCompletionClaimsInNote marks a real file path + real function as found:true', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'real-file.js'),
    'function realHelper(x) {\n  return x + 1;\n}\n',
  );

  const noteText = 'The retry loop and function realHelper in src/real-file.js are already in place, so this is done.';
  const results = checkCompletionClaimsInNote(noteText, dir);
  assert.equal(results.length, 1);
  assert.equal(results[0].found, true);
  assert.match(results[0].evidence, /realHelper.*confirmed/s);
});

test('checkCompletionClaimsInNote resolves a nonexistent path to found:false with an evidence note, without throwing (fail-open)', () => {
  const repoRoot = makeRepo();
  const noteText = 'The helper function ghostFn is already inserted in src/does-not-exist.js, so nothing more is needed.';

  let results;
  assert.doesNotThrow(() => {
    results = checkCompletionClaimsInNote(noteText, repoRoot);
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].found, false);
  assert.equal(typeof results[0].evidence, 'string');
  assert.ok(results[0].evidence.length > 0, 'evidence note should be a non-empty string');
  assert.match(results[0].evidence, /file not found: src\/does-not-exist\.js/);
});

test('checkCompletionClaimsInNote returns [] for empty or undefined noteText', () => {
  const repoRoot = makeRepo();
  assert.deepEqual(checkCompletionClaimsInNote('', repoRoot), []);
  assert.deepEqual(checkCompletionClaimsInNote(undefined, repoRoot), []);
});


// --- create targets read from a unified diff (adhoc implement drafts are a summary + a plain diff, never JSON) -- brain dump #1647 --------
const NEW_FILE_DIFF = [
  'diff --git a/python/dashboard/test_thing.py b/python/dashboard/test_thing.py',
  'new file mode 100644', 'index 0000000..abc1234',
  '--- /dev/null', '+++ b/python/dashboard/test_thing.py', '@@ -0,0 +1,3 @@', '+import unittest', '+class T(unittest.TestCase): pass', '+',
  'diff --git a/src/existing.js b/src/existing.js', 'index 111..222 100644', '--- a/src/existing.js', '+++ b/src/existing.js', '@@ -1 +1 @@', '-a', '+b',
].join('\n');

test('extractDiffCreateTargets reads only the files a diff CREATES: new file mode / --- /dev/null, not modified, deleted or merely mentioned ones', () => {
  assert.deepEqual([...extractDiffCreateTargets(NEW_FILE_DIFF)], ['python/dashboard/test_thing.py']);
  assert.deepEqual([...extractDiffCreateTargets('--- /dev/null\n+++ b/docs/plain.md\n@@ -0,0 +1 @@\n+hi')], ['docs/plain.md'], 'a bare /dev/null pair without a diff --git header');
  const deleted = 'diff --git a/src/old.js b/src/old.js\ndeleted file mode 100644\nindex 1..0\n--- a/src/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-x';
  assert.deepEqual([...extractDiffCreateTargets(deleted)], []);
  assert.deepEqual([...extractDiffCreateTargets('the draft adds a new file mode for src/ghost.js and --- /dev/null style thinking')], [], 'prose is not a diff');
  assert.deepEqual([...extractDiffCreateTargets('')], []);
  const two = NEW_FILE_DIFF + '\ndiff --git a/src/b.js b/src/b.js\nnew file mode 100644\n--- /dev/null\n+++ b/src/b.js\n@@ -0,0 +1 @@\n+x';
  assert.deepEqual([...extractDiffCreateTargets(two)].sort(), ['python/dashboard/test_thing.py', 'src/b.js']);
});

test('extractCreateModeTargets falls back to the diff headers for non-JSON text, and no longer prints a parse warning for it', () => {
  const warned = [];
  const orig = console.warn; console.warn = (...a) => warned.push(a);
  try {
    assert.deepEqual([...extractCreateModeTargets('Summary of the change.\n\n=== DIFF ===\n' + NEW_FILE_DIFF)], ['python/dashboard/test_thing.py']);
    assert.deepEqual([...extractCreateModeTargets('plain prose, no diff')], []);
  } finally { console.warn = orig; }
  assert.deepEqual(warned, []);
  // the JSON Group B path is unchanged
  assert.deepEqual([...extractCreateModeTargets(JSON.stringify([{ mode: 'create', file: 'src/n.js', content: 'x' }]))], ['src/n.js']);
});

test('checkDraft treats a file the diff creates as a create target (no missing-file flag), but still flags a path the draft invents and never creates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'existing.js'), 'a\n');
  const draft = 'Added python/dashboard/test_thing.py (3 tests) and updated src/existing.js; also see src/invented-module.js.\n\nRESOLUTION: implemented\n\n=== DIFF ===\n' + NEW_FILE_DIFF;
  const result = checkDraft(draft, dir);
  const created = result.fileChecks.find((c) => c.claimedPath === 'python/dashboard/test_thing.py');
  assert.equal(created.exists, false, 'the file really is absent from the repo before the diff is applied');
  assert.equal(created.isCreateTarget, true, 'the explanation travels with the raw fileChecks entry the reviewer model reads');
  const missing = result.flags.filter((f) => f.type === 'missing-file').map((f) => f.detail);
  assert.ok(!missing.includes('python/dashboard/test_thing.py'));
  assert.ok(missing.includes('src/invented-module.js'), 'a path the draft invents and the diff never creates is still evidence of fabrication');
  const existing = result.fileChecks.find((c) => c.claimedPath === 'src/existing.js');
  assert.equal(existing.exists, true);
  assert.equal(existing.isCreateTarget, undefined, 'a file the diff only MODIFIES is not a create target');
});

test('checkDraft does not treat a path as created just because the prose says so: no diff header, no create target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-checker-test-'));
  const result = checkDraft('I created python/dashboard/test_thing.py which contains three tests.', dir);
  assert.deepEqual(result.flags.filter((f) => f.type === 'missing-file').map((f) => f.detail), ['python/dashboard/test_thing.py']);
});

test('extractDiffCreateTargets attributes a /dev/null marker to its OWN file header, never to a modified file listed just before it', () => {
  const modifiedFirst = [
    'diff --git a/src/modified.js b/src/modified.js', 'index 1..2 100644', '--- a/src/modified.js', '+++ b/src/modified.js',
    'diff --git a/src/created.js b/src/created.js', 'new file mode 100644', '--- /dev/null', '+++ b/src/created.js', '@@ -0,0 +1 @@', '+x',
  ].join('\n');
  assert.deepEqual([...extractDiffCreateTargets(modifiedFirst)], ['src/created.js']);
});

test('extractDiffCreateTargets finds a newly created BINARY file, which has a new file mode header but no ---/+++ lines', () => {
  const binary = ['diff --git a/assets/logo.png b/assets/logo.png', 'new file mode 100644', 'index 0000000..abc1234', 'GIT binary patch', 'literal 12', 'zcmZ?wbhEHb'].join('\n');
  assert.deepEqual([...extractDiffCreateTargets(binary)], ['assets/logo.png']);
});

// 2026-10-08: fixture URLs the draft itself adds in a TEST file are its own test data, not claims about the repo (TaxHarvest http_get_bytes cache task).
const { urlsOnlyInAddedTestFiles } = require('./fact-checker.js');
const diffOf = (...files) => files.map(([f, lines]) => `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`).join('\n');
const SRC = 'unrelated grounding text with nothing in it';

test('checkGroundedValues: a URL that exists only in added TEST files is exempt; the same URL in a production file, in both, or only in prose is still flagged', () => {
  const testOnly = diffOf(['pkg/tests/test_cache.py', ['url = "http://ex.com/report/a.pdf"']]);
  assert.deepEqual(checkGroundedValues(testOnly, SRC, null, null), []);
  assert.deepEqual([...urlsOnlyInAddedTestFiles(testOnly)], ['http://ex.com/report/a.pdf']);

  const prod = diffOf(['pkg/cache.py', ['URL = "http://ex.com/report/a.pdf"']]);
  assert.deepEqual(checkGroundedValues(prod, SRC, null, null).map((f) => f.detail), ['http://ex.com/report/a.pdf']);

  const both = diffOf(['pkg/cache.py', ['URL = "http://ex.com/report/a.pdf"']], ['pkg/tests/test_cache.py', ['url = "http://ex.com/report/a.pdf"']]);
  assert.deepEqual(checkGroundedValues(both, SRC, null, null).map((f) => f.detail), ['http://ex.com/report/a.pdf'], 'a production file relies on it too');

  assert.deepEqual(checkGroundedValues('The fix fetches http://ex.com/report/a.pdf from the portal.', SRC, null, null).map((f) => f.detail), ['http://ex.com/report/a.pdf'], 'prose only');

  const proseAndTest = `Tests use http://ex.com/page.html.\n${diffOf(['src/foo.test.js', ['const u = "http://ex.com/page.html";']])}`;
  assert.deepEqual(checkGroundedValues(proseAndTest, SRC, null, null), [], 'prose describing the fixture does not veto it');
});

test('test-file recognition covers tests/ dirs, *.test.js/ts, *.spec.*, test_*.py and *_test.py, and nothing else', () => {
  const urlIn = (f) => [...urlsOnlyInAddedTestFiles(diffOf([f, ['x = "http://t.example.org/a"']]))].length;
  for (const f of ['a/tests/x.py', 'a/test/x.js', 'a/__tests__/x.ts', 'a/x.test.js', 'a/x.spec.tsx', 'a/test_x.py', 'a/x_test.py']) assert.equal(urlIn(f), 1, f);
  for (const f of ['a/contest.py', 'a/latest/x.py', 'a/attest.js', 'a/x.js', 'a/testing_notes.md']) assert.equal(urlIn(f), 0, f);
});

test('an ungrounded ALLCAPS field in a test file is still flagged (only URLs are exempt)', () => {
  const d = diffOf(['pkg/tests/test_cache.py', ['x = INVENTED_FIELD_NAME']]);
  assert.deepEqual(checkGroundedValues(d, SRC, null, null).map((f) => f.type), ['ungrounded-field']);
});

// checkGroundedValues: env var the draft's own diff reads -------------------------------------
// 2026-10-18, root-caused live: brain-dump 1890's review was hard-blocked on AGENT_MANAGER_EDIT_FILE_TIERS, an env switch
// the draft itself introduced by READING it (process.env.X) on an added line of an existing file -- the newly-declared
// exemption only knows `NAME =` lines. See extractEnvReadIdentifiers in fact-checker.js.

function envDraft(addedLines, { prose = 'Added a switch.', context = [] } = {}) {
  return [prose, '', '=== DIFF ===', 'diff --git a/src/a.js b/src/a.js', '@@ -1,2 +1,3 @@', ...context, ...addedLines].join('\n');
}

test('checkGroundedValues does not flag an env var read on an added line (JS, Python, shell forms)', () => {
  const { checkGroundedValues, extractEnvReadIdentifiers } = require('./fact-checker.js');
  const cases = [
    "+const on = process.env.AGENT_MANAGER_EDIT_FILE_TIERS === 'on';",
    "+const v = process.env['AGENT_MANAGER_EDIT_FILE_TIERS'];",
    "+v = os.environ['AGENT_MANAGER_EDIT_FILE_TIERS']",
    "+v = os.environ.get('AGENT_MANAGER_EDIT_FILE_TIERS', '')",
    "+v = os.getenv(\"AGENT_MANAGER_EDIT_FILE_TIERS\")",
    '+tiers="${AGENT_MANAGER_EDIT_FILE_TIERS:-off}"',
  ];
  for (const line of cases) {
    const draft = envDraft([line], { prose: 'Set AGENT_MANAGER_EDIT_FILE_TIERS=on to enable it.' });
    assert.deepEqual(checkGroundedValues(draft, 'grounding that predates the switch'), [], line);
    assert.ok(extractEnvReadIdentifiers(draft).has('AGENT_MANAGER_EDIT_FILE_TIERS'), line);
  }
});

test('checkGroundedValues still flags a name only in prose, only on a context or removed line, or as a JS template constant', () => {
  const { checkGroundedValues } = require('./fact-checker.js');
  const flagged = (draft) => checkGroundedValues(draft, 'unrelated grounding').map((f) => f.detail);
  assert.deepEqual(flagged(envDraft(['+const x = 1;'], { prose: 'Set INVENTED_SWITCH_NAME=on.' })), ['INVENTED_SWITCH_NAME']);
  assert.deepEqual(flagged(envDraft(['+const x = 1;'], { prose: 'Uses CONTEXT_SWITCH.', context: [' const c = process.env.CONTEXT_SWITCH;'] })), ['CONTEXT_SWITCH']);
  assert.deepEqual(flagged(envDraft(['+const x = 1;'], { prose: 'Drops REMOVED_SWITCH.', context: ['-const c = process.env.REMOVED_SWITCH;'] })), ['REMOVED_SWITCH']);
  assert.deepEqual(flagged(envDraft(['+const t = `${TEMPLATE_CONST_NAME}`;'])), ['TEMPLATE_CONST_NAME']);
});

// checkGroundedValues: env var read through an injected `env` parameter -----------------------------------------
// 2026-10-19, root-caused live: brain-dump 1896's review was blocked on env.AGENT_MANAGER_TRANSIENT_RETRY, read inside
// `function retryEnabled(env = process.env)` -- the codebase's own idiom. See ENV_READ_RE in fact-checker.js.

test('checkGroundedValues does not flag an env var read through an injected env parameter (JS dot, JS bracket, Python get), prose also naming it', () => {
  const { checkGroundedValues, extractEnvReadIdentifiers } = require('./fact-checker.js');
  for (const line of [
    "+function retryEnabled(env = process.env) { return String(env.AGENT_MANAGER_NEW_SWITCH || '') !== 'off'; }",
    "+  const on = env['AGENT_MANAGER_NEW_SWITCH'] === 'on';",
    '+  const on = env["AGENT_MANAGER_NEW_SWITCH"];',
    "+    v = env.get('AGENT_MANAGER_NEW_SWITCH', '')",
  ]) {
    const draft = envDraft([line], { prose: 'Set AGENT_MANAGER_NEW_SWITCH=off to disable it.' });
    assert.deepEqual(checkGroundedValues(draft, 'grounding that predates the switch'), [], line);
    assert.ok(extractEnvReadIdentifiers(draft).has('AGENT_MANAGER_NEW_SWITCH'), line);
  }
});

test('checkGroundedValues still flags a name that only looks env-like: myenv.NAME, prose, context or removed lines, a JS template constant', () => {
  const { checkGroundedValues } = require('./fact-checker.js');
  const flagged = (draft) => checkGroundedValues(draft, 'unrelated grounding').map((f) => f.detail);
  assert.deepEqual(flagged(envDraft(['+const v = myenv.NOT_AN_ENV_READ;'])), ['NOT_AN_ENV_READ']);
  assert.deepEqual(flagged(envDraft(['+const x = 1;'], { prose: 'Uses PROSE_ONLY_SWITCH.' })), ['PROSE_ONLY_SWITCH']);
  assert.deepEqual(flagged(envDraft(['+const x = 1;'], { prose: 'Uses CONTEXT_ENV_NAME.', context: [' const c = env.CONTEXT_ENV_NAME;'] })), ['CONTEXT_ENV_NAME']);
  assert.deepEqual(flagged(envDraft(['+const x = 1;'], { prose: 'Drops REMOVED_ENV_NAME.', context: ['-const c = env.REMOVED_ENV_NAME;'] })), ['REMOVED_ENV_NAME']);
  assert.deepEqual(flagged(envDraft(['+const t = `${TEMPLATE_CONSTANT_NAME}`;'])), ['TEMPLATE_CONSTANT_NAME']);
});

// checkGroundedValues: fixture token only in an added test file ---------------------------------------
// 2026-10-19, root-caused live: brain-dump 1891's review was blocked on SENTINEL_THOUGHT, a dummy string in its new unit test. The
// gate already exempts a URL that lives only in the draft's own added test files (urlsOnlyInAddedTestFiles); fields had no such rule.

function twoFileDraft({ testPath, testLine, prodLine = null, prose = 'Added a test.' }) {
  const out = [prose, '', '=== DIFF ===', `diff --git a/${testPath} b/${testPath}`, '@@ -1,1 +1,2 @@', ' const a = 1;', testLine];
  if (prodLine) out.push('diff --git a/src/thing.js b/src/thing.js', '@@ -1,1 +1,2 @@', ' const b = 2;', prodLine);
  return out.join('\n');
}

test('checkGroundedValues does not flag an ALL_CAPS token inside a string literal on an added test-file line, even if prose mentions it (js, py, ts paths)', () => {
  const { checkGroundedValues, fieldsOnlyInAddedTestFiles } = require('./fact-checker.js');
  for (const [testPath, name, testLine] of [
    ['src/audit.test.js', 'SENTINEL_THOUGHT', "+  const text = 'SENTINEL_THOUGHT '.repeat(500);"],
    ['python/dashboard/test_viewer.py', 'FIXTURE_ROW_KEY', '+    row = {"FIXTURE_ROW_KEY": 1}'],
    ['tests/unit/thing.spec.ts', 'TS_FIXTURE_NAME', '+  expect(f(`TS_FIXTURE_NAME`)).toBe(1);'],
  ]) {
    const draft = twoFileDraft({ testPath, testLine, prose: `The test uses ${name} as a stand-in.` });
    assert.deepEqual(checkGroundedValues(draft, 'grounding that predates the test'), [], testPath);
    assert.ok(fieldsOnlyInAddedTestFiles(draft).has(name), testPath);
  }
});

test('checkGroundedValues keeps flagging a bare identifier in test code, a token also used bare next to its string, and a comment-only mention', () => {
  const { checkGroundedValues } = require('./fact-checker.js');
  const flagged = (draft) => checkGroundedValues(draft, 'unrelated grounding').map((f) => f.detail);
  assert.deepEqual(flagged(twoFileDraft({ testPath: 'pkg/tests/test_cache.py', testLine: '+x = INVENTED_FIELD_NAME' })), ['INVENTED_FIELD_NAME'], 'bare reference: a symbol that should exist');
  assert.deepEqual(flagged(twoFileDraft({ testPath: 'src/a.test.js', testLine: "+  use(BARE_AND_STRING, 'BARE_AND_STRING');" })), ['BARE_AND_STRING'], 'also used bare on the same line');
  assert.deepEqual(flagged(twoFileDraft({ testPath: 'src/a.test.js', testLine: '+  // checks COMMENT_ONLY_NAME' })), ['COMMENT_ONLY_NAME'], 'a comment is not test data');
});

test('checkGroundedValues still flags the token when it is also on an added production line, only in prose, or only on a context or removed test line', () => {
  const { checkGroundedValues } = require('./fact-checker.js');
  const flagged = (draft) => checkGroundedValues(draft, 'unrelated grounding').map((f) => f.detail);
  assert.deepEqual(flagged(twoFileDraft({ testPath: 'src/a.test.js', testLine: "+  const x = 'FIXTURE_TOKEN';", prodLine: "+const y = 'FIXTURE_TOKEN';" })), ['FIXTURE_TOKEN'], 'a production line uses it too');
  assert.deepEqual(flagged(twoFileDraft({ testPath: 'src/a.test.js', testLine: '+  const x = 1;', prose: 'Mentions ONLY_IN_PROSE here.' })), ['ONLY_IN_PROSE']);
  assert.deepEqual(flagged(twoFileDraft({ testPath: 'src/a.test.js', testLine: ' const CONTEXT_FIXTURE = 1;', prose: 'Uses CONTEXT_FIXTURE.' })), ['CONTEXT_FIXTURE']);
  assert.deepEqual(flagged(twoFileDraft({ testPath: 'src/a.test.js', testLine: '-const REMOVED_FIXTURE = 1;', prose: 'Drops REMOVED_FIXTURE.' })), ['REMOVED_FIXTURE']);
});

// checkGroundedValues: vendored third-party files ----------------------------------------------------
// 2026-10-24: vendoring dockview-core (a 540 KB minified library) was hard-blocked on hundreds of constants and URLs that belong to the library, not to
// the draft. The vendored file's own section is not scanned; everything else in the same diff still is.

const LIB_LINES = ['init(ENABLE_TRACKING, MEMORY_LEAK_WATCHER, "http://www.w3.org/2000/svg");'];

test('a vendored library file\'s own constants and URLs are not flagged', () => {
  for (const f of ['static/vendor/dockview.js', 'third_party/lib/x.js', 'node_modules/pkg/index.js', 'static/app.min.js', 'static/app.min.css', 'vendored/a.js']) {
    assert.deepEqual(checkGroundedValues(diffOf([f, LIB_LINES]), SRC, null, null), [], f);
  }
});

test('the same constants and URLs in a non-vendored file are still flagged', () => {
  const flags = checkGroundedValues(diffOf(['static/app.js', LIB_LINES]), SRC, null, null).map((f) => f.detail).sort();
  assert.deepEqual(flags, ['ENABLE_TRACKING', 'MEMORY_LEAK_WATCHER', 'http://www.w3.org/2000/svg']);
  // a name that merely contains the word is not a vendor directory
  assert.equal(checkGroundedValues(diffOf(['src/vendorize.js', LIB_LINES]), SRC, null, null).length, 3);
  assert.equal(checkGroundedValues(diffOf(['src/vendor.js', LIB_LINES]), SRC, null, null).length, 3);
  assert.equal(checkGroundedValues(diffOf(['src/myvendor/a.js', LIB_LINES]), SRC, null, null).length, 3, 'the directory name must be exactly vendor');
  assert.equal(checkGroundedValues(diffOf(['src/app.min.json', LIB_LINES]), SRC, null, null).length, 3);
});

test('a vendored file does not hide a fabricated value in another file of the same diff, or in prose', () => {
  const both = diffOf(['static/vendor/lib.js', LIB_LINES], ['README.md', ['Fetched from http://invented-host.test/x and uses FABRICATED_FIELD_X.']]);
  assert.deepEqual(checkGroundedValues(both, SRC, null, null).map((f) => f.detail).sort(), ['FABRICATED_FIELD_X', 'http://invented-host.test/x']);
  const prose = 'Cites http://made-up.test/a and MADE_UP_FIELD.\n\n=== DIFF ===\n' + diffOf(['static/vendor/lib.js', LIB_LINES]);
  assert.deepEqual(checkGroundedValues(prose, SRC, null, null).map((f) => f.detail).sort(), ['MADE_UP_FIELD', 'http://made-up.test/a']);
});

test('stripVendoredDiffSections blanks only the vendored sections and keeps line positions', () => {
  const d = diffOf(['a.js', ['one']], ['static/vendor/b.js', ['two', 'three']], ['c.js', ['four']]);
  const out = stripVendoredDiffSections(d).split('\n');
  assert.equal(out.length, d.split('\n').length);
  assert.ok(out.join('\n').includes('+one') && out.join('\n').includes('+four'));
  assert.ok(!out.join('\n').includes('+two') && !out.join('\n').includes('+three'));
  assert.equal(stripVendoredDiffSections(undefined), '');
});

// stripUnchangedDiffLines: the diff block ends at the first line that cannot belong to a hunk (CHANGE_REVIEW AC-83) -----------------
// A fabricated URL in prose AFTER the diff used to ride along as "still inside the diff" and was never scanned. A blank line INSIDE a hunk is a
// context line whose trailing space was stripped (common in model-written diffs) and must not end the block, or the unchanged context URLs after it
// are flagged (the false positive 69f0a4b fixed).

const FABRICATED_URL = 'https://totally-invented-service.example-real-tld.com/api';
const SOURCE_WITHOUT_URLS = 'Plain grounding text with no URLs in it.';

test('a fabricated URL in prose AFTER a diff block is flagged', () => {
  const draft = ['Summary.', '', 'diff --git a/src/a.js b/src/a.js', '@@ -1,2 +1,3 @@', ' const a = 1;', '+const b = 2;', '', `Afterwards call ${FABRICATED_URL} to confirm.`].join('\n');
  assert.deepEqual(checkGroundedValues(draft, SOURCE_WITHOUT_URLS), [{ type: 'ungrounded-url', detail: FABRICATED_URL }]);
});

test('a bullet, a tab-indented line or plain prose after the diff also ends the block, so a URL in it is flagged', () => {
  for (const after of [`* see ${FABRICATED_URL}`, `\tsee ${FABRICATED_URL}`, `Note: ${FABRICATED_URL}`]) {
    const draft = ['diff --git a/src/a.js b/src/a.js', '@@ -1 +1,2 @@', ' const a = 1;', '+const b = 2;', after].join('\n');
    const flags = checkGroundedValues(draft, SOURCE_WITHOUT_URLS);
    assert.deepEqual(flags.map((f) => f.detail), [FABRICATED_URL], after);
  }
});

test('a stripped-space blank context line inside a hunk does not end the block: later unchanged context URLs are not flagged', () => {
  const draft = ['diff --git a/src/a.js b/src/a.js', '@@ -1,4 +1,5 @@', ' const first = "https://old.zzctx1.io/a";', '', ' const second = "https://old.zzctx2.io/b";', '+const added = 1;'].join('\n');
  assert.deepEqual(checkGroundedValues(draft, SOURCE_WITHOUT_URLS), []);
});

test('removed and context URLs inside the diff are still never flagged, and an added URL still is', () => {
  const draft = ['diff --git a/src/a.js b/src/a.js', '@@ -1,3 +1,3 @@', ' const keep = "https://ctx.zzctx3.io/c";', '-const gone = "https://removed.zzrem.io/d";', `+const fresh = "${FABRICATED_URL}";`].join('\n');
  assert.deepEqual(checkGroundedValues(draft, SOURCE_WITHOUT_URLS).map((f) => f.detail), [FABRICATED_URL]);
});

test('once prose ends the diff block, later lines are prose too: an indented URL line after a prose line is flagged', () => {
  const draft = ['diff --git a/src/a.js b/src/a.js', '@@ -1 +1,2 @@', ' const a = 1;', '+const b = 2;', 'That is the change.', `  details at ${FABRICATED_URL}`].join('\n');
  assert.deepEqual(checkGroundedValues(draft, SOURCE_WITHOUT_URLS).map((f) => f.detail), [FABRICATED_URL]);
});
