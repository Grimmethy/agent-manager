'use strict';

// Unit tests for local-agentic-draft.js's opt-in multi-turn local investigation tier.
// runPlan (the tool-calling engine) is faked throughout (no real Ollama call) -- these
// tests exercise the RESOLUTION-line parsing, opt-in env-var gating, and the real
// Group-B-to-diff capture (same fixture pattern as adhoc-agentic-draft.test.js/
// group-b-worktree-diff.test.js/adhoc-harness-draft.test.js).

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
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agentic-test-origin-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agentic-test-repo-'));
  git(['init', '--bare', '-b', 'main', bareDir]);
  git(['clone', bareDir, repoDir]);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v1\n');
  git(['add', 'tracked.txt'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
  git(['push', 'origin', 'main'], repoDir);
  return { repoDir };
}

function withFixtureRepo(fn) {
  const { repoDir } = makeRepoWithOrigin();
  process.env.AGENT_MANAGER_REPO_ROOT = repoDir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoDir;
  process.env.LOCAL_MODEL = 'test-local-model';
  delete require.cache[require.resolve('./config.js')];
  delete require.cache[require.resolve('./local-agentic-draft.js')];
  const mod = require('./local-agentic-draft.js');
  return fn(mod, repoDir);
}

function makeTask(overrides = {}) {
  return { id: 'test-1', domain: 'adhoc', source: 'manual', title: 'A one-off task', promptContext: { rawText: 'do the thing' }, ...overrides };
}

test('applied:false and untouched when AGENT_MANAGER_LOCAL_AGENTIC_ADHOC is not set', async () => {
  delete process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC;
  await withFixtureRepo(async (mod) => {
    const task = makeTask();
    const runPlan = async () => { throw new Error('must never be called when disabled'); };
    const result = await mod.draftAdhocViaLocalAgentic(task, { runPlan });
    assert.equal(result.applied, false);
    assert.match(result.reason, /not enabled/);
    assert.equal(task.rawDiff, undefined);
  });
});

test('applied:true, resolution=implemented -- a real Group-B diff after RESOLUTION: implemented gets captured', async () => {
  process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC = 'true';
  await withFixtureRepo(async (mod, repoDir) => {
    const task = makeTask();
    const runPlan = async () => ({
      response: 'Investigated tracked.txt.\n\nRESOLUTION: implemented\n\n' + JSON.stringify({ mode: 'edit', file: 'tracked.txt', find: 'v1', replace: 'v2' }),
      toolCallLog: [{ tool: 'read_file' }],
      turnsUsed: 2,
    });
    const result = await mod.draftAdhocViaLocalAgentic(task, { runPlan });
    assert.equal(result.applied, true);
    assert.equal(task.adhocResolution, 'implemented');
    assert.match(task.rawDiff, /-v1/);
    assert.match(task.rawDiff, /\+v2/);
    assert.equal(task.draftModel, 'test-local-model');
    assert.equal(fs.readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v1\n', 'real repo must be untouched');
  });
  delete process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC;
});

test('applied:true, resolution=no-changes-needed', async () => {
  process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC = 'true';
  await withFixtureRepo(async (mod) => {
    const task = makeTask();
    const runPlan = async () => ({ response: 'Checked, already fixed.\n\nRESOLUTION: no-changes-needed', toolCallLog: [], turnsUsed: 1 });
    const result = await mod.draftAdhocViaLocalAgentic(task, { runPlan });
    assert.equal(result.applied, true);
    assert.equal(task.adhocResolution, 'no-changes-needed');
    assert.equal(task.rawDiff, '');
  });
  delete process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC;
});

test('applied:false when the model reports needs-capability-i-dont-have', async () => {
  process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC = 'true';
  await withFixtureRepo(async (mod) => {
    const task = makeTask();
    const runPlan = async () => ({ response: 'This needs running the test suite.\n\nRESOLUTION: needs-capability-i-dont-have', toolCallLog: [], turnsUsed: 3 });
    const result = await mod.draftAdhocViaLocalAgentic(task, { runPlan });
    assert.equal(result.applied, false);
    assert.match(result.reason, /needs a capability/);
    assert.equal(task.rawDiff, undefined);
  });
  delete process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC;
});

test('applied:false when the final response has no RESOLUTION: line at all', async () => {
  process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC = 'true';
  await withFixtureRepo(async (mod) => {
    const task = makeTask();
    const runPlan = async () => ({ response: 'I looked around but forgot to conclude.', toolCallLog: [], turnsUsed: 8 });
    const result = await mod.draftAdhocViaLocalAgentic(task, { runPlan });
    assert.equal(result.applied, false);
    assert.match(result.reason, /did not end with a RESOLUTION/);
  });
  delete process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC;
});

test('applied:false when RESOLUTION: implemented is followed by a diff that fails to apply', async () => {
  process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC = 'true';
  await withFixtureRepo(async (mod) => {
    const task = makeTask();
    const runPlan = async () => ({
      response: 'RESOLUTION: implemented\n\n' + JSON.stringify({ mode: 'edit', file: 'tracked.txt', find: 'nonexistent text', replace: 'x' }),
      toolCallLog: [], turnsUsed: 2,
    });
    const result = await mod.draftAdhocViaLocalAgentic(task, { runPlan });
    assert.equal(result.applied, false);
    assert.match(result.reason, /did not apply cleanly/);
    assert.equal(task.rawDiff, undefined);
  });
  delete process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC;
});

test('applied:false when the engine call itself throws', async () => {
  process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC = 'true';
  await withFixtureRepo(async (mod) => {
    const task = makeTask();
    const runPlan = async () => { throw new Error('Ollama timed out'); };
    const result = await mod.draftAdhocViaLocalAgentic(task, { runPlan });
    assert.equal(result.applied, false);
    assert.equal(result.succeeded, true);
    assert.match(result.reason, /Ollama timed out/);
  });
  delete process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC;
});

test('isEnabled reflects AGENT_MANAGER_LOCAL_AGENTIC_ADHOC exactly', () => {
  delete process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC;
  delete require.cache[require.resolve('./local-agentic-draft.js')];
  assert.equal(require('./local-agentic-draft.js').isEnabled(), false);
  process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC = 'true';
  delete require.cache[require.resolve('./local-agentic-draft.js')];
  assert.equal(require('./local-agentic-draft.js').isEnabled(), true);
  delete process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC;
});

// Structural-capability gap fix, 2026-08-25 -- same incident/reasoning as
// adhoc-harness-draft.js's own identical check: this tier is read-only by design (see
// this file's own header, "the model NEVER gets a direct write_file/edit_file/bash-
// execution tool"), so it can never satisfy a task that requires actually running a
// verification command, regardless of the opt-in flag being on.
test('applied:false immediately, with zero runPlan calls, when the task requires running a verification command (even when enabled)', async () => {
  process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC = 'true';
  await withFixtureRepo(async (mod) => {
    const task = makeTask({
      promptContext: { rawText: 'Add a new module and a test file. Run `python3 -m py_compile` on new files and run the new test module before finishing.' },
    });
    let calls = 0;
    const runPlan = async () => { calls++; return { response: 'RESOLUTION: implemented\n{}' }; };
    const result = await mod.draftAdhocViaLocalAgentic(task, { runPlan });
    assert.equal(result.applied, false);
    assert.match(result.reason, /cannot execute/);
    assert.equal(calls, 0, 'must decline before spending any runPlan call');
  });
  delete process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC;
});
