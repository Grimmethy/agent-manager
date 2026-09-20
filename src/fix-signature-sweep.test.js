'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sweepKnownFixedFailures, stuckSince, STATE_FILE } = require('./fix-signature-sweep.js');
const { KNOWN_FIXED } = require('./known-fixed-failures.js');

const byId = Object.fromEntries(KNOWN_FIXED.map((e) => [e.id, e]));
const WRONG_BLOCK = 'Your previous "find" string for src/components/PropertyDetailPanel.tsx matches the file -- but a DIFFERENT block than the one this candidate flagged. The flagged code is: ...';
const FIND_MISSING = 'Your previous attempt proposed this "find" string for src/components/PropertyDetailPanel.tsx, but it does not appear verbatim anywhere in that file\'s real content given above:\n\nfoo\n\nLook again at the R';
const META = 'Deterministic gate: implementResponse is a bare tool-call request or meta-commentary, not a real implementation attempt -- no local-model review call spent';
const CURLY = { path: 'src/P.tsx', content: 'Mark it as “Owner” — soon' };
const PLAIN = { path: 'src/P.tsx', content: 'Mark it as "Owner" - soon' };

function pipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixsig-'));
  for (const s of ['blocked', 'needs-clarification', 'pending', 'adhoc', 'derived']) fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  return dir;
}
const put = (dir, state, task) => fs.writeFileSync(path.join(dir, 'queue', state, `${task.id}.json`), JSON.stringify(task, null, 2));
const read = (dir, state, id) => JSON.parse(fs.readFileSync(path.join(dir, 'queue', state, `${id}.json`), 'utf8'));
const has = (dir, state, id) => fs.existsSync(path.join(dir, 'queue', state, `${id}.json`));
const at = (iso) => ({ stage: 'blocked', at: iso, detail: 'x' });
const stuck = (id, over = {}) => ({
  id, domain: 'default', source: 'function_length_fix', title: 'AC-3', status: 'pending', createdAt: '2026-09-20T01:00:00Z',
  promptContext: { candidateId: 'AC-3', fetchedFiles: [CURLY] }, priorRejectionFeedback: [WRONG_BLOCK], history: [at('2026-09-20T05:00:00Z')], ...over,
});
const NOW = new Date('2026-09-20T07:00:00Z');

test('each entry matches exactly its own failure class', () => {
  assert.equal(byId['wrong-block-whole-function-snippet'].applies(stuck('a')), true);
  assert.equal(byId['wrong-block-whole-function-snippet'].applies(stuck('a', { priorRejectionFeedback: [FIND_MISSING] })), false);
  assert.equal(byId['typographic-find-mismatch'].applies(stuck('b', { priorRejectionFeedback: [FIND_MISSING] })), true);
  assert.equal(byId['typographic-find-mismatch'].applies(stuck('b', { priorRejectionFeedback: [FIND_MISSING], promptContext: { fetchedFiles: [PLAIN] } })), false, 'the file has no typographic characters: a real mismatch, not the fixed class');
  assert.equal(byId['revision-commentary-replaced-draft'].applies(stuck('c', { priorRejectionFeedback: [META] })), true);
  assert.equal(byId['revision-commentary-replaced-draft'].applies(stuck('c', { priorRejectionFeedback: [], blockedReason: 'The "IMPLEMENT draft" section consists entirely of meta-commentary analyzing a prior critique' })), true);
  assert.equal(byId['revision-commentary-replaced-draft'].applies(stuck('c', { priorRejectionFeedback: ['some unrelated rejection'] })), false);
});

test('first sight of an entry: a task that failed BEFORE it is requeued to pending/ with its coordination fields kept and a history event', () => {
  const dir = pipeline();
  put(dir, 'needs-clarification', stuck('function-length-fix-ac-3', {
    needsClarification: { reason: 'design-decision' }, history: [at('2026-09-20T05:00:00Z'), { stage: 'exhausted', at: '2026-09-20T05:39:46Z' }],
    stacked: { branch: 'agent/x', seq: 2, total: 3 }, dependsOn: ['p1'], atomic: true, premiumPriority: true, planResponse: 'stale', implementResponse: 'stale', blockedReason: 'stale',
  }));
  const s = sweepKnownFixedFailures({ pipelineDir: dir, now: NOW });
  assert.deepEqual(s.requeued, [{ id: 'function-length-fix-ac-3', entry: 'wrong-block-whole-function-snippet', from: 'needs-clarification' }]);
  assert.equal(has(dir, 'needs-clarification', 'function-length-fix-ac-3'), false);
  const fresh = read(dir, 'pending', 'function-length-fix-ac-3');
  assert.equal(fresh.status, 'pending');
  assert.deepEqual(fresh.stacked, { branch: 'agent/x', seq: 2, total: 3 });
  assert.deepEqual(fresh.dependsOn, ['p1']);
  assert.equal(fresh.atomic, true);
  assert.equal(fresh.premiumPriority, true);
  assert.equal(fresh.planResponse, undefined, 'drafting artifacts are dropped');
  assert.equal(fresh.blockedReason, undefined);
  assert.equal(fresh.needsClarification, undefined);
  assert.deepEqual(fresh.requeuedForFixes, ['wrong-block-whole-function-snippet']);
  assert.equal(fresh.history.at(-1).stage, 'requeued');
  assert.match(fresh.history.at(-1).detail, /fix for "wrong-block-whole-function-snippet" landed \(agent-manager #394\)/);
  assert.ok(fresh.history.some((h) => h.stage === 'exhausted'), 'the log is appended to, never replaced');
});

test('a task that failed AFTER the sweep first saw the entry is NOT requeued (the fix did not cure it), and a requeued task is never requeued twice', () => {
  const dir = pipeline();
  put(dir, 'blocked', stuck('early', { history: [at('2026-09-20T05:00:00Z')] }));
  assert.equal(sweepKnownFixedFailures({ pipelineDir: dir, now: NOW }).requeued.length, 1, 'first run stamps firstSeen = NOW and drains the earlier failure');
  put(dir, 'blocked', stuck('late', { history: [at('2026-09-20T09:00:00Z')] }));    // failed at 09:00, after firstSeen 07:00
  const later = sweepKnownFixedFailures({ pipelineDir: dir, now: new Date('2026-09-20T10:00:00Z') });
  assert.deepEqual(later.requeued, []);
  assert.equal(has(dir, 'blocked', 'late'), true);
  // and one that was already requeued for this fix and failed again before firstSeen is still skipped
  put(dir, 'blocked', stuck('again', { history: [at('2026-09-20T05:00:00Z')], requeuedForFixes: ['wrong-block-whole-function-snippet'] }));
  assert.deepEqual(sweepKnownFixedFailures({ pipelineDir: dir, now: new Date('2026-09-20T11:00:00Z') }).requeued, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'queue', STATE_FILE), 'utf8')).firstSeen['wrong-block-whole-function-snippet'], NOW.toISOString());
});

test('adhoc-shaped tasks go back to the lane that claims them; derived tasks to derived/', () => {
  const dir = pipeline();
  put(dir, 'blocked', stuck('adhoc-x', { domain: 'adhoc', source: 'manual' }));
  put(dir, 'blocked', stuck('derived-x', { domain: 'adhoc', source: 'derived_task' }));
  put(dir, 'blocked', stuck('plain-x'));
  sweepKnownFixedFailures({ pipelineDir: dir, now: NOW });
  assert.equal(has(dir, 'adhoc', 'adhoc-x'), true);
  assert.equal(has(dir, 'derived', 'derived-x'), true);
  assert.equal(has(dir, 'pending', 'plain-x'), true);
});

test('never requeued: an applied task (real branch), a genuine design question, a reviewInconclusive flake, a non-matching task, or one with a pending copy', () => {
  const dir = pipeline();
  put(dir, 'blocked', stuck('applied-one', { history: [at('2026-09-20T05:00:00Z'), { stage: 'applied', at: '2026-09-20T04:00:00Z', detail: 'agent/x' }] }));
  put(dir, 'needs-clarification', stuck('real-question', { needsClarification: { reason: 'design-decision' }, history: [at('2026-09-20T05:00:00Z')] })); // no 'exhausted'
  put(dir, 'blocked', stuck('flake', { reviewInconclusive: true }));
  put(dir, 'blocked', stuck('unrelated', { priorRejectionFeedback: ['something else entirely'] }));
  put(dir, 'blocked', stuck('dupe'));
  put(dir, 'pending', { id: 'dupe', status: 'pending' });
  const s = sweepKnownFixedFailures({ pipelineDir: dir, now: NOW });
  assert.deepEqual(s.requeued, []);
  for (const id of ['applied-one', 'flake', 'unrelated', 'dupe']) assert.equal(has(dir, 'blocked', id), true, id);
  assert.equal(has(dir, 'needs-clarification', 'real-question'), true);
});

test('dry run and the kill switch move nothing', () => {
  const dir = pipeline();
  put(dir, 'blocked', stuck('t'));
  const dry = sweepKnownFixedFailures({ pipelineDir: dir, now: NOW, dryRun: true });
  assert.equal(dry.requeued.length, 1);
  assert.equal(has(dir, 'blocked', 't'), true);
  assert.equal(fs.existsSync(path.join(dir, 'queue', STATE_FILE)), false, 'a dry run does not even record firstSeen');
  process.env.AGENT_MANAGER_FIX_SIGNATURE_SWEEP = 'false';
  try {
    assert.deepEqual(sweepKnownFixedFailures({ pipelineDir: dir, now: NOW }).requeued, []);
  } finally { delete process.env.AGENT_MANAGER_FIX_SIGNATURE_SWEEP; }
  assert.equal(has(dir, 'blocked', 't'), true);
});

test('stuckSince uses the newest blocked/needs-clarification/exhausted event, else the file mtime', () => {
  const dir = pipeline();
  assert.equal(stuckSince({ history: [at('2026-09-20T05:00:00Z'), { stage: 'exhausted', at: '2026-09-20T06:00:00Z' }, { stage: 'draft-started', at: '2026-09-20T09:00:00Z' }] }, '/nope'), Date.parse('2026-09-20T06:00:00Z'));
  const f = path.join(dir, 'queue', 'blocked', 'x.json'); fs.writeFileSync(f, '{}');
  assert.ok(Math.abs(stuckSince({ history: [] }, f) - Date.now()) < 60000);
});
