'use strict';

// Unit tests for product-spec-agentic-draft.js. claudeCall and cloneRepo are faked (no
// real Claude Code CLI call, no real git clone) -- same shape as
// research-agentic-draft.test.js.
//
// Run: node --test src/product-spec-agentic-draft.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || '/tmp/agent-manager-product-spec-test-repo';
const { draftProductSpecImplement } = require('./product-spec-agentic-draft.js');

function fakeRecordModelCall() {
  return 'fake-call-id';
}

function baseTask(overrides = {}) {
  return {
    id: 'product-spec-bootstrap-1',
    title: 'PromptForge product spec',
    promptContext: {
      requestId: 'bootstrap-1',
      requestText: 'Write the first spec covering the shot spec and the data model.',
      currentSpec: '',
      specExists: false,
      specRelPath: 'Docs/PRODUCT_SPEC.md',
      specMode: 'brownfield',
      ...overrides,
    },
  };
}

test('SPEC: written + a create -> deterministic Group-B create JSON, not blocked', async () => {
  const task = baseTask();
  const claudeCall = async () => ({
    response: '# PromptForge Product Spec\n\n## API\n\nPOST /api/generate accepts ...\n\nSPEC: written',
    degenerate: null,
  });
  const result = await draftProductSpecImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, cloneRepo: () => '/tmp/fake-clone' });

  assert.equal(result.succeeded, true);
  assert.equal(result.blocked, false);
  const change = JSON.parse(task.implementResponse);
  assert.deepEqual(change, { mode: 'create', file: 'Docs/PRODUCT_SPEC.md', content: '# PromptForge Product Spec\n\n## API\n\nPOST /api/generate accepts ...' });
  assert.equal(task.implementResponse.includes('SPEC:'), false, 'the sentinel line must be stripped from the stored doc');
  assert.equal(task.productSpecDoc.startsWith('# PromptForge'), true);
});

test('SPEC: written with an existing spec -> full-document edit JSON (find = whole current doc)', async () => {
  const task = baseTask({ currentSpec: '# Old Spec\n\nstale content\n', specExists: true });
  const claudeCall = async () => ({ response: '# New Spec\n\nfresh content\n\nSPEC: written', degenerate: null });
  await draftProductSpecImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, cloneRepo: () => '/tmp/fake-clone' });

  const change = JSON.parse(task.implementResponse);
  assert.equal(change.mode, 'edit');
  assert.equal(change.file, 'Docs/PRODUCT_SPEC.md');
  assert.equal(change.find, '# Old Spec\n\nstale content\n', 'find must be the exact current doc bytes for a clean rollback');
  assert.equal(change.replace, '# New Spec\n\nfresh content');
});

test('result.degenerate -> blocked (not fabricated)', async () => {
  const task = baseTask();
  const claudeCall = async () => ({ response: '', degenerate: 'empty' });
  const result = await draftProductSpecImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, cloneRepo: () => '/tmp/fake-clone' });

  assert.equal(result.succeeded, true);
  assert.equal(result.blocked, true);
  assert.match(result.blockedReason, /degenerate/);
  assert.equal(task.implementResponse, undefined);
});

test('no SPEC: sentinel -> blocked, doc-so-far surfaced in the reason', async () => {
  const task = baseTask();
  const claudeCall = async () => ({ response: '# A partial spec that never sent the sentinel', degenerate: null });
  const result = await draftProductSpecImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, cloneRepo: () => '/tmp/fake-clone' });

  assert.equal(result.blocked, true);
  assert.match(result.blockedReason, /did not end with a SPEC: line/);
  assert.match(result.blockedReason, /partial spec/);
});

test('SPEC: insufficient-context -> blocked with the explanation', async () => {
  const task = baseTask();
  const claudeCall = async () => ({ response: 'The API layer is generated at build time; I cannot see the real routes.\n\nSPEC: insufficient-context', degenerate: null });
  const result = await draftProductSpecImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, cloneRepo: () => '/tmp/fake-clone' });

  assert.equal(result.blocked, true);
  assert.match(result.blockedReason, /insufficient-context/);
  assert.match(result.blockedReason, /generated at build time/);
});

test('SPEC: written but body is not a markdown doc -> blocked', async () => {
  const task = baseTask();
  const claudeCall = async () => ({ response: 'ok done\n\nSPEC: written', degenerate: null });
  const result = await draftProductSpecImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, cloneRepo: () => '/tmp/fake-clone' });

  assert.equal(result.blocked, true);
  assert.match(result.blockedReason, /no markdown document/);
});

test('clone failure -> infra-style {succeeded:false} (does NOT degrade to a blind path)', async () => {
  const task = baseTask();
  const claudeCall = async () => { throw new Error('should not be called'); };
  const result = await draftProductSpecImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, cloneRepo: () => null });

  assert.equal(result.succeeded, false);
  assert.match(result.reason, /service unavailable/);
});

test('claudeCall throwing -> {succeeded:false, reason}', async () => {
  const task = baseTask();
  const claudeCall = async () => { throw new Error('simulated claude -p failure'); };
  const result = await draftProductSpecImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, cloneRepo: () => '/tmp/fake-clone' });

  assert.equal(result.succeeded, false);
  assert.match(result.reason, /simulated claude -p failure/);
});

test('the Claude call is read-only (Read,Grep,Glob), cwd = clone, no sandbox; clone is cleaned up', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const realCloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-agentic-cleanup-'));
  const task = baseTask();
  let capturedOpts = null;
  const claudeCall = async (opts) => { capturedOpts = opts; return { response: '# Spec\n\nbody\n\nSPEC: written', degenerate: null }; };
  let recordedModel = null;
  const recordModelCall = (r) => { recordedModel = r.model; return 'id'; };

  await draftProductSpecImplement(task, { claudeCall, recordModelCall, cloneRepo: () => realCloneDir });

  assert.equal(capturedOpts.allowedTools, 'Read,Grep,Glob');
  assert.equal(capturedOpts.cwd, realCloneDir);
  assert.equal('sandbox' in capturedOpts, false, 'read-only tool pass must not pass a sandbox key');
  assert.equal(capturedOpts.permissionMode, 'dontAsk');
  assert.equal(recordedModel, 'claude:product-spec-agentic');
  assert.equal(fs.existsSync(realCloneDir), false, 'the clone dir must be removed in the finally block');
});
