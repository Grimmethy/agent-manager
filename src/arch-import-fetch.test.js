'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Real bug, reproduced live 2026-07-21: local-worker.ps1's arch_import branch builds
// $importQueries via a regex-match -> ForEach-Object -> Where-Object pipeline. When the
// plan proposes exactly ONE query (an explicitly valid shape -- archImportPlanPrompt asks
// for "1 to 3"), PowerShell silently collapses that single-element pipeline result to a
// plain scalar String before it ever reaches ConvertTo-Json, so `{"queries": ...}` on disk
// is a JSON STRING, not an array. This script's CLI entry point used to pass that straight
// into fetchForQueries's `for (const query of queries)`, which iterates a STRING
// CHARACTER BY CHARACTER -- each single letter then run through grepCodebase() as its own
// "query", exploding into hundreds of meaningless single-character substring matches
// (confirmed: arch-import-autogen-microsoft-1's one-query plan, "pipeline configuration
// module", produced 232 hits tagged query:"p"/"i"/etc against one arbitrary file).
//
// local-worker.ps1 now force-wraps the PowerShell side with @(...); this test exercises
// the OTHER half of the fix -- this script's own defensive coercion at the CLI boundary --
// by feeding it the exact bad shape (a bare string, not an array) a not-yet-fixed or
// future caller could still produce, and proving it no longer degrades into per-character
// iteration.
const REPO_ROOT = path.join(os.tmpdir(), 'arch-import-fetch-test-repo');
const SCRIPT_PATH = path.join(__dirname, 'arch-import-fetch.js');

function setupFixtureRepo() {
  fs.rmSync(REPO_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(REPO_ROOT, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(REPO_ROOT, 'src', 'sample.js'),
    "// a uniqueneedle line\nconst x = 1;\nfunction uniqueneedleFn() {}\n",
  );
}

function runFetch(queriesValue) {
  const queriesPath = path.join(os.tmpdir(), `arch-import-fetch-test-queries-${process.pid}.json`);
  fs.writeFileSync(queriesPath, JSON.stringify({ queries: queriesValue }));
  try {
    const raw = execFileSync('node', [SCRIPT_PATH, queriesPath], {
      env: { ...process.env, AGENT_MANAGER_REPO_ROOT: REPO_ROOT, AGENT_MANAGER_GREP_DIRS: 'src' },
      encoding: 'utf8',
    });
    return JSON.parse(raw);
  } finally {
    fs.rmSync(queriesPath, { force: true });
  }
}

test('CLI entry point does not explode a bare-string queries value into per-character matches', () => {
  setupFixtureRepo();
  try {
    const result = runFetch('uniqueneedle'); // the exact bad shape: a scalar, not ["uniqueneedle"]
    assert.ok(result.hits.length > 0, 'expected the real multi-char term to actually match');
    for (const hit of result.hits) {
      assert.ok(hit.query.length > 1, `hit query should be the whole term, not a single character: got "${hit.query}"`);
      assert.equal(hit.query, 'uniqueneedle');
    }
  } finally {
    fs.rmSync(REPO_ROOT, { recursive: true, force: true });
  }
});

test('CLI entry point still works normally for a real array of queries', () => {
  setupFixtureRepo();
  try {
    const result = runFetch(['uniqueneedle']);
    assert.ok(result.hits.length > 0);
    assert.ok(result.hits.every((h) => h.query === 'uniqueneedle'));
  } finally {
    fs.rmSync(REPO_ROOT, { recursive: true, force: true });
  }
});

// --- in-process fetchForQueries(queries, { roots }) -- multi-repo (2026-09-04) -----------
// First in-process tests of fetchForQueries itself (previously exercised only via the CLI
// subprocess above). Mirrors grep-codebase-tool.test.js's two-fixture-repo pattern for its
// own `root` param tests.

const { fetchForQueries, MAX_CONTENT_CHARS: MAX_CONTENT_CHARS_TEST } = require('./arch-import-fetch.js');

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-import-fetch-inproc-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function withRepoConfig(repoRoot, grepDirs, fn) {
  const prevRoot = process.env.AGENT_MANAGER_REPO_ROOT;
  const prevDirs = process.env.AGENT_MANAGER_GREP_DIRS;
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_GREP_DIRS = grepDirs;
  try {
    return fn();
  } finally {
    if (prevRoot === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prevRoot;
    if (prevDirs === undefined) delete process.env.AGENT_MANAGER_GREP_DIRS; else process.env.AGENT_MANAGER_GREP_DIRS = prevDirs;
  }
}

test('fetchForQueries without roots is byte-identical to the old single-repo behavior', () => {
  const primary = makeRepo({ 'src/a.js': 'function needleFn() { return 1; }\n' });
  withRepoConfig(primary, 'src', () => {
    const result = fetchForQueries(['needleFn']);
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].file, 'src/a.js');
    assert.equal(result.hits[0].root, undefined, 'primary-repo hits carry no root field');
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].root, undefined);
  });
});

test('fetchForQueries({ roots }): a term only findable in the second root surfaces there, tagged', () => {
  const primary = makeRepo({ 'src/a.js': 'const unrelated = 1;\n' });
  const plugin = makeRepo({ 'src/function-length-review.js': 'function registerFunctionLengthFix() { return true; }\n' });
  withRepoConfig(primary, 'src', () => {
    const result = fetchForQueries(['registerFunctionLengthFix'], { roots: [primary, plugin] });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].file, 'src/function-length-review.js');
    assert.equal(result.hits[0].root, fs.realpathSync(plugin));

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, 'src/function-length-review.js');
    assert.equal(result.files[0].root, fs.realpathSync(plugin));
    assert.match(result.files[0].content, /registerFunctionLengthFix/);
  });
});

test('fetchForQueries({ roots }): the primary root still uses its own grepAllowedDirs loop unchanged', () => {
  const primary = makeRepo({ 'src/a.js': 'const sharedTerm = 1;\n', 'docs/x.md': 'sharedTerm mentioned here too' });
  const plugin = makeRepo({});
  withRepoConfig(primary, 'src', () => { // "docs" NOT allowlisted for the primary repo
    const result = fetchForQueries(['sharedTerm'], { roots: [primary, plugin] });
    assert.deepEqual(result.hits.map((h) => h.file), ['src/a.js']);
  });
});

test('fetchForQueries({ roots }): an extra root has no dirs allowlist -- searches the whole repo', () => {
  const primary = makeRepo({ 'src/a.js': 'x' });
  const plugin = makeRepo({ 'python/deep/nested.py': 'plugin_only_term = 1\n' });
  withRepoConfig(primary, 'src', () => {
    const result = fetchForQueries(['plugin_only_term'], { roots: [primary, plugin] });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].file, 'python/deep/nested.py');
  });
});

// 2026-09-19, ghost-in-the-machine retroactive audit of the pipeline_debrief blocked/
// bucket: fetchForQueries used to require a matched file's ENTIRE content to fit the shared
// MAX_CONTENT_CHARS (12000) budget or be skipped outright -- fine for a small utility file,
// but structurally unable to ever include agent-manager's own hot files (review-task.js,
// local-draft.js, task-sources.js, app.py -- all 7-18x that budget on their own). Confirmed
// live: 15 of 28 blocked pipeline_debrief tasks showed real grep hits but 0 files fetched.
test('fetchForQueries windows an oversized matched file around its real hit line instead of skipping it entirely', () => {
  const filler = Array.from({ length: 2000 }, (_, i) => `// filler line ${i}`).join('\n');
  const content = `${filler}\n// uniqueneedle marker here\nconst afterNeedle = 1;\n${filler}\n`;
  assert.ok(content.length > 20000, 'fixture file must clear the whole-budget threshold to exercise windowing');
  const primary = makeRepo({ 'src/huge.js': content });
  withRepoConfig(primary, 'src', () => {
    const result = fetchForQueries(['uniqueneedle']);
    assert.equal(result.hits.length, 1, 'the real grep hit must still be reported');
    assert.equal(result.files.length, 1, 'the oversized file must no longer be skipped entirely');
    assert.match(result.files[0].content, /uniqueneedle marker here/, 'the windowed content must include the actual hit');
    assert.ok(result.files[0].content.length < content.length, 'windowed content must be smaller than the whole file');
  });
});

test('fetchForQueries still windows correctly when the shared budget is split across multiple oversized files', () => {
  const filler = Array.from({ length: 2000 }, (_, i) => `// filler line ${i}`).join('\n');
  const contentA = `${filler}\n// sharedneedle in file A\n${filler}\n`;
  const contentB = `${filler}\n// sharedneedle in file B\n${filler}\n`;
  const primary = makeRepo({ 'src/a.js': contentA, 'src/b.js': contentB });
  withRepoConfig(primary, 'src', () => {
    const result = fetchForQueries(['sharedneedle']);
    assert.equal(result.hits.length, 2);
    assert.equal(result.files.length, 2, 'both oversized files should get a windowed slot, not just the first');
    const totalChars = result.files.reduce((sum, f) => sum + f.content.length, 0);
    assert.ok(totalChars <= MAX_CONTENT_CHARS_TEST, `combined windowed content must respect the shared budget, got ${totalChars}`);
  });
});

test('fetchForQueries({ roots }): a same-named file in two repos is kept as two distinct fetched entries', () => {
  const primary = makeRepo({ 'src/shared.js': 'const primaryVersion = "PRIMARY_MARKER";\n' });
  const plugin = makeRepo({ 'src/shared.js': 'const pluginVersion = "PLUGIN_MARKER";\n' });
  withRepoConfig(primary, 'src', () => {
    const result = fetchForQueries(['MARKER'], { roots: [primary, plugin] });
    assert.equal(result.files.length, 2);
    const contents = result.files.map((f) => f.content).sort();
    assert.match(contents[0], /PLUGIN_MARKER|PRIMARY_MARKER/);
    assert.ok(contents.some((c) => c.includes('PRIMARY_MARKER')));
    assert.ok(contents.some((c) => c.includes('PLUGIN_MARKER')));
  });
});
