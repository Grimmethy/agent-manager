'use strict';

// Unit tests for get-grounding-source.js -- assembles the review-time "grounding source"
// text. New coverage (2026-08-24, "Fix the grounding gap"): the live current-repo
// enrichment for adhoc tasks, added after a real false-reject -- a decompose sub-task
// correctly described src/model-stats-client.js's real recordCall() signature, but got
// rejected as "unverified" because the task's own promptContext was a stale, task-
// creation-time snapshot that never captured that file (or captured a different one).
//
// Run: node --test src/get-grounding-source.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// get-grounding-source.js's own require-time ensureRegistered() (config.js) throws if
// AGENT_MANAGER_REPO_ROOT is unset -- same throwaway-value convention review-task.test.js/
// apply-task.test.js already use for the identical requirement. Forced (not `||`-defaulted)
// unconditionally -- see apply-task.test.js's own comment on this exact line for why an
// ambient real AGENT_MANAGER_REPO_ROOT must never be allowed to leak into a test run.
process.env.AGENT_MANAGER_REPO_ROOT = os.tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;

const { extractLiveRepoGrounding, refreshFetchedFileContent } = require('./get-grounding-source.js');

function makeRepoWithFile(relPath, content) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-repo-'));
  const full = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return repoRoot;
}

test('extractLiveRepoGrounding fetches the current real content of a file the draft references', () => {
  const repoRoot = makeRepoWithFile('src/foo.js', 'module.exports = { bar: 1 };\n');
  const found = extractLiveRepoGrounding('This claims src/foo.js exports { bar: 1 }.', repoRoot);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'src/foo.js');
  assert.equal(found[0].content, 'module.exports = { bar: 1 };\n');
});

test('extractLiveRepoGrounding skips a path-shaped string that is not a real file, without throwing', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-repo-'));
  const found = extractLiveRepoGrounding('References src/does-not-exist.js somewhere.', repoRoot);
  assert.equal(found.length, 0);
});

test('extractLiveRepoGrounding refuses a path that would resolve outside repoRoot', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-repo-'));
  // Must actually match REPO_FILE_PATH_RE (real extension, starts with an allowed root
  // dir) to exercise the traversal guard at all -- a shape the regex itself already
  // rejects (e.g. no matching extension) would pass this test for the wrong reason.
  const found = extractLiveRepoGrounding('src/../../../../etc/passwd.md', repoRoot);
  assert.equal(found.length, 0);
});

test('extractLiveRepoGrounding truncates a file over the per-file char cap', () => {
  const big = 'x'.repeat(5000);
  const repoRoot = makeRepoWithFile('src/big.js', big);
  const found = extractLiveRepoGrounding('mentions src/big.js', repoRoot);
  assert.equal(found.length, 1);
  assert.ok(found[0].content.length < 5000);
  assert.match(found[0].content, /\.\.\.\[truncated\]$/);
});

test('extractLiveRepoGrounding caps the number of files fetched', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-repo-'));
  fs.mkdirSync(path.join(repoRoot, 'src'));
  const names = [];
  for (let i = 0; i < 8; i++) {
    const name = `src/file${i}.js`;
    fs.writeFileSync(path.join(repoRoot, name), `// file ${i}\n`);
    names.push(name);
  }
  const found = extractLiveRepoGrounding(names.join(' '), repoRoot);
  assert.equal(found.length, 5);
});

test('extractLiveRepoGrounding returns nothing when repoRoot is not provided (fails open, does not throw)', () => {
  assert.deepEqual(extractLiveRepoGrounding('mentions src/foo.js', null), []);
});

test('extractLiveRepoGrounding matches python/scripts/docs paths too, not just src/', () => {
  const repoRoot = makeRepoWithFile('python/dashboard/app.py', 'x = 1\n');
  const found = extractLiveRepoGrounding('see python/dashboard/app.py for the route', repoRoot);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'python/dashboard/app.py');
});

// Regression, 2026-08-24: reproduces the exact real false-reject this fix was built for --
// a claim about src/model-stats-client.js's real recordCall() signature, correct against
// the actual file, but previously invisible to review-time grounding for an adhoc task.
test('CLI end-to-end: an adhoc task referencing a real repo-tracked file gets it as live grounding, not just the stale promptContext', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-repo-'));
  fs.mkdirSync(path.join(repoRoot, 'src'));
  fs.writeFileSync(
    path.join(repoRoot, 'src', 'model-stats-client.js'),
    "function recordCall({ taskId, stage = 'implement', model, candidates = null, startedAt, latencyMs, result }) {}\n",
  );
  const task = {
    domain: 'adhoc',
    source: 'manual',
    adhocResolution: 'decompose',
    promptContext: { rawText: 'stale, task-creation-time snapshot' },
    implementResponse: "Sub-task 1 claims src/model-stats-client.js's recordCall() takes { taskId, stage, model, candidates, startedAt, latencyMs, result }.",
  };
  const taskPath = path.join(repoRoot, 'task.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));

  const stdout = execFileSync('node', [path.join(__dirname, 'get-grounding-source.js'), taskPath], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_MANAGER_REPO_ROOT: repoRoot, AGENT_MANAGER_PIPELINE_DIR: repoRoot },
  });

  assert.match(stdout, /LIVE current repo content/);
  assert.match(stdout, /--- src\/model-stats-client\.js ---/);
  assert.match(stdout, /candidates = null/);
});

// Regression, 2026-08-24: caught investigating a real blocked task whose draft correctly
// cited `python/dashboard/templates/index.html:882-895` as proof a feature already
// existed -- .html was never in the allowed extension list, so the ONE file that actually
// contained the cited code never got fetched, and review kept rejecting a true
// "no-changes-needed" verdict as unconfirmed even after this whole mechanism had shipped.
test('extractLiveRepoGrounding matches .html and .json files too, not just js/py/sh/md', () => {
  const repoRoot = makeRepoWithFile('python/dashboard/templates/index.html', '<html>real content</html>\n');
  const found = extractLiveRepoGrounding('see python/dashboard/templates/index.html for the UI', repoRoot);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'python/dashboard/templates/index.html');
  assert.match(found[0].content, /real content/);
});

// Same incident, second half of the bug: the OTHER cited file (app.py) DID match the old
// extension list, but flat-truncating from the start of a large file never reached the
// actually-cited line, so the "grounding" was functionally empty for it too.
test('extractLiveRepoGrounding centers the fetched window on a cited line number instead of truncating from the start', () => {
  const lines = [];
  for (let i = 1; i <= 500; i++) lines.push(`line ${i}`);
  lines[398] = 'line 399: the actually relevant route lives here, THE_MARKER';
  const repoRoot = makeRepoWithFile('python/dashboard/app.py', lines.join('\n'));

  const found = extractLiveRepoGrounding('see python/dashboard/app.py:399-405 for the route', repoRoot);

  assert.equal(found.length, 1);
  assert.match(found[0].content, /THE_MARKER/, 'the cited line must actually be present, not truncated away');
  assert.match(found[0].content, /showing lines/);
});

test('extractLiveRepoGrounding falls back to flat truncation from the start when no line number is cited', () => {
  const repoRoot = makeRepoWithFile('python/dashboard/app.py', 'x'.repeat(5000));
  const found = extractLiveRepoGrounding('mentions python/dashboard/app.py with no line ref', repoRoot);
  assert.equal(found.length, 1);
  assert.doesNotMatch(found[0].content, /showing lines/);
  assert.match(found[0].content, /\.\.\.\[truncated\]$/);
});

// Regression, 2026-08-25: root-caused live -- a real blocked task added new constants
// around line 2478 of a ~4700-line index.html, but its own prose summary ("Only
// index.html changed, as expected") carried no `file:line` citation, so the flat-
// truncation fallback above fetched only the file's first 4000 characters -- nowhere near
// the real change -- and the fact-checker correctly-per-its-own-logic flagged the new
// constants as "not found in source". A real unified diff's own `@@ -a,b +c,d @@` hunk
// header already states exactly which lines changed; this must be used to center the
// window even when the prose summary cites nothing.
test('extractLiveRepoGrounding centers the window on a real diff hunk header when the prose summary cites no line number', () => {
  const lines = [];
  for (let i = 1; i <= 4700; i++) lines.push(`line ${i}`);
  lines[2477] = 'line 2478: const JOB_TYPE_FAMILIES = [...], THE_MARKER';
  const repoRoot = makeRepoWithFile('python/dashboard/templates/index.html', lines.join('\n'));

  const draftText = [
    'Only index.html changed, as expected for a pure UI grouping change.',
    '',
    'RESOLUTION: implemented',
    '',
    '=== DIFF ===',
    'diff --git a/python/dashboard/templates/index.html b/python/dashboard/templates/index.html',
    'index eee803d..05dc767 100644',
    '--- a/python/dashboard/templates/index.html',
    '+++ b/python/dashboard/templates/index.html',
    '@@ -2475,6 +2475,26 @@ const JOB_TYPES = [',
    '+const JOB_TYPE_FAMILIES = [',
  ].join('\n');

  const found = extractLiveRepoGrounding(draftText, repoRoot);

  assert.equal(found.length, 1);
  assert.match(found[0].content, /THE_MARKER/, 'the real diff region must be fetched, not the file\'s first 4000 chars');
  assert.match(found[0].content, /showing lines/);
});

test('extractLiveRepoGrounding prefers a real prose citation over a diff hunk header when both are present', () => {
  const lines = [];
  for (let i = 1; i <= 4700; i++) lines.push(`line ${i}`);
  lines[98] = 'line 99: MARKER_FROM_PROSE_CITATION';
  const repoRoot = makeRepoWithFile('python/dashboard/templates/index.html', lines.join('\n'));

  const draftText = [
    'see python/dashboard/templates/index.html:99 for the real change',
    '',
    '=== DIFF ===',
    'diff --git a/python/dashboard/templates/index.html b/python/dashboard/templates/index.html',
    '@@ -2475,6 +2475,26 @@ const JOB_TYPES = [',
    '+const JOB_TYPE_FAMILIES = [',
  ].join('\n');

  const found = extractLiveRepoGrounding(draftText, repoRoot);

  assert.equal(found.length, 1);
  assert.match(found[0].content, /MARKER_FROM_PROSE_CITATION/, 'an explicit prose citation must win over the diff hunk fallback');
});

test('extractLiveRepoGrounding keeps the first real line reference when the same file is cited more than once', () => {
  const lines = [];
  for (let i = 1; i <= 500; i++) lines.push(`line ${i}`);
  lines[198] = 'line 199: MARKER_A';
  const repoRoot = makeRepoWithFile('python/dashboard/app.py', lines.join('\n'));

  const found = extractLiveRepoGrounding('see python/dashboard/app.py:199 and also python/dashboard/app.py generally', repoRoot);

  assert.equal(found.length, 1);
  assert.match(found[0].content, /MARKER_A/);
});

// promptContext.fetchedFiles -----------------------------------------------------------
// 2026-08-27, root-caused live via 3 real blocked observability_fix candidates (AC-3,
// AC-4, AC-11): nextCandidateFulfillmentTask() (task-sources.js) populates
// promptContext.fetchedFiles -- {path, content} pairs holding each named file's real
// current content, the exact material local-draft.js grounds its find/replace edits
// against -- but this file never read that field at all, so review's fact-check had
// NOTHING to confirm a candidate-fulfillment draft's claims against. Confirmed live: a
// draft correctly quoted budget-monitor.js's real `const os = require('os');` verbatim
// and got rejected as "the grounding source ... do[es] not confirm this specific line
// exists" -- root-level files (budget-monitor.js has no src/python/scripts/docs/ prefix)
// are hit hardest, since extractLiveRepoGrounding's own live-fetch fallback can't reach
// them either (REPO_FILE_PATH_RE requires that prefix) and the fallback only runs for
// domain:'adhoc' tasks in the first place, never candidate-fulfillment sources like
// observability_fix.
test('CLI end-to-end: a candidate-fulfillment task\'s promptContext.fetchedFiles is included as real grounding', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-repo-'));
  const task = {
    domain: 'default',
    source: 'observability_fix',
    promptContext: {
      candidateId: 'AC-4',
      title: 'Silent JSON-parse skip in budget-monitor leaves total data-source failure undetectable',
      files: ['budget-monitor.js'],
      fetchedFiles: [{ path: 'budget-monitor.js', content: "const os = require('os');\n\nlet parseFailures = 0;\n" }],
      body: 'candidate doc problem/solution text',
    },
    implementResponse: JSON.stringify([{ mode: 'edit', file: 'budget-monitor.js', find: "const os = require('os');", replace: "const os = require('os');\n\nlet parseFailures = 0;" }]),
  };
  const taskPath = path.join(repoRoot, 'task.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));

  const stdout = execFileSync('node', [path.join(__dirname, 'get-grounding-source.js'), taskPath], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_MANAGER_REPO_ROOT: repoRoot, AGENT_MANAGER_PIPELINE_DIR: repoRoot },
  });

  assert.match(stdout, /const os = require\('os'\);/, 'fetchedFiles\' real content must reach the grounding text review\'s fact-check runs against');
});

// 2026-08-27, root-caused live from a real "pipeline was running smoothly until we merged
// 9 branches, now everything is going to blocked" report: candidate-fulfillment grounding
// used to trust fetchedFiles' frozen creation-time content verbatim. When a sibling
// candidate branch touching the same file merged in after the snapshot was taken, review
// kept fact-checking a still-in-flight task against pre-merge content -- see
// observability-fix-ac-3's real retry history for the incident this closes.
test('refreshFetchedFileContent re-reads each path\'s current content from repoRoot instead of trusting the frozen snapshot', () => {
  const repoRoot = makeRepoWithFile('budget-monitor.js', 'const os = require(\'os\');\n\nlet parseFailures = 0;\n');
  const stale = [{ path: 'budget-monitor.js', content: 'const os = require(\'os\');\n' }];

  const refreshed = refreshFetchedFileContent(stale, repoRoot);

  assert.equal(refreshed.length, 1);
  assert.match(refreshed[0].content, /let parseFailures = 0;/, 'must reflect content added by a sibling merge after the snapshot was taken');
});

test('refreshFetchedFileContent falls back to the frozen snapshot when the file has since been deleted/moved', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-repo-'));
  const stale = [{ path: 'gone-now.js', content: 'stale but still useful content' }];

  const refreshed = refreshFetchedFileContent(stale, repoRoot);

  assert.equal(refreshed[0].content, 'stale but still useful content');
});

test('refreshFetchedFileContent returns the input unchanged when repoRoot is not available', () => {
  const stale = [{ path: 'budget-monitor.js', content: 'frozen content' }];
  assert.equal(refreshFetchedFileContent(stale, null), stale);
});

test('refreshFetchedFileContent refuses a path that would resolve outside repoRoot, falling back to the frozen copy', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-repo-'));
  const stale = [{ path: '../../../../etc/passwd', content: 'frozen content' }];

  const refreshed = refreshFetchedFileContent(stale, repoRoot);

  assert.equal(refreshed[0].content, 'frozen content');
});

// CLI end-to-end: confirms main() actually wires the refresh in, not just the unit-level
// helper -- a sibling merge changing budget-monitor.js after fetchedFiles was snapshotted
// must show up in the assembled grounding text review's fact-check runs against.
test('CLI end-to-end: a candidate-fulfillment task\'s grounding reflects a sibling merge that landed after fetchedFiles was snapshotted', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-repo-'));
  fs.writeFileSync(path.join(repoRoot, 'budget-monitor.js'), 'const os = require(\'os\');\n\nlet parseFailures = 0; // added by sibling AC merge\n');
  const task = {
    domain: 'default',
    source: 'observability_fix',
    promptContext: {
      candidateId: 'AC-3',
      fetchedFiles: [{ path: 'budget-monitor.js', content: 'const os = require(\'os\');\n' }],
      body: 'candidate doc problem/solution text',
    },
  };
  const taskPath = path.join(repoRoot, 'task.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));

  const stdout = execFileSync('node', [path.join(__dirname, 'get-grounding-source.js'), taskPath], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_MANAGER_REPO_ROOT: repoRoot, AGENT_MANAGER_PIPELINE_DIR: repoRoot },
  });

  assert.match(stdout, /added by sibling AC merge/, 'grounding must reflect the live file, not the pre-merge snapshot');
});

test('a fetchedFiles entry with no content (a create-target that does not exist yet) is skipped, not thrown on', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-repo-'));
  const task = {
    domain: 'default',
    source: 'observability_fix',
    promptContext: { fetchedFiles: [{ path: 'brand-new-file.js', content: null }], body: 'text' },
  };
  const taskPath = path.join(repoRoot, 'task.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));

  assert.doesNotThrow(() => {
    execFileSync('node', [path.join(__dirname, 'get-grounding-source.js'), taskPath], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_MANAGER_REPO_ROOT: repoRoot, AGENT_MANAGER_PIPELINE_DIR: repoRoot },
    });
  });
});

// --- REQUEST OBJECTS grep block for a no-changes-needed adhoc task (2026-08-30) --------
const { extractRequestObjectTokens } = require('./get-grounding-source.js');

test('extractRequestObjectTokens pulls nouns/identifiers/paths from free request text, drops stopwords', () => {
  const toks = extractRequestObjectTokens('NSFW images should be tagged as such. When NSFW checkbox is not selected, hide NSFW tagged images. See /api/gallery-meta.');
  assert.ok(toks.includes('images'));
  assert.ok(toks.includes('NSFW'));
  assert.ok(toks.some((t) => t.startsWith('/api/gallery')));
  assert.ok(!toks.includes('should') && !toks.includes('when') && !toks.includes('checkbox'));
});

test('a no-changes-needed adhoc task gets a "REQUEST OBJECTS -- current repo state" block grepped live', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-objgrep-'));
  fs.mkdirSync(path.join(repoRoot, 'server'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'server', 'app.py'),
    'def gallery():\n    return list_gallery_pngs()\n\n# nsfw toggle gates prompt data only\n');
  // "images" appears nowhere -> should render as "(no match ...)".

  const task = {
    id: 'adhoc-nc-1', domain: 'adhoc', source: 'manual', adhocResolution: 'no-changes-needed',
    implementResponse: 'Already implemented via the nsfw toggle.\n\nAlready covered:\nnsfw -- server/app.py',
    promptContext: { rawText: 'NSFW images should be tagged as such. When NSFW checkbox is not selected, hide NSFW tagged images.' },
  };
  const taskPath = path.join(repoRoot, 'task.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));

  const stdout = execFileSync('node', [path.join(__dirname, 'get-grounding-source.js'), taskPath], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_MANAGER_REPO_ROOT: repoRoot, AGENT_MANAGER_PIPELINE_DIR: repoRoot, AGENT_MANAGER_GREP_DIRS: 'server' },
  });

  assert.match(stdout, /REQUEST OBJECTS -- current repo state/);
  assert.match(stdout, /"nsfw":[^\n]*server\/app\.py:\d+/i);
  assert.match(stdout, /"images": \(no match/);
});

test('the REQUEST OBJECTS block is NOT added for an ordinary implemented adhoc task', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-noobjgrep-'));
  const task = { id: 'a', domain: 'adhoc', source: 'manual', adhocResolution: 'implemented', implementResponse: 'did it', promptContext: { rawText: 'hide images' } };
  const taskPath = path.join(repoRoot, 'task.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));
  const stdout = execFileSync('node', [path.join(__dirname, 'get-grounding-source.js'), taskPath], {
    encoding: 'utf8', env: { ...process.env, AGENT_MANAGER_REPO_ROOT: repoRoot, AGENT_MANAGER_PIPELINE_DIR: repoRoot },
  });
  assert.doesNotMatch(stdout, /REQUEST OBJECTS/);
});

// --- generic source.groundingFields consumer, end-to-end via main() -------------------
// Every existing CLI-end-to-end test above spawns a bare `node get-grounding-source.js`
// subprocess with no AGENT_MANAGER_REGISTER_PATH set, so `getRegisteredSource(sourceName)`
// only ever resolves a CORE source (task-sources.js's own registrations, none of which
// declare groundingFields today -- that's a hygiene-plugin-only pattern: observability_
// review/performance_review/function_length_review/arch_import_review). So nothing here
// actually exercised the generic `source.groundingFields` -> promptContext.<field> loop
// itself (only register.test.js, in the plugin, asserts a source DECLARES the right
// fields -- nothing proves the consumer actually threads them into the grounding text).
// Close that gap with a throwaway, source-agnostic fake registration, in-process (no
// subprocess needed for this one -- main() is exported).
test('the generic source.groundingFields consumer threads promptContext.<field> into the grounding text for ANY registered source', () => {
  const { registerTaskSource } = require('./task-source-registry.js');
  registerTaskSource('grounding_fields_e2e_fake_source', { priority: 1, next: () => null, groundingFields: ['myGroundingField'] });

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-fields-e2e-'));
  const task = {
    domain: 'default', source: 'grounding_fields_e2e_fake_source',
    promptContext: { myGroundingField: 'UNIQUE_MARKER_GROUNDING_TEXT_9f3a', unrelatedField: 'must not appear' },
  };
  const taskPath = path.join(repoRoot, 'task.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));

  const prevArgv2 = process.argv[2];
  const chunks = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    process.argv[2] = taskPath;
    delete require.cache[require.resolve('./get-grounding-source.js')];
    require('./get-grounding-source.js').main();
  } finally {
    process.stdout.write = realWrite;
    process.argv[2] = prevArgv2;
  }

  const out = chunks.join('');
  assert.match(out, /UNIQUE_MARKER_GROUNDING_TEXT_9f3a/, 'promptContext.myGroundingField must reach the grounding text via source.groundingFields');
});

test('the generic source.groundingFields consumer skips an undeclared promptContext field', () => {
  const { registerTaskSource } = require('./task-source-registry.js');
  registerTaskSource('grounding_fields_e2e_narrow_source', { priority: 1, next: () => null, groundingFields: ['onlyThisOne'] });

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-fields-e2e-narrow-'));
  const task = {
    domain: 'default', source: 'grounding_fields_e2e_narrow_source',
    promptContext: { onlyThisOne: 'INCLUDED_MARKER_7c1e', notDeclared: 'EXCLUDED_MARKER_b2d4' },
  };
  const taskPath = path.join(repoRoot, 'task.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));

  const prevArgv2 = process.argv[2];
  const chunks = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    process.argv[2] = taskPath;
    delete require.cache[require.resolve('./get-grounding-source.js')];
    require('./get-grounding-source.js').main();
  } finally {
    process.stdout.write = realWrite;
    process.argv[2] = prevArgv2;
  }

  const out = chunks.join('');
  assert.match(out, /INCLUDED_MARKER_7c1e/);
  assert.doesNotMatch(out, /EXCLUDED_MARKER_b2d4/, 'a field not listed in groundingFields must not leak into the grounding text via this path');
});
