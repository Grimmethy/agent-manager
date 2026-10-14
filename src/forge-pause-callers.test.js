'use strict';

// Callers of local-client call()/majorityVote() must not turn a ForgePauseError (the Forge family holds the GPU) into a degraded
// RESULT: a draft that skips its grounding/critique/premise checks gets accepted unchecked, a sweep that stamps "vote-error" writes
// permanent state, a worker that counts the pause as a failure can permanently block a good task. This file pins every site found
// by the 2026-10-14 audit. Each behavioural test has a CONTROL: the same input with an ordinary error must still degrade exactly as
// before (and proves the input really reaches the model call, so the pause case cannot pass vacuously).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ForgePauseError, FORGE_PAUSE_MESSAGE, isForgePause } = require('./gpu-guard.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function counting(err) {
  const fn = async () => { fn.calls += 1; throw err; };
  fn.calls = 0;
  return fn;
}

test('isForgePause recognises the error class, the flag, and the message text after an Error was re-wrapped', () => {
  assert.ok(isForgePause(new ForgePauseError()));
  assert.ok(isForgePause(Object.assign(new Error('x'), { forgePause: true })));
  assert.ok(isForgePause(new Error(FORGE_PAUSE_MESSAGE)), 're-wrapped: majorityVote rethrows new Error(message)');
  assert.ok(!isForgePause(new Error('connect ECONNREFUSED')));
  assert.ok(!isForgePause(null));
});

test('plan-critique: a pause is rethrown (not "no gaps"); an ordinary error still degrades to ok', async () => {
  const { runPlanCritique } = require('./plan-critique.js');
  const task = { source: 'manual', planResponse: 'PLAN\n1. Do the thing.', orientNotes: 'grounding', promptContext: { rawText: 'make it better' } };
  const ordinary = counting(new Error('socket hang up'));
  const ok = await runPlanCritique(task, { call: ordinary });
  assert.equal(ordinary.calls, 1, 'control: the input must reach the model call');
  assert.equal(ok.verdict, 'ok');
  const paused = counting(new ForgePauseError());
  await assert.rejects(runPlanCritique(task, { call: paused }), (e) => isForgePause(e));
  assert.equal(paused.calls, 1);
});

test('deep-dive grounding check: a pause is rethrown (not "grounded"); an ordinary error still degrades to ok', async () => {
  const { runGroundingCheck } = require('./deep-dive-grounding-check.js');
  const task = { source: 'deep_dive', promptContext: { rawText: '', files: [{ path: 'a.js', content: 'function foo() { return 1; }\n' }] } };
  const draft = 'The foo function returns 1 and nothing else.';
  const ordinary = counting(new Error('socket hang up'));
  const ok = await runGroundingCheck(task, draft, { call: ordinary });
  assert.equal(ordinary.calls, 1, 'control: the input must reach the model call');
  assert.equal(ok.verdict, 'ok');
  const paused = counting(new ForgePauseError());
  await assert.rejects(runGroundingCheck(task, draft, { call: paused }), (e) => isForgePause(e));
});

test('candidate premise check: a pause is rethrown (not "premise ok"); an ordinary error still degrades to ok', async () => {
  const { runPremiseCheck } = require('./candidate-premise-check.js');
  const task = {
    source: 'arch_discovery',
    promptContext: { body: 'Problem: the guard in `src/local-client.js` already handles this case.', fetchedFiles: [{ path: 'src/local-client.js', content: 'x' }] },
  };
  const ordinary = counting(new Error('socket hang up'));
  const ok = await runPremiseCheck(task, { call: ordinary });
  assert.equal(ordinary.calls, 1, 'control: the input must reach the model call');
  assert.equal(ok.verdict, 'ok');
  const paused = counting(new ForgePauseError());
  await assert.rejects(runPremiseCheck(task, { call: paused }), (e) => isForgePause(e));
});

// Sites whose enclosing functions are not exported or need a full pipeline fixture: pin the guarded catch directly next to its call.
// (Behaviour of the shared mechanism is covered above and in local-client-forge-pause.test.js.)
const SITES = [
  ['src/local-draft.js', "orient pass errored (non-fatal)", 'orient pass'],
  ['src/local-draft.js', "// AC-170: log the swallowed premiseCheck exception", 'premise check in finalizeCandidateFulfillment'],
  ['src/local-draft.js', "grounding = null; // advisory -- a throwing check must never block a real draft", 'post-implement grounding check'],
  ['src/local-draft.js', "plan-critique errored (non-fatal)", 'plan critique'],
  ['src/auto-confirm-review.js', "// Every vote hard-failed (infra). Do NOT stamp -- next tick retries.", 'auto-confirm review sweep'],
  ['src/needs-clarification-triage.js', "needs-clarification-triage: premise vote could not run", 'nc triage premise vote'],
  ['src/adhoc-staleness-flag.js', "// all votes hard-failed (infra) -- stamp the medium flag anyway so the human sees it", 'staleness sweep'],
];
for (const [file, marker, label] of SITES) {
  test(`${label} (${file}): the catch rethrows/stops on a Forge pause BEFORE it degrades the error`, () => {
    const text = read(file);
    let from = 0;
    let n = 0;
    for (;;) {
      const at = text.indexOf(marker, from);
      if (at === -1) break;
      n += 1;
      const window = text.slice(Math.max(0, at - 700), at);
      assert.match(window, /isForgePause\(e\)/, `${file}: occurrence ${n} of "${marker}" has no isForgePause(e) guard in its catch`);
      from = at + marker.length;
    }
    assert.ok(n >= 1, `marker not found in ${file}: ${marker}`);
  });
}

test('the sweeps stop their loop quietly on a pause (no history note, no stamp): paused flag + break', () => {
  for (const file of ['src/auto-confirm-review.js', 'src/needs-clarification-triage.js', 'src/adhoc-staleness-flag.js']) {
    assert.match(read(file), /if \(isForgePause\(e\)\) \{ summary\.paused = true; break; \}/, file);
  }
});

test('the pause message and the bash patterns in BOTH scripts cannot drift apart, and the pause branch never touches the failure counters', () => {
  const PATTERN = 'the Forge family holds the GPU';
  assert.ok(FORGE_PAUSE_MESSAGE.includes(PATTERN), 'the message must contain the literal the scripts grep for');
  for (const [file, indent, logLine, counterCode] of [
    ['scripts/local-worker.sh', '  ', 'draft paused for a Forge GPU session', 'o.draftFailureCount = (o.draftFailureCount || 0) + 1'],
    ['scripts/review-runner.sh', '    ', 'review paused for a Forge GPU session', 'o.reviewFailureCount = (o.reviewFailureCount || 0) + 1'],
  ]) {
    const text = read(file);
    const start = text.indexOf(`${indent}elif grep -qE "${PATTERN}"`);
    assert.ok(start !== -1, `${file}: pause branch missing, or its pattern drifted from "${PATTERN}"`);
    const end = text.indexOf(`\n${indent}else\n`, start);
    assert.ok(end !== -1, `${file}: could not find the end of the pause branch`);
    const code = text.slice(start, end).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');   // drop comment lines
    assert.ok(code.includes(logLine), `${file}: pause branch log line missing`);
    assert.ok(!/FailureCount|infraRequeue|InfraRequeue|mv -n|blocked/.test(code), `${file}: the pause branch must not count, requeue, move or block: ${code}`);
    const counter = text.indexOf(counterCode);
    assert.ok(counter !== -1, `${file}: counter code not found (test needs updating)`);
    assert.ok(start < counter, `${file}: the pause branch must precede the failure-counting code`);
  }
});
