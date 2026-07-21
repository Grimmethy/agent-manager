'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Real bug, reproduced live 2026-07-21: ornith-worker.ps1's arch_import branch builds
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
// ornith-worker.ps1 now force-wraps the PowerShell side with @(...); this test exercises
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
