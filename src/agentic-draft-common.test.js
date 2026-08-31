'use strict';

// Tests for the provider-agnostic agentic-draft helpers extracted from the (deleted)
// adhoc-agentic-draft.js -- the parse helpers and resolveAgenticDraft's verdict mapping.
// Worktree git operations are exercised via a real throwaway repo, same fixture shape
// group-b-worktree-diff.test.js uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  parseSubTaskProposals, parseClarificationOptions, priorRejectionBlock,
  RESOLUTION_RE, resolveAgenticDraft,
} = require('./agentic-draft-common.js');

test('parseSubTaskProposals pulls a 2+ {title,rawText} array out of surrounding prose', () => {
  const text = 'here is the split:\n[{"title":"a","rawText":"do a"},{"title":"b","rawText":"do b"}]\nthat is why';
  assert.deepEqual(parseSubTaskProposals(text), [
    { title: 'a', rawText: 'do a' }, { title: 'b', rawText: 'do b' },
  ]);
});

test('parseSubTaskProposals drops malformed entries but keeps the batch, returns null below 1', () => {
  assert.deepEqual(parseSubTaskProposals('[{"title":"a","rawText":"x"},{"title":"","rawText":"y"}]'), [{ title: 'a', rawText: 'x' }]);
  assert.equal(parseSubTaskProposals('[{"title":"","rawText":""}]'), null);
  assert.equal(parseSubTaskProposals('no array here'), null);
  assert.equal(parseSubTaskProposals('[not json]'), null);
});

test('parseClarificationOptions needs an OPTIONS: header + 2 well-formed lines', () => {
  const text = 'the question is X\nOPTIONS:\n1. Redis :: use a redis instance\n2. In-memory :: keep it in the process\n';
  assert.deepEqual(parseClarificationOptions(text), [
    { label: 'Redis', description: 'use a redis instance' },
    { label: 'In-memory', description: 'keep it in the process' },
  ]);
  assert.equal(parseClarificationOptions('OPTIONS:\n1. only one :: not enough'), null);
  assert.equal(parseClarificationOptions('no header'), null);
});

test('priorRejectionBlock renders feedback, empty string for none', () => {
  assert.equal(priorRejectionBlock({}), '');
  assert.match(priorRejectionBlock({ priorRejectionFeedback: ['too vague', 'wrong file'] }), /attempted 2 time\(s\)[\s\S]*1\. too vague[\s\S]*2\. wrong file/);
});

test('RESOLUTION_RE recognises all four verbs, case-insensitively', () => {
  for (const v of ['implemented', 'no-changes-needed', 'decompose', 'needs-human-decision']) {
    assert.equal(('RESOLUTION: ' + v).match(RESOLUTION_RE)[1].toLowerCase(), v);
  }
  assert.equal('RESOLUTION: something-else'.match(RESOLUTION_RE), null);
});

// --- resolveAgenticDraft against a real worktree -----------------------------------

function withRealRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-common-test-'));
  const wt = path.join(dir, 'wt');
  const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  fs.mkdirSync(wt);
  g(['init', '-q'], wt);
  g(['config', 'user.email', 't@t'], wt); g(['config', 'user.name', 't'], wt);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'original\n');
  g(['add', '-A'], wt); g(['commit', '-qm', 'init'], wt);
  try { return fn(wt); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('resolveAgenticDraft(implemented): stages + captures the worktree diff into task.rawDiff', () => {
  withRealRepo((wt) => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(wt, 'new.txt'), 'brand new\n');
    const task = { id: 't1' };
    const out = resolveAgenticDraft(task, {
      result: { response: 'did stuff\n\nRESOLUTION: implemented\n\nsummary here' },
      worktreeDir: wt, modelLabel: 'qwen-test',
    });
    assert.equal(out.succeeded, true);
    assert.equal(out.blocked, false);
    assert.equal(out.resolution, 'implemented'); // now surfaced for draft-attempt-record.js
    assert.equal(task.adhocResolution, 'implemented');
    assert.equal(task.draftModel, 'qwen-test');
    assert.match(task.rawDiff, /a\.txt/);
    assert.match(task.rawDiff, /new\.txt/);
    assert.match(task.implementResponse, /=== DIFF ===/);
  });
});

test('resolveAgenticDraft(decompose): sets subTaskProposals, no diff', () => {
  withRealRepo((wt) => {
    const task = { id: 't2' };
    const out = resolveAgenticDraft(task, {
      result: { response: 'RESOLUTION: decompose\n[{"title":"p1","rawText":"first"},{"title":"p2","rawText":"second"}]\nsplit because big' },
      worktreeDir: wt,
    });
    assert.equal(out.succeeded, true);
    assert.equal(out.blocked, false);
    assert.equal(task.subTaskProposals.length, 2);
    assert.equal(task.rawDiff, '');
  });
});

test('resolveAgenticDraft(needs-human-decision): needsClarification, no diff', () => {
  withRealRepo((wt) => {
    const task = { id: 't3' };
    const out = resolveAgenticDraft(task, {
      result: { response: 'RESOLUTION: needs-human-decision\nWhich DB?' },
      worktreeDir: wt,
    });
    assert.equal(out.succeeded, true);
    assert.equal(out.blocked, false);
    assert.equal(out.needsClarification, true);
    assert.equal(task.adhocResolution, 'needs-human-decision');
  });
});

test('resolveAgenticDraft: no RESOLUTION line -> blocked (terminal, not an infra failure)', () => {
  withRealRepo((wt) => {
    const out = resolveAgenticDraft({ id: 't4' }, { result: { response: 'I looked around but never concluded' }, worktreeDir: wt });
    assert.equal(out.succeeded, true);
    assert.equal(out.blocked, true);
    assert.match(out.blockedReason, /did not end with a RESOLUTION/);
  });
});

test('resolveAgenticDraft: degenerate result -> blocked', () => {
  withRealRepo((wt) => {
    const out = resolveAgenticDraft({ id: 't5' }, { result: { degenerate: 'repetition-loop' }, worktreeDir: wt });
    assert.equal(out.blocked, true);
    assert.match(out.blockedReason, /degenerate: repetition-loop/);
  });
});
