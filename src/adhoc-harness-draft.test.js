'use strict';

// Unit tests for adhoc-harness-draft.js's harness-search-first tier. Uses a real throwaway
// git repo + bare origin (same fixture pattern as adhoc-agentic-draft.test.js/
// group-b-worktree-diff.test.js) since a successful outcome needs a real Group-B-to-diff
// capture; localCall is faked throughout (no real Ollama call).

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function makeRepoWithOrigin() {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-harness-test-origin-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-harness-test-repo-'));
  git(['init', '--bare', '-b', 'main', bareDir]);
  git(['clone', bareDir, repoDir]);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'widget.js'), 'const RATE = 1.0;\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
  git(['push', 'origin', 'main'], repoDir);
  return { repoDir };
}

function withFixtureRepo(fn) {
  const { repoDir } = makeRepoWithOrigin();
  process.env.AGENT_MANAGER_REPO_ROOT = repoDir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoDir;
  process.env.AGENT_MANAGER_GREP_DIRS = 'src';
  process.env.LOCAL_MODEL = 'test-local-model';
  delete require.cache[require.resolve('./config.js')];
  delete require.cache[require.resolve('./adhoc-harness-draft.js')];
  const { draftAdhocViaHarnessSearch } = require('./adhoc-harness-draft.js');
  return fn(draftAdhocViaHarnessSearch, repoDir);
}

function makeTask(overrides = {}) {
  return {
    id: 'test-1',
    domain: 'adhoc',
    source: 'manual',
    title: 'Bump RATE in widget.js',
    promptContext: { rawText: 'Change RATE from 1.0 to 1.05 in widget.js' },
    ...overrides,
  };
}

test('applied:false with no queries proposed (degenerate plan) -- leaves task untouched', async () => {
  await withFixtureRepo(async (draftAdhocViaHarnessSearch) => {
    const task = makeTask();
    const localCall = async () => ({ response: 'not sure what to search for', degenerate: 'empty', attempts: 1 });
    const result = await draftAdhocViaHarnessSearch(task, { localCall });
    assert.equal(result.applied, false);
    assert.equal(result.succeeded, true);
    assert.equal(task.rawDiff, undefined);
  });
});

test('applied:false when harness-search finds zero real matches -- never even calls implement', async () => {
  await withFixtureRepo(async (draftAdhocViaHarnessSearch) => {
    const task = makeTask();
    let calls = 0;
    const localCall = async () => {
      calls++;
      return { response: 'QUERY: totally_nonexistent_symbol_xyz', degenerate: null, attempts: 1 };
    };
    const result = await draftAdhocViaHarnessSearch(task, { localCall });
    assert.equal(result.applied, false);
    assert.match(result.reason, /no real matches/);
    assert.equal(calls, 1, 'implement pass must not be called when there are zero hits');
  });
});

test('applied:true, resolution=implemented -- a real Group-B diff gets captured and stamped', async () => {
  await withFixtureRepo(async (draftAdhocViaHarnessSearch, repoDir) => {
    const task = makeTask();
    let call = 0;
    const localCall = async () => {
      call++;
      if (call === 1) return { response: 'QUERY: RATE', degenerate: null, attempts: 1 };
      return {
        response: JSON.stringify({ mode: 'edit', file: 'src/widget.js', find: 'const RATE = 1.0;', replace: 'const RATE = 1.05;' }),
        degenerate: null, attempts: 1,
      };
    };
    const result = await draftAdhocViaHarnessSearch(task, { localCall });
    assert.equal(result.applied, true);
    assert.equal(task.adhocResolution, 'implemented');
    assert.match(task.rawDiff, /-const RATE = 1\.0;/);
    assert.match(task.rawDiff, /\+const RATE = 1\.05;/);
    assert.equal(task.draftModel, 'test-local-model');
    assert.equal(fs.readFileSync(path.join(repoDir, 'src', 'widget.js'), 'utf8'), 'const RATE = 1.0;\n', 'real repo must be untouched');
  });
});

// Regression, 2026-08-24: caught live via a real adhoc task that exhausted both automatic
// reject-retries on this exact path, review correctly rejecting an empty-derived "no code
// change was needed" verdict both times -- adhocHarnessSearchImplementPrompt's own text
// (prompts.js) tells the model an empty response means "not confident enough to ground a
// change... a deeper investigation pass will take over next," not "this is my final
// answer." An empty response here must fall through to the next tier, the same as the
// zero-hits case, never a terminal no-changes-needed verdict on its own.
test('applied:false when the implement pass returns an empty response -- falls through to the next tier, not a terminal no-changes-needed', async () => {
  await withFixtureRepo(async (draftAdhocViaHarnessSearch) => {
    const task = makeTask();
    let call = 0;
    const localCall = async () => {
      call++;
      if (call === 1) return { response: 'QUERY: RATE', degenerate: null, attempts: 1 };
      return { response: '', degenerate: null, attempts: 1 };
    };
    const result = await draftAdhocViaHarnessSearch(task, { localCall });
    assert.equal(result.applied, false);
    assert.equal(result.succeeded, true);
    assert.match(result.reason, /insufficient grounding/);
    assert.equal(task.adhocResolution, undefined, 'task must be left untouched so the next tier starts clean');
    assert.equal(task.implementResponse, undefined);
  });
});

test('applied:false when the implement pass signals it needs deeper investigation (NON_IMPL_PATTERNS)', async () => {
  await withFixtureRepo(async (draftAdhocViaHarnessSearch) => {
    const task = makeTask();
    let call = 0;
    const localCall = async () => {
      call++;
      if (call === 1) return { response: 'QUERY: RATE', degenerate: null, attempts: 1 };
      return { response: 'Let me read the rest of the file to understand this fully.', degenerate: null, attempts: 1 };
    };
    const result = await draftAdhocViaHarnessSearch(task, { localCall });
    assert.equal(result.applied, false);
    assert.match(result.reason, /deeper investigation/);
  });
});

test('applied:false when the implement pass produces a Group-B diff that fails to apply (bad find string)', async () => {
  await withFixtureRepo(async (draftAdhocViaHarnessSearch) => {
    const task = makeTask();
    let call = 0;
    const localCall = async () => {
      call++;
      if (call === 1) return { response: 'QUERY: RATE', degenerate: null, attempts: 1 };
      return { response: JSON.stringify({ mode: 'edit', file: 'src/widget.js', find: 'this text does not exist', replace: 'x' }), degenerate: null, attempts: 1 };
    };
    const result = await draftAdhocViaHarnessSearch(task, { localCall });
    assert.equal(result.applied, false);
    assert.match(result.reason, /did not apply cleanly/);
    assert.equal(task.rawDiff, undefined, 'a failed attempt must not leave partial state on the task');
  });
});
