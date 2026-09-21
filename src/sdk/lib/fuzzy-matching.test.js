'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findFuzzyMatch, MIN_PARTIAL_CHARS } = require('./fuzzy-matching.js');
const { windowFetchedFileContent } = require('./file-grounding.js');

// A realistic big block: 40 distinct lines of code, so any 120+ char piece of it is unique in the file.
const lines = (n, tag = 'a') => Array.from({ length: n }, (_, i) => `  const value${tag}${i} = compute(${tag}, ${i}); // step ${i} of the pipeline`);
const BLOCK = ['function bigBody(opts) {', ...lines(40), '  return done;', '}'].join('\n');
const FILE_PAD_BEFORE = Array.from({ length: 400 }, (_, i) => `const pad${i} = require('./pad-${i}.js'); // unrelated`).join('\n');
const FILE_PAD_AFTER = Array.from({ length: 400 }, (_, i) => `function after${i}() { return ${i}; }`).join('\n');
const fileWith = (block) => `${FILE_PAD_BEFORE}\n${block}\n${FILE_PAD_AFTER}\n`;

test('an exact or whitespace-only match still works exactly as before (no partial marker)', () => {
  const file = fileWith(BLOCK);
  const exact = findFuzzyMatch(file, BLOCK);
  assert.equal(file.slice(exact.index, exact.index + exact.length), BLOCK);
  assert.equal(exact.partial, undefined);
  const reflowed = BLOCK.replace(/  /g, '\t');
  assert.equal(findFuzzyMatch(file, reflowed).partial, undefined, 'whitespace-only drift is the old stripped match');
});

test('a comment added INSIDE the snippet since it was written no longer defeats the match: the prefix locates it', () => {
  const stale = BLOCK.split('\n');
  stale.splice(30, 0, '  // added later: a new comment in the middle of the function');
  const file = fileWith(stale.join('\n'));
  assert.equal(findFuzzyMatch(file, BLOCK) && findFuzzyMatch(file, BLOCK).partial, 'prefix');
  const m = findFuzzyMatch(file, BLOCK);
  assert.ok(file.slice(m.index).trimStart().startsWith('function bigBody(opts) {'), 'points at the start of the function');
});

test('drift at the START of the snippet is found through the suffix, backed up to where the snippet begins', () => {
  const stale = BLOCK.replace('function bigBody(opts) {', 'function bigBody(opts, extraParam) {');
  const file = fileWith(stale);
  const m = findFuzzyMatch(file, BLOCK);
  assert.equal(m.partial, 'suffix');
  assert.ok(Math.abs(m.index - file.indexOf('function bigBody')) < 200, 'the estimated start is near the real function start');
});

test('refuses to guess: a too-short snippet, an ambiguous piece, and unrelated text all return null', () => {
  const file = fileWith(BLOCK);
  assert.equal(findFuzzyMatch(file, 'const x = 1;'.repeat(2) + ' // changed'), null, 'short');
  assert.ok(MIN_PARTIAL_CHARS >= 100);
  // the same 60-line block twice in the file: every piece is ambiguous
  const dup = `${BLOCK}\n${FILE_PAD_BEFORE}\n${BLOCK}`;
  const driftedTail = `${BLOCK.split('\n').slice(0, 41).join('\n')}\n  // drift\n  return other;\n}`;
  assert.equal(findFuzzyMatch(dup, driftedTail), null, 'ambiguous, not guessed');
  assert.equal(findFuzzyMatch(file, lines(40, 'zz').join('\n')), null, 'unrelated');
});

test('windowFetchedFileContent: a stale snippet in a big file is anchored strongly (it fell back to confidence none before)', () => {
  const stale = BLOCK.split('\n');
  stale.splice(20, 0, '  // a comment added after the candidate was written');
  const file = fileWith(stale.join('\n'));
  assert.ok(file.length > 8000, 'premise: the file is large enough to be windowed');
  const w = windowFetchedFileContent(file, `### AC-9 · Decompose bigBody\nFiles: src/x.js\nSnippet:\n\`\`\`\n${BLOCK}\n\`\`\`\n\nProblem: it is long.`);
  assert.equal(w.confidence, 'strong');
  assert.equal(w.usedSnippetFuzzyMatch, true);
  assert.ok(w.text.includes('function bigBody(opts) {'), 'the window contains the target function');
  const none = windowFetchedFileContent(file, '### AC-9 · Decompose\nFiles: src/x.js\nSnippet:\n```\n' + lines(40, 'zz').join('\n') + '\n```\n');
  assert.equal(none.confidence, 'none', 'an unrelated snippet still gets no anchor');
});

// --- a suffix match must not extrapolate the start when the head of the function GREW (function-length-fix-ac-37) -------------------------------------------------------------
// The signature gained a parameter and ~60 lines were inserted right after it, so neither the whole snippet nor its prefix matches; the suffix does, but backing up by the old length of
// the missing head lands far past the real start. Anchoring on the declared function name puts the window on the function.
test('suffix match: when the head of the function drifted AND grew, the start is the declaration, not an extrapolation', () => {
  const grown = BLOCK.split('\n');
  grown[0] = 'function bigBody(opts, extra, third) {';
  grown.splice(1, 0, ...Array.from({ length: 60 }, (_, i) => `  const added${i} = wire(${i}); // a block inserted after the snippet was written`));
  const file = fileWith(grown.join('\n'));
  const m = findFuzzyMatch(file, BLOCK);
  assert.equal(m.partial, 'suffix');
  assert.ok(file.slice(m.index).trimStart().startsWith('function bigBody(opts, extra, third) {'), `anchored at the declaration, got: ${JSON.stringify(file.slice(m.index, m.index + 40))}`);
  const w = windowFetchedFileContent(file, `### AC-37 · Extract\nFiles: src/x.js\nSnippet:\n\`\`\`\n${BLOCK}\n\`\`\`\n`);
  assert.equal(w.confidence, 'strong');
  assert.ok(w.text.includes('function bigBody(opts, extra, third) {'), 'the window contains the function head');
});

test('suffix match: two declarations of the same name -> no guess, the estimate is kept (never picks one of several)', () => {
  const grown = BLOCK.split('\n');
  grown[0] = 'function bigBody(opts, extra) {';
  grown.splice(1, 0, ...Array.from({ length: 60 }, (_, i) => `  const added${i} = wire(${i}); // inserted block`));
  const file = `${FILE_PAD_BEFORE}\nfunction bigBody(other) { return 1; }\n${grown.join('\n')}\n${FILE_PAD_AFTER}\n`;
  const m = findFuzzyMatch(file, BLOCK);
  assert.equal(m.partial, 'suffix');
  assert.ok(!file.slice(m.index).trimStart().startsWith('function bigBody(other)'), 'did not latch onto the wrong declaration');
});

// --- a small-fraction partial match is a guess, and is reported as one (review of PR #436) --------------------------------------------------------------------------------------
// findPartialMatch tries 0.75/0.5/0.35/0.25/0.15 of the snippet. A hit that only matched the 0.25 / 0.15 tier used to come out as confidence 'strong' exactly like a whole-snippet match.
const SNIP_SECTION = (snippet, prose = '') => `### AC-9 · Decompose bigBody\nFiles: src/x.js\nSnippet:\n\`\`\`\n${snippet}\n\`\`\`\n${prose}\nProblem: it is long.`;
// Drift near BOTH ends, so only a short middle piece (well under 30% of the snippet) still matches.
const shortPartialFile = () => {
  const d = BLOCK.split('\n');
  d.splice(8, 0, '  // drift near the start');
  d.splice(d.length - 8, 0, '  // drift near the end');
  return fileWith(d.join('\n'));
};

test('a small-fraction partial match places the window but is weak, with the low-confidence note -- not strong, and not none (a task is not parked for it)', () => {
  const w = windowFetchedFileContent(shortPartialFile(), SNIP_SECTION(BLOCK));
  assert.equal(w.confidence, 'weak');
  assert.equal(w.usedSnippetFuzzyMatch, true);
  assert.match(w.text, /^\[LOW-CONFIDENCE GROUNDING/);
  assert.ok(w.text.includes('const valuea20 ='), 'the window is still centred on the located code, not head-truncated');
});

test('a quoted symbol corroborates a small-fraction partial match, keeping it strong -- whether it lands on the SAME hit (valuea1) or on another part of the code (valuea20)', () => {
  for (const sym of ['valuea1', 'valuea20']) {
    const w = windowFetchedFileContent(shortPartialFile(), SNIP_SECTION(BLOCK, `The function \`${sym}\` is the problem.`));
    assert.equal(w.confidence, 'strong', sym);
  }
});

test('a partial match of at least ~30% of the snippet stays strong (the drift-in-the-middle case above)', () => {
  const stale = BLOCK.split('\n');
  stale.splice(20, 0, '  // a comment added after the candidate was written');
  const w = windowFetchedFileContent(fileWith(stale.join('\n')), SNIP_SECTION(BLOCK));
  assert.equal(w.confidence, 'strong');
});

// --- relocateStaleAnchor: the cited code MOVED to a sibling file (function-length-fix-ac-10) --------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { relocateStaleAnchor } = require('./file-grounding.js');

function movedRepo({ dup = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reloc-'));
  fs.mkdirSync(path.join(root, 'src'));
  const pad = (tag) => Array.from({ length: 300 }, (_, i) => `const ${tag}${i} = ${i}; // padding so the file is above the windowing threshold`).join('\n');
  fs.writeFileSync(path.join(root, 'src', 'old.js'), `${pad('o')}\nfunction stillHere() { return 1; }\n`);          // the cited file: the function is GONE from it
  fs.writeFileSync(path.join(root, 'src', 'moved.js'), `${pad('m')}\n${BLOCK}\n${pad('n')}\n`);                      // where it lives now
  fs.writeFileSync(path.join(root, 'src', 'moved.test.js'), `${BLOCK}\n`);                                             // tests are never a relocation target
  if (dup) fs.writeFileSync(path.join(root, 'src', 'copy.js'), `${pad('c')}\n${BLOCK}\n`);
  fs.writeFileSync(path.join(root, 'src', 'notes.md'), BLOCK);                                                        // other extension: ignored
  fs.writeFileSync(path.join(root, 'src', 'ctx.js'), `${pad('x')}\nfunction unrelated() {}\n`);                        // a big file cited only as context
  return root;
}
const SECTION = `### AC-10 · Decompose bigBody\nFiles: src/old.js\nSnippet:\n\`\`\`\n${BLOCK}\n\`\`\`\n`;

test('relocateStaleAnchor: finds the ONE sibling file the cited code moved to (tests and other extensions ignored)', () => {
  const root = movedRepo();
  const hit = relocateStaleAnchor(root, 'src/old.js', SECTION);
  assert.equal(hit.path, 'src/moved.js');
  assert.ok(hit.content.includes('function bigBody(opts) {'));
});

test('relocateStaleAnchor: ambiguous (two files contain it), missing, no snippet, and a path outside the repo all return null', () => {
  assert.equal(relocateStaleAnchor(movedRepo({ dup: true }), 'src/old.js', SECTION), null, 'two candidates: never guessed');
  const root = movedRepo();
  assert.equal(relocateStaleAnchor(root, 'src/old.js', SECTION.replace(/const value/g, 'const other')), null, 'the code is gone everywhere');
  assert.equal(relocateStaleAnchor(root, 'src/old.js', '### AC-1\nno snippet here'), null);
  assert.equal(relocateStaleAnchor(root, '../../etc/passwd', SECTION), null);
});

test('refreshCandidateFetchedFiles follows a moved target: rewrites the fetched entry and the declared file, marks relocatedFrom, and leaves an audit event', () => {
  const root = movedRepo();
  const prev = process.env.AGENT_MANAGER_REPO_ROOT;
  process.env.AGENT_MANAGER_REPO_ROOT = root;
  delete require.cache[require.resolve('../../config.js')];
  try {
    const { refreshCandidateFetchedFiles } = require('../../local-draft.js');
    const task = { source: 'function_length_fix', history: [], promptContext: { body: SECTION, files: ['src/old.js'], fetchedFiles: [
      { path: 'src/old.js', anchorConfidence: 'none', content: 'stale' },
      { path: 'src/ctx.js', context: true, anchorConfidence: 'none', content: 'ctx' },
    ] } };
    refreshCandidateFetchedFiles(task);
    const f = task.promptContext.fetchedFiles;
    assert.equal(f[0].path, 'src/moved.js');
    assert.equal(f[0].anchorConfidence, 'strong');
    assert.equal(f[0].relocatedFrom, 'src/old.js');
    assert.deepEqual(task.promptContext.files, ['src/moved.js']);
    assert.equal(f[1].path, 'src/ctx.js', 'a context-only file is never relocated');
    assert.ok(task.history.some((h) => h.stage === 'context-refreshed' && /src\/old\.js -> src\/moved\.js/.test(h.detail)));
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prev;
    delete require.cache[require.resolve('../../config.js')];
  }
});

test('relocateStaleAnchor tier 2: code moved into a SUBDIRECTORY (no sibling has it) is found by the top-level subtree search; vendored directories are skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reloc-deep-'));
  const pad = (tag) => Array.from({ length: 300 }, (_, i) => `const ${tag}${i} = ${i}; // padding so the file is above the windowing threshold`).join('\n');
  fs.mkdirSync(path.join(root, 'src', 'routes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), `${pad('a')}\nfunction remaining() {}\n`);          // cited file: the code left
  fs.writeFileSync(path.join(root, 'src', 'routes', 'reports.js'), `${pad('r')}\n${BLOCK}\n`);          // where it lives now
  fs.writeFileSync(path.join(root, 'src', 'node_modules', 'dep', 'vendored.js'), `${BLOCK}\n`);         // must never be a target
  assert.equal(relocateStaleAnchor(root, 'src/app.js', SECTION.replace('src/old.js', 'src/app.js')).path, 'src/routes/reports.js');
  // a SECOND copy in another subdirectory makes tier 2 ambiguous -> null
  fs.mkdirSync(path.join(root, 'src', 'other'));
  fs.writeFileSync(path.join(root, 'src', 'other', 'copy.js'), `${pad('c')}\n${BLOCK}\n`);
  assert.equal(relocateStaleAnchor(root, 'src/app.js', SECTION), null);
});

test('relocateStaleAnchor: an ambiguous sibling tier never escalates to the subtree, and a top-level file has no subtree to search', () => {
  const root = movedRepo({ dup: true }); // two siblings contain it
  fs.mkdirSync(path.join(root, 'src', 'deep'));
  fs.writeFileSync(path.join(root, 'src', 'deep', 'only.js'), `${BLOCK}\n`);
  assert.equal(relocateStaleAnchor(root, 'src/old.js', SECTION), null);
  fs.writeFileSync(path.join(root, 'top.js'), 'x');
  assert.equal(relocateStaleAnchor(root, 'top.js', SECTION), null);
});

// --- the trigger is "the Snippet is missing from the cited file", not a low window confidence ------------------------------------------------------------------------------
const { snippetMissingFrom } = require('./file-grounding.js');

test('snippetMissingFrom: true only when a real source Snippet is absent (a diff-shaped Snippet, no Snippet, or a present one is never "moved")', () => {
  const file = fileWith(BLOCK);
  assert.equal(snippetMissingFrom(file, SECTION), false, 'present');
  assert.equal(snippetMissingFrom(file, SECTION.replace(/const value/g, 'const other')), true, 'absent');
  assert.equal(snippetMissingFrom(file, '### AC-1\nno snippet'), false, 'no Snippet: nothing to say');
  const diffSection = '### AC-2\nSnippet:\n```\ndiff --git a/src/x.js b/src/x.js\n--- a/src/x.js\n+++ b/src/x.js\n@@ -10,3 +10,4 @@ function f() {\n   const a = 1;\n+  const b = 2;\n```\n';
  assert.equal(snippetMissingFrom(file, diffSection), false, 'a unified diff (change_review) says nothing about code moving');
  assert.equal(relocateStaleAnchor(movedRepo(), 'src/old.js', diffSection), null);
});

test('refreshCandidateFetchedFiles relocates even when the cited file still windows (weak/strong, never none) through quoted symbols that occur elsewhere in it (observability-fix-ac-111: abort(404) is all over app.py)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reloc-strong-'));
  fs.mkdirSync(path.join(root, 'app', 'routes'), { recursive: true });
  const pad = (tag) => Array.from({ length: 300 }, (_, i) => `def ${tag}${i}(): abort(404)  # padding handler ${i} with a shared symbol`).join('\n');
  fs.writeFileSync(path.join(root, 'app', 'main.py'), `${pad('m')}\n`);                                   // cited file: still has many abort(404) but NOT the candidate's snippet
  fs.writeFileSync(path.join(root, 'app', 'routes', 'reports.py'), `${pad('r')}\n${BLOCK}\n`);            // where the code lives now
  const prev = process.env.AGENT_MANAGER_REPO_ROOT;
  process.env.AGENT_MANAGER_REPO_ROOT = root;
  delete require.cache[require.resolve('../../config.js')];
  try {
    const { refreshCandidateFetchedFiles } = require('../../local-draft.js');
    const body = `### AC-111 · File-serving exception swallowed by bare \`abort(404)\`\nFiles: app/main.py\nSnippet:\n\`\`\`\n${BLOCK}\n\`\`\`\n\nProblem: the handler calls \`abort(404)\` and never logs the exception.`;
    const { windowFetchedFileContent } = require('./file-grounding.js');
    assert.notEqual(windowFetchedFileContent(fs.readFileSync(path.join(root, 'app', 'main.py'), 'utf8'), body).confidence, 'none', 'premise: the stale file does NOT window to none (a quoted symbol anchors it weakly), so a confidence-none trigger would never fire');
    const task = { source: 'observability_fix', history: [], promptContext: { body, files: ['app/main.py'], fetchedFiles: [{ path: 'app/main.py', anchorConfidence: 'strong', content: 'stale' }] } };
    refreshCandidateFetchedFiles(task);
    assert.equal(task.promptContext.fetchedFiles[0].path, 'app/routes/reports.py');
    assert.deepEqual(task.promptContext.files, ['app/routes/reports.py']);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prev;
    delete require.cache[require.resolve('../../config.js')];
  }
});
