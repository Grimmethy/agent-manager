'use strict';

// Tests for src/policy-change.js (classification + routing), the 'policy-change' blocked-task classifier, the escalation through the real reject-retry sweep, and
// scripts/policy-change-report.js. The review-task wiring is tested in review-task.test.js.
//
// Run: node --test src/policy-change.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pc = require('./policy-change.js');
const { classifyBlockedTask, findClassifier } = require('./blocked-task-classifiers.js');
const { rejectRetryCheck } = require('./reject-retry-check.js');
const { readReport } = require('../scripts/policy-change-report.js');

function diffOf(file, added, removed = []) {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${Math.max(removed.length, 1)} +1,${Math.max(added.length, 1)} @@\n${removed.map((l) => `-${l}`).join('\n')}${removed.length ? '\n' : ''}${added.map((l) => `+${l}`).join('\n')}\n`;
}

// Shapes of today's misfires (2026-10-01), one per kind -- each must classify as policy.
const POSITIVES = [
  ['gate', 'src/draft-quality-gate.js', ['function checkDraftQuality(text) {', '  return { pass: false, violations: [{ type: "meta-commentary" }] };', '}']],
  ['threshold', 'src/single-flight-lock.js', ['const DISCUSS_PRIORITY_SAFETY_VALVE_MS = 900000;']],
  ['retry', 'src/review-task.js', ['    task.reviewInconclusive = true;']],
  ['timing', 'src/single-flight-lock.js', ['    sleepMs(1000);']],
  ['selection', 'src/forensic-bundle.js', ['  let pool = candidates.filter((c) => c.score > 0);']],
  ['prompt', 'src/prompts.js', ["    'HARD RULE: you MUST NOT name, reference, create, or import any file path that does not appear verbatim in the list.',"]],
  ['skip', 'src/staleness-audit.js', ['  if (!titleHasFileLineRef(task.title)) return null;']],
  ['gate', 'src/arch-import-fetch.js', ["  throw new Error('[arch-import-fetch] AGENT_MANAGER_GREP_DIRS resolved to zero existing directories');"]],
];

test('classifyPolicyChange: each shape of a pipeline-behaviour change is policy, with the kind and the evidence line', () => {
  for (const [kind, file, added] of POSITIVES) {
    const c = pc.classifyPolicyChange({ rawDiff: diffOf(file, added) });
    assert.equal(c.policy, true, `${kind} in ${file}`);
    assert.ok(c.kinds.includes(kind), `${file}: wanted ${kind}, got ${c.kinds}`);
    assert.equal(c.signals[0].file, file);
    assert.ok(c.signals[0].text.length > 0);
  }
});

test('classifyPolicyChange: docs, tests, dashboard code, plain application code and comment-only changes are not policy', () => {
  const gateLine = ['  return { pass: false, violations: [] };'];
  assert.equal(pc.classifyPolicyChange({ rawDiff: diffOf('docs/notes.md', ['blockedReason is documented here']) }).policy, false, 'docs');
  assert.equal(pc.classifyPolicyChange({ rawDiff: diffOf('src/draft-quality-gate.test.js', gateLine) }).policy, false, 'a test file');
  assert.equal(pc.classifyPolicyChange({ rawDiff: diffOf('test/draft-quality-gate.test.js', gateLine) }).policy, false, 'a test dir');
  assert.equal(pc.classifyPolicyChange({ rawDiff: diffOf('python/dashboard/static/js/queue-tab.js', ['const MAX_ROWS = 50;', 'if (x) return null;']) }).policy, false, 'dashboard JS');
  assert.equal(pc.classifyPolicyChange({ rawDiff: diffOf('python/dashboard/app.py', ['    blockedReason = "x"']) }).policy, false, 'python');
  assert.equal(pc.classifyPolicyChange({ rawDiff: diffOf('src/config.js', ['  console.log("hello");', '  const total = a + b;']) }).policy, false, 'ordinary code');
  assert.equal(pc.classifyPolicyChange({ rawDiff: diffOf('src/review-task.js', ['// blockedReason: explain why', '  // return { pass: false }']) }).policy, false, 'comments only');
  assert.equal(pc.classifyPolicyChange({ rawDiff: '' }).policy, false);
  assert.equal(pc.classifyPolicyChange({}).policy, false);
  assert.equal(pc.classifyPolicyChange({ rawDiff: null, text: 'add a gate' }).policy, false, 'the request text alone never makes a policy change');
  assert.equal(pc.classifyPolicyChange({ rawDiff: null, text: 'add a gate' }).hint, true, 'but it is recorded as a hint');
});

test('classifyPolicyChange: a pure move or an extraction is exempt, a refactor title never exempts a diff that mostly adds new logic', () => {
  const body = Array.from({ length: 16 }, (_, i) => `  if (x${i}) { blockedReason = "r${i}"; }`);
  const move = diffOf('src/new-home.js', body) + diffOf('src/local-draft.js', [], body);
  const m = pc.classifyPolicyChange({ rawDiff: move });
  assert.equal(m.policy, false);
  assert.equal(m.pureMove, true);
  // an extraction re-wraps lines (signature, call), so a titled refactor with balanced add/remove is exempt
  const added = ['function helper(a) {', ...body.map((l) => l.replace('x', 'y')), '}', '  return helper(a);'];
  const refactor = diffOf('src/local-draft.js', added, body);
  assert.equal(pc.classifyPolicyChange({ rawDiff: refactor }).policy, true, 'without the title it looks like new gate logic');
  assert.equal(pc.classifyPolicyChange({ rawDiff: refactor, title: 'HUB0094 2/2 - Extract helper from draftTask' }).pureMove, true, 'a refactor title with balanced add/remove is exempt');
  const grows = diffOf('src/local-draft.js', body, []);
  assert.equal(pc.classifyPolicyChange({ rawDiff: grows, title: 'Extract helper' }).policy, true, 'a refactor title does not exempt a diff that only ADDS logic');
});

test('decidePolicyRouting: none / decided / replay-settled / escalate', () => {
  const policy = { policy: true, kinds: ['timing'], signals: [] };
  assert.equal(pc.decidePolicyRouting({ classification: { policy: false } }).route, 'none');
  assert.equal(pc.decidePolicyRouting({ classification: { policy: false, pureMove: true } }).route, 'none');
  assert.equal(pc.decidePolicyRouting({ classification: policy, gateReplay: null, task: {} }).route, 'escalate');
  assert.equal(pc.decidePolicyRouting({ classification: policy, gateReplay: { candidates: [] }, task: {} }).route, 'escalate');
  const settled = { candidates: [{ blocking: true, mergedTotal: 335 }] };
  assert.equal(pc.decidePolicyRouting({ classification: policy, gateReplay: settled, task: {} }).route, 'replay-settled');
  assert.equal(pc.decidePolicyRouting({ classification: policy, gateReplay: { candidates: [{ blocking: true, mergedTotal: 5 }] }, task: {} }).route, 'escalate', 'a corpus under 20 merged tasks settles nothing');
  assert.equal(pc.decidePolicyRouting({ classification: policy, gateReplay: { candidates: [{ blocking: false, mergedTotal: 400 }] }, task: {} }).route, 'escalate', 'a reported-only family settles nothing');
  const decided = { promptContext: { rawText: 'do X\n\nHUMAN DESIGN DECISION (answered directly from the Needs Clarification picker, 2026-10-01T00:00:00Z):\nship it with a lower limit' } };
  assert.equal(pc.decidePolicyRouting({ classification: policy, gateReplay: null, task: decided }).route, 'decided', 'a human answer is never asked for twice');
  assert.equal(pc.hasHumanDecision({ promptContext: { rawText: 'we need a HUMAN DESIGN DECISION here' } }), false, 'the bare phrase is not an answer');
});

test('buildPolicyBrief gives the kinds, the evidence, the replay status and the three options', () => {
  const c = pc.classifyPolicyChange({ rawDiff: diffOf('src/single-flight-lock.js', ['const DISCUSS_PRIORITY_SAFETY_VALVE_MS = 900000;']) });
  const brief = pc.buildPolicyBrief({ classification: c, gateReplay: { candidates: [], skipped: [{ name: 'checkOdd', reason: 'no corpus for the signature (checkOdd(task))' }] }, taskTitle: 'Raise the backoff ceiling' });
  assert.match(brief, /alters how the pipeline itself behaves \(threshold\)/);
  assert.match(brief, /src\/single-flight-lock\.js:1 \(threshold\)/);
  assert.match(brief, /Replay: not possible for checkOdd/);
  assert.match(brief, /\(1\) ship it as drafted; \(2\) ship it with constraints/);
  assert.match(pc.buildPolicyBrief({ classification: c, gateReplay: { candidates: [], skipped: [] } }), /no gate, guard or detector that can be replayed/);
});

test('the policy-change blocked-task classifier is non-retryable, design-side, and asks the stored brief', () => {
  const task = { blockedReason: 'Policy change: timing -- policy-affecting and no replay can settle it. Escalated to a human instead of a vote.', policyChange: { brief: 'THE BRIEF' } };
  const c = classifyBlockedTask(task);
  assert.equal(c.category, 'policy-change');
  assert.equal(c.retryable, false);
  assert.equal(c.faultSide, 'design');
  assert.equal(findClassifier(c.classifierName).buildQuestion(task), 'THE BRIEF');
  assert.match(findClassifier(c.classifierName).buildQuestion({ blockedReason: 'Policy change: gate -- x' }), /ship it as drafted, ship it with constraints/);
  assert.notEqual(classifyBlockedTask({ blockedReason: 'review noted the policy change: it is fine' }).category, 'policy-change', 'only the exact prefix counts');
});

test('a policy-change block is escalated to needs-clarification by the real reject-retry sweep, with the brief as the question', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-rrc-'));
  const d = { blockedDir: path.join(root, 'queue', 'blocked'), pendingDir: path.join(root, 'queue', 'pending'), adhocDir: path.join(root, 'queue', 'adhoc'), needsClarificationDir: path.join(root, 'queue', 'needs-clarification') };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  const task = { id: 'p1', domain: 'adhoc', source: 'manual', title: 't', status: 'blocked', blockedStage: 'review', localRejectCount: 0, history: [],
    blockedReason: 'Policy change: timing -- policy-affecting and no replay can settle it. Escalated to a human instead of a vote.', policyChange: { policy: true, kinds: ['timing'], route: 'escalate', brief: 'BRIEF TEXT' } };
  fs.writeFileSync(path.join(d.blockedDir, 'p1.json'), JSON.stringify(task));
  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });
  assert.equal(summary.requeued, 0, 'a redraft cannot decide whether the behaviour ships');
  assert.ok(!fs.existsSync(path.join(d.blockedDir, 'p1.json')));
  const out = JSON.parse(fs.readFileSync(path.join(d.needsClarificationDir, 'p1.json'), 'utf8'));
  assert.equal(out.needsClarification.reason, 'policy-change');
  assert.equal(out.needsClarification.openQuestions, 'BRIEF TEXT');
  assert.ok(out.history.some((h) => h.stage === 'needs-clarification' && /policy-change/.test(h.detail || '')));
});

test('policy-change-report counts reviewed drafts by route and kind and flags a rate above 15%', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-report-'));
  const mk = (dir, id, policyChange) => { fs.mkdirSync(path.join(root, 'queue', dir), { recursive: true }); fs.writeFileSync(path.join(root, 'queue', dir, `${id}.json`), JSON.stringify({ id, policyChange })); };
  mk('done', 'a', { policy: false, kinds: [], route: 'none' });
  mk('done', 'b', { policy: false, kinds: [], route: 'none' });
  mk('done', 'c', { policy: true, kinds: ['gate'], route: 'replay-settled' });
  mk('blocked', 'd', { policy: true, kinds: ['timing', 'threshold'], route: 'escalate' });
  mk('done', 'e', { policy: true, kinds: ['prompt'], route: 'decided' });
  fs.mkdirSync(path.join(root, 'queue', 'done'), { recursive: true });
  fs.writeFileSync(path.join(root, 'queue', 'done', 'no-stamp.json'), JSON.stringify({ id: 'x' }));
  const r = readReport(root);
  assert.equal(r.reviewed, 5);
  assert.equal(r.policy, 3);
  assert.deepEqual(r.byRoute, { 'replay-settled': 1, escalate: 1, decided: 1 });
  assert.deepEqual(r.byKind, { gate: 1, timing: 1, threshold: 1, prompt: 1 });
  assert.ok(Math.abs(r.escalateRate - 0.2) < 1e-9);
  assert.ok(r.escalateRate > 0.15);
  assert.equal(r.escalated[0].id, 'd');
  assert.equal(readReport(path.join(root, 'nope')).reviewed, 0);
});
