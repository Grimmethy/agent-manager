'use strict';

// Unit tests for research-agentic-draft.js. claudeCall is faked (no real Claude Code CLI
// call, no real WebSearch/WebFetch) -- simpler than adhoc-agentic-draft.test.js's fixture
// since this module never touches git/a worktree at all.
//
// Run: node --test src/research-agentic-draft.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const { draftResearchImplement, extractGithubRepoUrl } = require('./research-agentic-draft.js');

function fakeRecordModelCall() {
  return 'fake-call-id';
}

test('draftResearchImplement captures the write-up as task.researchDoc, stripping the trailing sentinel', async () => {
  const task = { id: 'test-1', title: 'Research goblinnib.com', promptContext: { rawText: 'investigate goblinnib.com Instagram' } };

  const claudeCall = async () => ({
    response: '# goblinnib\n\nReal findings about the Instagram account.\n\nRESEARCH: completed',
    degenerate: null,
  });

  const result = await draftResearchImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall });

  assert.equal(result.succeeded, true);
  assert.equal(result.blocked, false);
  assert.equal(task.researchResolution, 'completed');
  assert.match(task.researchDoc, /Real findings about the Instagram account\./);
  assert.equal(task.researchDoc.includes('RESEARCH:'), false, 'the sentinel line itself must be stripped from the stored write-up');
  assert.equal(task.implementResponse, task.researchDoc);
});

test('draftResearchImplement blocks (does not fabricate) when the response is RESEARCH: inconclusive', async () => {
  const task = { id: 'test-2', title: 'Research something vague', promptContext: { rawText: 'look into it' } };

  const claudeCall = async () => ({
    response: 'Searches turned up nothing relevant to this vague topic.\n\nRESEARCH: inconclusive',
    degenerate: null,
  });

  const result = await draftResearchImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall });

  assert.equal(result.succeeded, true);
  assert.equal(result.blocked, true);
  assert.match(result.blockedReason, /inconclusive/);
  assert.equal(task.researchDoc, undefined, 'must not stamp researchDoc on an inconclusive outcome');
});

test('draftResearchImplement blocks (does not throw) when the response has no RESEARCH: line', async () => {
  const task = { id: 'test-3', title: 'x', promptContext: { rawText: 'x' } };

  const claudeCall = async () => ({ response: 'I looked into it but forgot the required sentinel.', degenerate: null });

  const result = await draftResearchImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall });

  assert.equal(result.succeeded, true);
  assert.equal(result.blocked, true);
  assert.match(result.blockedReason, /RESEARCH/);
});

test('draftResearchImplement blocks on a degenerate response', async () => {
  const task = { id: 'test-4', title: 'x', promptContext: { rawText: 'x' } };

  const claudeCall = async () => ({ response: '', degenerate: 'empty' });

  const result = await draftResearchImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall });

  assert.equal(result.succeeded, true);
  assert.equal(result.blocked, true);
  assert.match(result.blockedReason, /degenerate/);
});

test('draftResearchImplement returns succeeded:false when the agentic call throws', async () => {
  const task = { id: 'test-5', title: 'x', promptContext: { rawText: 'x' } };

  const claudeCall = async () => { throw new Error('simulated claude -p failure'); };

  const result = await draftResearchImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall });

  assert.equal(result.succeeded, false);
  assert.match(result.reason, /simulated claude -p failure/);
});

test('draftResearchImplement passes WebSearch/WebFetch tool access to the underlying call', async () => {
  const task = { id: 'test-6', title: 'x', promptContext: { rawText: 'x' } };
  let capturedOpts = null;

  const claudeCall = async (opts) => {
    capturedOpts = opts;
    return { response: 'x\n\nRESEARCH: completed', degenerate: null };
  };

  await draftResearchImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall });

  assert.equal(capturedOpts.allowedTools, 'WebSearch,WebFetch');
});

// extractGithubRepoUrl (2026-08-24, Grimmethy: root cause fix for 12 combined failed
// attempts across two "investigate this GitHub repo" tasks -- WebSearch/WebFetch alone
// can never reliably read an arbitrary repo's real source files).
test('extractGithubRepoUrl finds a real github.com repo URL in free text', () => {
  const text = 'Github repo investigation: https://github.com/usestrix/strix Penetration testing for your app.';
  assert.equal(extractGithubRepoUrl(text), 'https://github.com/usestrix/strix');
});

test('extractGithubRepoUrl strips a trailing .git suffix', () => {
  assert.equal(extractGithubRepoUrl('see https://github.com/foo/bar.git for details'), 'https://github.com/foo/bar');
});

test('extractGithubRepoUrl returns null when there is no github.com URL', () => {
  assert.equal(extractGithubRepoUrl('Research project. World Monitor. It should be a github repo.'), null);
});

test('draftResearchImplement grants Read/Grep/Glob and sets cwd when a repo clone succeeds', async () => {
  const task = { id: 'test-7', title: 'x', promptContext: { rawText: 'investigate https://github.com/foo/bar' } };
  let capturedOpts = null;
  let capturedPrompt = null;

  const claudeCall = async (opts) => {
    capturedOpts = opts;
    capturedPrompt = opts.prompt;
    return { response: 'x\n\nRESEARCH: completed', degenerate: null };
  };
  const cloneRepo = (url, taskId) => {
    assert.equal(url, 'https://github.com/foo/bar');
    assert.equal(taskId, 'test-7');
    return '/tmp/fake-clone-dir';
  };

  await draftResearchImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, cloneRepo });

  assert.equal(capturedOpts.allowedTools, 'WebSearch,WebFetch,Read,Grep,Glob');
  assert.equal(capturedOpts.cwd, '/tmp/fake-clone-dir');
  assert.match(capturedPrompt, /cloned for real, read-only/);
  assert.match(capturedPrompt, /\/tmp\/fake-clone-dir/);
});

test('draftResearchImplement falls back to web-only tools when no repo URL is present', async () => {
  const task = { id: 'test-8', title: 'x', promptContext: { rawText: 'no repo here' } };
  let cloneCalled = false;
  const cloneRepo = () => { cloneCalled = true; return '/tmp/should-not-be-used'; };
  const claudeCall = async (opts) => ({ response: 'x\n\nRESEARCH: completed', degenerate: null, _opts: opts });

  const result = await draftResearchImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, cloneRepo });

  assert.equal(cloneCalled, false, 'must never attempt a clone when the task text has no github.com URL');
  assert.equal(result.succeeded, true);
});

test('draftResearchImplement falls back to web-only tools when the clone fails (returns null)', async () => {
  const task = { id: 'test-9', title: 'x', promptContext: { rawText: 'investigate https://github.com/foo/bar' } };
  let capturedOpts = null;
  const cloneRepo = () => null; // simulates a failed clone (private repo, network error, etc.)
  const claudeCall = async (opts) => { capturedOpts = opts; return { response: 'x\n\nRESEARCH: completed', degenerate: null }; };

  await draftResearchImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, cloneRepo });

  assert.equal(capturedOpts.allowedTools, 'WebSearch,WebFetch');
  assert.equal(capturedOpts.cwd, undefined);
});
